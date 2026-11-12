import { ImapClient, type FetchMessageObject, type SearchObject } from './native/client';
import { MimeParseError, parseHeaders, parseMail, type ParsedMail } from './native/mime';
import type {
  ICredentialTestFunction, IDataObject, IExecuteFunctions, ILoadOptionsFunctions,
  INodeExecutionData, INodePropertyOptions, ITriggerFunctions,
} from 'n8n-workflow';

type MailContext = IExecuteFunctions | ITriggerFunctions;
export interface ReadOptions {
  headersOnly: boolean;
  downloadAttachments: boolean;
  maxMessageSizeMB: number;
  onParseError?: 'throw' | 'metadata';
  receivedSince?: number;
}

export function createClient(credentials: IDataObject): ImapClient {
  const user = String(credentials.user ?? '').trim();
  const pass = String(credentials.password ?? '').trim();
  if (!user || !pass) throw new Error('Enter your iCloud IMAP username and app-specific password.');
  const client = new ImapClient({
    host: 'imap.mail.me.com', port: 993, secure: true,
    auth: { user, pass }, tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    logger: false, connectionTimeout: 30_000, greetingTimeout: 15_000,
    socketTimeout: 300_000, maxIdleTime: 240_000, autoIdleDelay: 1_000,
  });
  // The caller observes command failures; never leave EventEmitter errors unhandled.
  client.on('error', () => {});
  return client;
}

export async function disconnect(client: ImapClient): Promise<void> {
  try { if (client.usable) await client.logout(); }
  catch { /* Always close the socket, even when LOGOUT fails. */ }
  finally { client.close(); }
}

export const credentialTest: ICredentialTestFunction = async function (credential) {
  let client: ImapClient | undefined;
  try {
    client = createClient(credential.data as IDataObject);
    await client.connect();
    return { status: 'OK', message: 'Connected to iCloud Mail over verified TLS.' };
  } catch {
    return { status: 'Error', message: 'Could not connect to iCloud IMAP. Check your username, app-specific password and outbound TCP port 993.' };
  } finally { if (client) await disconnect(client); }
};

