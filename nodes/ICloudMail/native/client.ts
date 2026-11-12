import { EventEmitter } from 'node:events';
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls';
import { ImapFramer, values, atom, quote, encodeMailbox, decodeMailbox, responseCode, type Frame, type Value } from './wire';
import { decodeHeader } from './mime';

export interface SearchObject {
  deleted?: boolean; seen?: boolean; uid?: string;
  from?: string; to?: string; subject?: string; text?: string;
  since?: Date; before?: Date;
}
interface Address { name?: string; address?: string }
export interface FetchMessageObject {
  uid: number; seq: number; flags?: Set<string>; size?: number; source?: Buffer; headers?: Buffer; internalDate?: Date;
  envelope?: { date?: Date; subject?: string; messageId?: string; from?: Address[]; to?: Address[]; cc?: Address[] };
}
export interface Mailbox { path: string; uidValidity: bigint; uidNext: number; exists: number; readOnly: boolean }
interface FetchQuery { uid?: boolean; flags?: boolean; envelope?: boolean; size?: boolean; internalDate?: boolean; source?: { maxLength: number }; headers?: { maxLength: number } }
interface ClientOptions {
  host: string; port: number; secure: true; auth: { user: string; pass: string };
  tls?: ConnectionOptions; logger?: false; connectionTimeout?: number; greetingTimeout?: number;
  socketTimeout?: number; commandTimeout?: number; autoIdleDelay?: number; maxIdleTime?: number;
}
interface Reply { tag: string; frames: Frame[] }
interface Pending {
  tag: string; label: string; resolve: (reply: Reply) => void; reject: (error: Error) => void;
  frames: Frame[]; bytes: number; timer?: ReturnType<typeof setTimeout>; continuation?: () => void;
}
interface IdleState { ready: Promise<void>; acknowledge: () => void; completion: Promise<Reply>; done: boolean }

export class ImapCommandError extends Error {
  constructor(readonly status: string, label: string) { super(`IMAP ${label} failed (${status}).`); }
}
export class ImapConnectionError extends Error {}
export class MissingSearchResponseError extends ImapConnectionError {
  constructor() { super('IMAP SEARCH response is missing.'); }
}
export class ImapAuthenticationError extends Error {}