export async function getMailboxes(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const client = createClient(await this.getCredentials('iCloudMailImap'));
  try {
    await client.connect();
    return (await client.list()).filter((box) => !box.flags.has('\\Noselect'))
      .map((box) => ({ name: box.path, value: box.path }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally { await disconnect(client); }
}

export function parseUid(value: unknown): number {
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(text) || Number(text) > 4_294_967_295) {
    throw new Error('UID must be one positive integer from 1 to 4294967295, not a message ID, sequence number or range.');
  }
  return Number(text);
}

export function assertUidValidity(actual: bigint | string, expected: unknown): void {
  const text = String(expected ?? '').trim();
  if (!/^[1-9]\d*$/.test(text) || String(actual) !== text) {
    throw new Error('UIDVALIDITY does not match this mailbox. Read the message again and pass its current uidValidity before moving it.');
  }
}

export function buildSearch(filters: IDataObject): SearchObject {
  const query: SearchObject = { deleted: false };
  if (filters.unreadOnly) query.seen = false;
  for (const key of ['from', 'to', 'subject', 'text'] as const) {
    if (filters[key]) query[key] = String(filters[key]);
  }
  for (const key of ['since', 'before'] as const) {
    if (filters[key]) {
      const date = new Date(String(filters[key]));
      if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${key} date.`);
      query[key] = date;
    }
  }
  return query;
}

export function selectedMailbox(client: ImapClient) {
  if (!client.mailbox) throw new Error('No IMAP mailbox selected.');
  return client.mailbox;
}

const asJson = (value: unknown): IDataObject => JSON.parse(JSON.stringify(value)) as IDataObject;

export async function readMessage(
  context: MailContext, client: ImapClient, uid: number, options: ReadOptions,
): Promise<INodeExecutionData | undefined> {
  const box = selectedMailbox(client);
  const meta = await client.fetchOne(uid, {
    uid: true, flags: true, envelope: true, size: true, internalDate: true,
  }, { uid: true });
  if (!meta) return undefined; // Expunged by another mail client during the scan.
  if (options.receivedSince !== undefined) {
    const received = meta.internalDate?.getTime();
    if (received === undefined || !Number.isFinite(received)) throw new Error('IMAP INTERNALDATE is required for date-based catch-up.');
    if (received < options.receivedSince) return undefined;
  }
  const envelope = meta.envelope;
  const json: IDataObject = asJson({
    uid: meta.uid, uidValidity: String(box.uidValidity), mailbox: box.path,
    messageKey: `${box.path}:${box.uidValidity}:${meta.uid}`,
    messageId: envelope?.messageId ?? '', subject: envelope?.subject ?? '',
    from: envelope?.from ?? [], to: envelope?.to ?? [], cc: envelope?.cc ?? [],
    date: envelope?.date ?? null, internalDate: meta.internalDate ?? null,
    flags: [...(meta.flags ?? [])], size: meta.size ?? 0,
  });
  const output: INodeExecutionData = { json };
  const maxBytes = Math.floor(options.maxMessageSizeMB * 1024 * 1024);
  if (options.headersOnly || (meta.size ?? 0) > maxBytes) {
    const headerMessage = await client.fetchOne(uid, { headers: { maxLength: 1024 * 1024 + 5 } }, { uid: true });
    if (!headerMessage) return undefined;
    if (!headerMessage.headers) throw new Error('IMAP header response is missing.');
    try { json.headers = parseHeaders(headerMessage.headers); }
    catch (error) {
      if (options.onParseError !== 'metadata' || !(error instanceof MimeParseError)) throw error;
      json.bodySkipped = true;
      json.bodySkippedReason = 'Header parsing failed; metadata only. The original message remains in its mailbox.';
      json.parseError = { code: error.code, message: error.message };
      return output;
    }
    if (!options.headersOnly) {
      json.bodySkipped = true;
      json.bodySkippedReason = `Message exceeds the ${options.maxMessageSizeMB} MB download limit; headers and metadata only.`;
    }
    return output;
  }
  // Bound the literal even if a server reports an incorrect RFC822.SIZE.
  const full: FetchMessageObject | false | undefined = await client.fetchOne(uid, {
    source: { maxLength: maxBytes + 1 },
  }, { uid: true });
  if (!full) return undefined;
  if (!full.source) throw new Error('IMAP message source response is missing.');
  let parsed: ParsedMail;
  try {
    json.headers = parseHeaders(full.source);
    if (full.source.length > maxBytes) {
      json.bodySkipped = true;
      json.bodySkippedReason = 'Downloaded message exceeds the configured size limit; headers and metadata only.';
      return output;
    }
    parsed = await parseMail(full.source);
  }
  catch (error) {
    // Only recognized content failures may become a message-local error item.
    // Fetch, protocol, binary-storage and programming errors must still propagate.
    if (options.onParseError !== 'metadata' || !(error instanceof MimeParseError)) throw error;
    json.bodySkipped = true;
    json.bodySkippedReason = 'MIME parsing failed; metadata only. The original message remains in its mailbox.';
    json.parseError = { code: error.code, message: error.message };
    return output;
  }
  if (parsed.subject) json.subject = parsed.subject;
  if (parsed.messageId) json.messageId = parsed.messageId;
  if (parsed.warnings.length) json.mimeWarnings = parsed.warnings;
  json.text = parsed.text ?? '';
  json.html = parsed.html || '';
  json.replyTo = asJson(parsed.replyTo?.value ?? []);
  json.inReplyTo = parsed.inReplyTo ?? '';
  json.references = parsed.references ?? [];
  json.attachments = parsed.attachments.map((attachment) => ({
    filename: attachment.filename ?? '', contentType: attachment.contentType,
    size: attachment.size, contentId: attachment.contentId ?? '',
  }));
  if (options.downloadAttachments && parsed.attachments.length) {
    output.binary = {};
    for (const [index, attachment] of parsed.attachments.entries()) {
      output.binary[`attachment_${index}`] = await context.helpers.prepareBinaryData(
        attachment.content, attachment.filename ?? `attachment_${index}`, attachment.contentType,
      );
    }
  }
  return output;
}

export async function moveMessage(client: ImapClient, uid: number, expected: unknown, destination: string): Promise<IDataObject> {
  const box = selectedMailbox(client);
  assertUidValidity(box.uidValidity, expected);
  const target = destination.trim();
  if (!target) throw new Error('Select a destination mailbox.');
  if (target === box.path || (target.toUpperCase() === 'INBOX' && box.path.toUpperCase() === 'INBOX')) {
    throw new Error('Source and destination mailbox must be different.');
  }
  if (!client.capabilities.has('MOVE') && !client.capabilities.has('UIDPLUS')) {
    throw new Error('This server supports neither MOVE nor UIDPLUS; refusing a move that could expunge unrelated messages.');
  }
  const existing = await client.fetchOne(uid, { uid: true }, { uid: true });
  if (!existing) throw new Error(`Message UID ${uid} no longer exists in ${box.path}.`);
  assertUidValidity(selectedMailbox(client).uidValidity, expected);
  const sourceMailbox = box.path;
  const sourceValidity = String(box.uidValidity);
  // Never retry automatically: a lost response may mean the move already succeeded.
  const moved = await client.messageMove(uid, target, { uid: true });
  if (!moved) throw new Error('The server did not confirm the move. Check both folders before retrying.');
  return {
    success: true, uid, uidValidity: sourceValidity, sourceMailbox, destinationMailbox: target,
    destinationUid: moved.uidMap?.get(uid) ?? null,
    destinationUidValidity: moved.uidValidity ? String(moved.uidValidity) : null,
  };
}