export function isRetryableConnectionError(error: unknown): boolean {
  if (error instanceof ImapConnectionError) return true;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return ['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH',
    'ENETDOWN', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND'].includes(code ?? '');
}

export class ImapClient extends EventEmitter {
  readonly capabilities = new Map<string, true>();
  mailbox: Mailbox | false = false;
  usable = false;
  private socket?: TLSSocket;
  private pending?: Pending;
  private greeting?: { resolve: (preauth: boolean) => void; reject: (error: Error) => void };
  private closed = false;
  private started = false;
  private counter = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private lockTail: Promise<void> = Promise.resolve();
  private lockCount = 0;
  private idle?: IdleState;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private renewalTimer?: ReturnType<typeof setTimeout>;

  constructor(readonly options: ClientOptions) { super(); }

  async connect(): Promise<void> {
    if (this.started) throw new Error('Create a new IMAP client for each connection.');
    this.started = true;
    const greeting = new Promise<boolean>((resolve, reject) => { this.greeting = { resolve, reject }; });
    const framer = new ImapFramer((frame) => this.receive(frame));
    let connectionTimer: ReturnType<typeof setTimeout> | undefined;
    let greetingTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const secure = new Promise<void>((resolve, reject) => {
        this.socket = tlsConnect({ ...this.options.tls, host: this.options.host, port: this.options.port,
          minVersion: 'TLSv1.2', rejectUnauthorized: true }, () => {
          clearTimeout(connectionTimer); resolve();
        });
        this.socket.once('error', reject);
        this.socket.on('error', (error) => this.fail(error));
        this.socket.on('close', () => this.close());
        this.socket.setTimeout(this.options.socketTimeout ?? 300_000, () => this.fail(new ImapConnectionError('IMAP socket timed out.')));
        this.socket.on('data', (chunk: Buffer) => {
          try { framer.push(chunk); } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
        });
        connectionTimer = setTimeout(() => this.fail(new ImapConnectionError('IMAP TLS connection timed out.')), this.options.connectionTimeout ?? 30_000);
      });
      greetingTimer = setTimeout(() => this.fail(new ImapConnectionError('IMAP server greeting timed out.')), this.options.greetingTimeout ?? 15_000);
      const [, preauth] = await Promise.all([secure, greeting]);
      clearTimeout(greetingTimer);
      await this.run(() => this.send('CAPABILITY'));
      if (!preauth) {
        try {
          if (this.capabilities.has('AUTH=PLAIN')) {
            if (/[\x00\r\n]/.test(this.options.auth.user + this.options.auth.pass)) throw new Error('Invalid authentication value.');
            const payload = Buffer.from(`\0${this.options.auth.user}\0${this.options.auth.pass}`, 'utf8').toString('base64');
            if (this.capabilities.has('SASL-IR')) await this.run(() => this.send(`AUTHENTICATE PLAIN ${payload}`));
            else await this.run(() => this.send('AUTHENTICATE PLAIN', () => { this.socket?.write(`${payload}\r\n`); }));
          } else {
            if (this.capabilities.has('LOGINDISABLED')) throw new Error('Server disabled password login.');
            await this.run(() => this.send(`LOGIN ${quote(this.options.auth.user)} ${quote(this.options.auth.pass)}`));
          }
        } catch (error) {
          if (isRetryableConnectionError(error)) throw error;
          throw new ImapAuthenticationError('IMAP authentication failed. Check your username and app-specific password.');
        }
      }
      await this.run(() => this.send('CAPABILITY'));
      this.usable = true;
    } catch (error) {
      this.close(); throw error;
    } finally { clearTimeout(connectionTimer); clearTimeout(greetingTimer); }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.close(error);
    if (this.listenerCount('error')) this.emit('error', error);
  }

  close(reason = new ImapConnectionError('IMAP connection closed.')): void {
    if (this.closed) return;
    this.closed = true; this.usable = false;
    clearTimeout(this.idleTimer); clearTimeout(this.renewalTimer);
    const pending = this.pending; this.pending = undefined;
    clearTimeout(pending?.timer); pending?.reject(reason);
    this.greeting?.reject(reason); this.greeting = undefined;
    this.idle?.acknowledge(); this.idle = undefined;
    this.socket?.destroy(); this.emit('close', reason);
  }

  private receive(frame: Frame): void {
    const tokens = values(frame); const first = atom(tokens[0]);
    if (this.greeting) {
      if (first === '*' && atom(tokens[1]).toUpperCase() === 'BYE') throw new ImapConnectionError('IMAP server is temporarily unavailable.');
      if (first !== '*' || !['OK', 'PREAUTH'].includes(atom(tokens[1]).toUpperCase())) {
        throw new Error('IMAP server rejected the initial connection.');
      }
      const wait = this.greeting; this.greeting = undefined; wait.resolve(atom(tokens[1]).toUpperCase() === 'PREAUTH');
      return;
    }
    if (first === '+') {
      if (!this.pending?.continuation) throw new Error('Unexpected IMAP continuation.');
      this.pending.continuation(); return;
    }
    if (first === '*') {
      const kind = atom(tokens[1]).toUpperCase();
      if (kind === 'BYE' && this.pending?.label !== 'LOGOUT') throw new ImapConnectionError('IMAP server closed the connection.');
      if (kind === 'CAPABILITY') {
        this.capabilities.clear();
        for (const item of tokens.slice(2)) this.capabilities.set(atom(item).toUpperCase(), true);
      }
      if (this.mailbox) {
        const code = responseCode(frame);
        if (code?.tag === '*' && (code.name === 'UIDVALIDITY' || code.name === 'UIDNEXT')) {
          const value = responseUid(code.args);
          if (code.name === 'UIDVALIDITY') this.mailbox.uidValidity = BigInt(value);
          else this.mailbox.uidNext = value;
        }
        if (atom(tokens[2]).toUpperCase() === 'EXISTS') {
          const previous = this.mailbox.exists; this.mailbox.exists = Number(tokens[1]);
          if (this.mailbox.exists > previous) this.emit('exists', { path: this.mailbox.path, count: this.mailbox.exists });
        } else if (atom(tokens[2]).toUpperCase() === 'EXPUNGE') this.mailbox.exists = Math.max(0, this.mailbox.exists - 1);
      }
    }
    const current = this.pending;
    if (!current) return;
    current.bytes += frame.reduce((sum, part) => sum + Buffer.byteLength(part), 0);
    if (current.bytes > 110 * 1024 * 1024) throw new Error('IMAP command response exceeds 110 MB.');
    current.frames.push(frame);
    if (first === current.tag) {
      this.pending = undefined; clearTimeout(current.timer);
      const status = atom(tokens[1]).toUpperCase();
      if (status === 'OK') current.resolve({ tag: current.tag, frames: current.frames });
      else current.reject(new ImapCommandError(status, current.label));
    }
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    this.queued++; clearTimeout(this.idleTimer);
    const result = this.tail.then(async () => {
      if (this.closed) throw new ImapConnectionError('IMAP connection is closed.');
      await this.endIdle();
      return task();
    });
    this.tail = result.catch(() => {});
    return result.finally(() => { this.queued--; this.scheduleIdle(); });
  }

  private send(command: string | Array<string | Buffer>, onContinuation?: () => void, idle = false): Promise<Reply> {
    if (this.closed || this.pending) return Promise.reject(new Error('IMAP command state is unavailable.'));
    const parts = typeof command === 'string' ? [command] : command;
    const tag = `C${++this.counter}`;
    return new Promise<Reply>((resolve, reject) => {
      const pending: Pending = { tag, label: String(parts[0]).split(' ')[0], resolve, reject, frames: [], bytes: 0, continuation: onContinuation };
      this.pending = pending;
      pending.timer = setTimeout(() => this.fail(new ImapConnectionError(`IMAP ${pending.label} timed out.`)), this.options.commandTimeout ?? 30_000);
      let index = 0;
      const write = () => {
        if (this.closed || this.pending !== pending) return;
        while (index < parts.length) {
          const part = parts[index++];
          if (typeof part === 'string') this.socket?.write(part, 'ascii');
          else {
            const nonSync = this.capabilities.has('LITERAL+');
            this.socket?.write(`{${part.length}${nonSync ? '+' : ''}}\r\n`, 'ascii');
            if (!nonSync) {
              pending.continuation = () => {
                pending.continuation = onContinuation; this.socket?.write(part); write();
              };
              return;
            }
            this.socket?.write(part);
          }
        }
        this.socket?.write('\r\n', 'ascii');
      };
      this.socket?.write(`${tag} `, 'ascii'); write();
      if (idle && pending.continuation) {
        const acknowledge = pending.continuation;
        pending.continuation = () => { clearTimeout(pending.timer); acknowledge(); };
      }
    });
  }

  private scheduleIdle(): void {
    if (!this.usable || this.closed || !this.mailbox || this.lockCount || this.queued || this.pending || this.idle || !this.capabilities.has('IDLE')) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.closed || this.lockCount || this.queued || this.pending || this.idle) return;
      let acknowledge!: () => void;
      const ready = new Promise<void>((resolve) => { acknowledge = resolve; });
      const completion = this.send('IDLE', acknowledge, true);
      const idle: IdleState = { ready, acknowledge, completion, done: false }; this.idle = idle;
      // Servers may end IDLE themselves. Resume it while connected, or fall back to polling on NO/BAD.
      void completion.then(() => { acknowledge(); }, (error) => {
        acknowledge();
        if (error instanceof ImapCommandError) this.capabilities.delete('IDLE');
      }).finally(() => {
        if (this.idle === idle) this.idle = undefined;
        clearTimeout(this.renewalTimer); this.scheduleIdle();
      });
      this.renewalTimer = setTimeout(() => { void this.run(async () => {}).catch(() => {}); }, this.options.maxIdleTime ?? 240_000);
    }, this.options.autoIdleDelay ?? 1_000);
  }

  private async endIdle(): Promise<void> {
    const idle = this.idle; if (!idle) return;
    await idle.ready;
    if (this.pending?.label === 'IDLE' && !idle.done) {
      idle.done = true; this.socket?.write('DONE\r\n');
      this.pending.timer = setTimeout(() => this.fail(new ImapConnectionError('IMAP IDLE completion timed out.')), this.options.commandTimeout ?? 30_000);
    }
    try { await idle.completion; }
    catch (error) { if (!(error instanceof ImapCommandError)) throw error; }
    if (this.idle === idle) this.idle = undefined;
    clearTimeout(this.renewalTimer);
  }

  async getMailboxLock(path: string, options: { readOnly?: boolean } = {}): Promise<{ release: () => void }> {
    let unlock!: () => void; const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const previous = this.lockTail; this.lockTail = previous.then(() => gate); await previous;
    this.lockCount++; let released = false;
    const release = () => { if (released) return; released = true; this.lockCount--; unlock(); this.scheduleIdle(); };
    try {
      if (!this.mailbox || this.mailbox.path !== path || this.mailbox.readOnly !== Boolean(options.readOnly)) {
        this.mailbox = { path, uidValidity: 0n, uidNext: 0, exists: 0, readOnly: Boolean(options.readOnly) };
        try { await this.run(() => this.send(`${options.readOnly ? 'EXAMINE' : 'SELECT'} ${quote(encodeMailbox(path))}`)); }
        catch (error) { this.mailbox = false; throw error; }
        if (!this.mailbox || this.mailbox.uidValidity < 1n) throw new Error('Mailbox response is missing UIDVALIDITY.');
        if (!Number.isSafeInteger(this.mailbox.uidNext) || this.mailbox.uidNext < 1) {
          // UIDNEXT is a SHOULD in IMAP4rev1. Derive a baseline if the server omits it.
          const found = await this.searchWithFallback({});
          this.mailbox.uidNext = found.reduce((max, uid) => Math.max(max, uid + 1), 1);
        }
      }
      return { release };
    } catch (error) { release(); throw error; }
  }

  async list(): Promise<Array<{ path: string; name: string; delimiter: string; flags: Set<string>; specialUse?: string }>> {
    const reply = await this.run(() => this.send('LIST "" "*"'));
    return reply.frames.flatMap((frame) => {
      const token = values(frame); if (atom(token[0]) !== '*' || atom(token[1]).toUpperCase() !== 'LIST' || !Array.isArray(token[2])) return [];
      const flags = new Set(token[2].map((flag) => {
        const value = atom(flag); return value.toLowerCase() === '\\noselect' ? '\\Noselect' : value;
      }));
      const path = decodeMailbox(atom(token[4])); const delimiter = atom(token[3]);
      return [{ path, name: delimiter ? path.split(delimiter).at(-1) ?? path : path, delimiter, flags,
        specialUse: [...flags].find((flag) => /^\\(?:all|archive|drafts|flagged|junk|sent|trash|inbox)$/i.test(flag)) }];
    });
  }

  async noop(): Promise<void> { await this.run(() => this.send('NOOP')); }

  async search(query: SearchObject, options: { uid: true }): Promise<number[]> {
    if (!options.uid) throw new Error('This client supports UID searches only.');
    const parts: Array<string | Buffer> = ['UID SEARCH'];
    const international = [query.from, query.to, query.subject, query.text].some((text) => text && /[^\x00-\x7f]/.test(text));
    if (international) parts.push(' CHARSET UTF-8');
    for (const [field, keyword, inverse] of [['seen', 'SEEN', 'UNSEEN'], ['deleted', 'DELETED', 'UNDELETED']] as const) {
      if (query[field] !== undefined) parts.push(` ${query[field] ? keyword : inverse}`);
    }
    if (query.uid) {
      if (!/^[1-9]\d*:\*$/.test(query.uid)) throw new Error('Invalid IMAP UID search range.');
      parts.push(` UID ${query.uid}`);
    }
    for (const field of ['from', 'to', 'subject', 'text'] as const) {
      if (query[field] !== undefined) {
        const text = query[field]!;
        if (/[\x00-\x1f\x7f]/.test(text)) throw new Error('Search text contains a control character.');
        parts.push(` ${field.toUpperCase()} `, /[^\x00-\x7f]/.test(text) ? Buffer.from(text, 'utf8') : quote(text));
      }
    }
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    for (const field of ['since', 'before'] as const) {
      const date = query[field];
      if (date) {
        if (!Number.isFinite(date.getTime())) throw new Error('Invalid IMAP search date.');
        parts.push(` ${field.toUpperCase()} ${date.getUTCDate()}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`);
      }
    }
    if (parts.length === 1 || parts.length === 2 && international) parts.push(' ALL');
    const reply = await this.run(() => this.send(parts));
    let result: number[] | undefined;
    for (const frame of reply.frames) {
      const token = values(frame);
      if (atom(token[0]) !== '*') continue;
      const kind = atom(token[1]).toUpperCase();
      if (kind === 'SEARCH') {
        result ??= [];
        for (const uid of token.slice(2)) if (/^[1-9]\d*$/.test(atom(uid))) result.push(Number(uid));
      } else if (kind === 'ESEARCH') {
        const extended = extendedSearchUids(token.slice(2), reply.tag);
        if (extended !== undefined) return extended;
      }
    }
    // A tagged OK confirms command completion, not that the search found zero messages.
    if (!result) throw new MissingSearchResponseError();
    return result;
  }

  // Missing SEARCH data is not proof of an empty result. Verify it with FETCH.
  async searchWithFallback(query: SearchObject): Promise<number[]> {
    try { return await this.search(query, { uid: true }); }
    catch (error) { if (!(error instanceof MissingSearchResponseError)) throw error; }
    const validity = this.mailbox && this.mailbox.uidValidity;
    const found = await this.fetchUidsAfter(0, query.deleted);
    if (!this.mailbox || this.mailbox.uidValidity !== validity) throw new Error('Mailbox UIDVALIDITY changed during search.');
    if (!found.length || Object.keys(query).every((key) => key === 'deleted')) return found;
    // FETCH cannot reproduce IMAP text/date search semantics. Never drop filters.
    try { return await this.search(query, { uid: true }); }
    catch (error) {
      if (!(error instanceof MissingSearchResponseError)) throw error;
      throw new Error('IMAP SEARCH response is missing for a filtered search. Filters were preserved; no unfiltered messages were returned.', { cause: error });
    }
  }

  async fetchUndeletedUidsAfter(lastUid: number): Promise<number[]> {
    return this.fetchUidsAfter(lastUid, false);
  }

  private async fetchUidsAfter(lastUid: number, deleted?: boolean): Promise<number[]> {
    const start = lastUid + 1;
    this.assertUid(start, { uid: true });
    // An explicit upper bound avoids n:* matching the previous highest UID.
    const reply = await this.run(() => this.send(`UID FETCH ${start}:4294967295 (UID FLAGS)`));
    const flagsByUid = new Map<number, Value[]>();
    for (const frame of reply.frames) {
      const tokens = values(frame);
      const data = tokens[3];
      if (atom(tokens[0]) !== '*' || atom(tokens[2]).toUpperCase() !== 'FETCH' || !Array.isArray(data)) continue;
      const fields = new Map<string, Value>();
      for (let i = 0; i + 1 < data.length; i += 2) fields.set(atom(data[i]).toUpperCase(), data[i + 1]);
      const uid = Number(atom(fields.get('UID')));
      if (!Number.isInteger(uid) || uid < start || uid > 4_294_967_295) continue;
      const flags = fields.get('FLAGS');
      if (!Array.isArray(flags)) throw new Error('IMAP UID FETCH response is missing FLAGS.');
      flagsByUid.set(uid, flags);
    }
    return [...flagsByUid].filter(([, flags]) => deleted === undefined ||
      flags.some((flag) => atom(flag).toUpperCase() === '\\DELETED') === deleted)
      .map(([uid]) => uid);
  }

  async fetchOne(uid: number, query: FetchQuery, options: { uid: true }): Promise<FetchMessageObject | false> {
    this.assertUid(uid, options);
    const fields = ['UID'];
    if (query.flags) fields.push('FLAGS'); if (query.envelope) fields.push('ENVELOPE');
    if (query.size) fields.push('RFC822.SIZE'); if (query.internalDate) fields.push('INTERNALDATE');
    if (query.headers) {
      const limit = query.headers.maxLength;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024 * 1024 + 5) throw new Error('Invalid header byte limit.');
      fields.push(`BODY.PEEK[HEADER]<0.${limit}>`);
    }
    if (query.source) {
      const limit = query.source.maxLength;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 105 * 1024 * 1024) throw new Error('Invalid message byte limit.');
      fields.push(`BODY.PEEK[]<0.${limit}>`);
    }
    const reply = await this.run(() => this.send(`UID FETCH ${uid} (${fields.join(' ')})`));
    let result: FetchMessageObject | undefined;
    for (const frame of reply.frames) {
      const token = values(frame); const attributes = token[3];
      if (atom(token[0]) !== '*' || atom(token[2]).toUpperCase() !== 'FETCH' || !Array.isArray(attributes)) continue;
      const data = new Map<string, Value>();
      for (let index = 0; index + 1 < attributes.length; index += 2) data.set(atom(attributes[index]).toUpperCase(), attributes[index + 1]);
      if (Number(atom(data.get('UID'))) !== uid) continue;
      result ??= { uid, seq: Number(token[1]) };
      if (Array.isArray(data.get('FLAGS'))) result.flags = new Set((data.get('FLAGS') as Value[]).map(atom));
      if (data.has('RFC822.SIZE')) result.size = Number(atom(data.get('RFC822.SIZE')));
      if (data.has('INTERNALDATE')) result.internalDate = validDate(atom(data.get('INTERNALDATE')));
      const envelope = data.get('ENVELOPE');
      if (Array.isArray(envelope)) result.envelope = {
        date: validDate(atom(envelope[0])), subject: decodeHeader(atom(envelope[1])),
        from: addresses(envelope[2]), to: addresses(envelope[5]), cc: addresses(envelope[6]), messageId: atom(envelope[9]),
      };
      for (const [name, value] of data) {
        if (/^BODY\[\](?:<\d+>)?$/.test(name) && Buffer.isBuffer(value)) result.source = value;
        if (/^BODY\[HEADER\](?:<\d+>)?$/.test(name) && Buffer.isBuffer(value)) result.headers = value;
      }
    }
    if (result && this.mailbox) this.mailbox.uidNext = Math.max(this.mailbox.uidNext, uid + 1);
    return result ?? false;
  }

  private assertUid(uid: number, options: { uid: true }): void {
    if (!options.uid || !Number.isSafeInteger(uid) || uid < 1 || uid > 4_294_967_295) throw new Error('A single numeric UID is required.');
  }

  async messageFlagsAdd(uid: number, flags: string[], options: { uid: true }): Promise<boolean> {
    this.assertUid(uid, options);
    if (!flags.length || flags.some((flag) => !/^\\(?:Seen|Deleted|Flagged|Answered|Draft)$/i.test(flag))) throw new Error('Unsupported message flag.');
    await this.run(() => this.send(`UID STORE ${uid} +FLAGS.SILENT (${flags.join(' ')})`)); return true;
  }

  async messageMove(uid: number, destination: string, options: { uid: true }): Promise<{ uidMap: Map<number, number>; uidValidity?: bigint }> {
    this.assertUid(uid, options);
    const target = quote(encodeMailbox(destination));
    return this.run(async () => {
      let copy: Reply;
      if (this.capabilities.has('MOVE')) copy = await this.send(`UID MOVE ${uid} ${target}`);
      else {
        if (!this.capabilities.has('UIDPLUS')) throw new Error('Safe move requires MOVE or UIDPLUS.');
        copy = await this.send(`UID COPY ${uid} ${target}`);
        await this.send(`UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`);
        await this.send(`UID EXPUNGE ${uid}`);
      }
      const map = new Map<number, number>(); let validity: bigint | undefined;
      for (const frame of copy.frames) {
        const code = responseCode(frame);
        if (code?.name !== 'COPYUID') continue;
        const args = code.args.split(' ');
        if (args.length !== 3) throw new Error('Invalid IMAP COPYUID response; check both folders before retrying.');
        validity = BigInt(responseUid(args[0]));
        const source = responseUid(args[1], true); const target = responseUid(args[2], true);
        if (source !== uid) throw new Error('Unexpected IMAP COPYUID source; check both folders before retrying.');
        map.set(source, target);
      }
      return { uidMap: map, uidValidity: validity };
    });
  }

  async logout(): Promise<void> {
    try { if (!this.closed) await this.run(() => this.send('LOGOUT')); }
    finally { this.close(); }
  }
}

function extendedSearchUids(tokens: Value[], tag: string): number[] | undefined {
  const correlator = tokens[0];
  const offset = Array.isArray(correlator) ? 1 : 0;
  if (Array.isArray(correlator) && (atom(correlator[0]).toUpperCase() !== 'TAG' || atom(correlator[1]) !== tag)) return;
  if (atom(tokens[offset]).toUpperCase() !== 'UID') return;

  const pairs = tokens.slice(offset + 1);
  if (pairs.length % 2) throw new Error('Invalid IMAP ESEARCH response.');
  const fields = new Map<string, string>();
  for (let i = 0; i < pairs.length; i += 2) {
    const name = atom(pairs[i]).toUpperCase();
    if (fields.has(name)) throw new Error('Invalid IMAP ESEARCH response.');
    fields.set(name, atom(pairs[i + 1]));
  }
  const count = fields.get('COUNT');
  if (count !== undefined && !/^(?:0|[1-9]\d{0,9})$/.test(count)) throw new Error('Invalid IMAP ESEARCH count.');
  const all = fields.get('ALL');
  if (all === undefined) {
    if (fields.has('MIN') || fields.has('MAX') || count !== undefined && count !== '0') {
      throw new Error('Incomplete IMAP ESEARCH response: matching UIDs are missing.');
    }
    return [];
  }

  const result: number[] = [];
  // Bound expansion: a short range can otherwise allocate billions of entries.
  for (const range of all.split(',')) {
    const match = /^([1-9]\d{0,9})(?::([1-9]\d{0,9}))?$/.exec(range);
    if (!match) throw new Error('Invalid IMAP ESEARCH UID set.');
    const first = responseUid(match[1]);
    const last = match[2] === undefined ? first : responseUid(match[2]);
    if (result.length + Math.abs(last - first) + 1 > 1_000_000) throw new Error('IMAP ESEARCH result exceeds the UID limit.');
    for (let uid = Math.min(first, last); uid <= Math.max(first, last); uid++) result.push(uid);
  }
  const unique = [...new Set(result)];
  if (count !== undefined && Number(count) !== unique.length) throw new Error('IMAP ESEARCH count does not match the UID set.');
  return unique;
}

function responseUid(text: string, allowSingletonRange = false): number {
  const match = /^([1-9]\d{0,9})(?::([1-9]\d{0,9}))?$/.exec(text);
  if (!match || Number(match[1]) > 4_294_967_295 ||
    match[2] !== undefined && (!allowSingletonRange || match[1] !== match[2])) {
    throw new Error('Invalid IMAP UID response code.');
  }
  return Number(match[1]);
}

function validDate(value: string): Date | undefined {
  const date = new Date(value); return Number.isFinite(date.getTime()) ? date : undefined;
}
function addresses(value: Value | undefined): Address[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((address) => {
    if (!Array.isArray(address) || address[2] === null || address[3] === null) return [];
    return [{ name: decodeHeader(atom(address[0])), address: `${atom(address[2])}@${atom(address[3])}` }];
  });
}
