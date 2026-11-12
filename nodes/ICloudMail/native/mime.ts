/** Bounded MIME reader for normal Internet messages; no external modules. */
export class MimeParseError extends Error {
  constructor(readonly code: 'MIME_INVALID' | 'MIME_LIMIT' | 'MIME_ENCODING' | 'MIME_ADDRESS', message: string) {
    super(message); this.name = 'MimeParseError';
  }
}

export interface Attachment {
  filename?: string;
  contentType: string;
  contentId?: string;
  size: number;
  content: Buffer;
}
export interface ParsedMail {
  subject: string;
  messageId: string;
  text: string;
  html: string;
  replyTo: { value: Array<{ name?: string; address?: string }> };
  inReplyTo: string;
  references: string[];
  attachments: Attachment[];
  warnings: string[];
}

export function decodeText(bytes: Buffer, charset = 'utf-8', warnings: string[] = []): string {
  try { return new TextDecoder(charset.replace(/^"|"$/g, ''), { fatal: false }).decode(bytes); }
  catch {
    warnings.push(`Unsupported charset ${charset}; decoded as UTF-8.`);
    return bytes.toString('utf8');
  }
}

export function quotedPrintable(bytes: Buffer, header = false): Buffer {
  const text = bytes.toString('latin1').replace(/=\r?\n/g, ''); const result: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '=' && /^[0-9a-f]{2}$/i.test(text.slice(index + 1, index + 3))) {
      result.push(parseInt(text.slice(index + 1, index + 3), 16)); index += 2;
    } else result.push(header && text[index] === '_' ? 32 : text.charCodeAt(index));
  }
  return Buffer.from(result);
}

export function decodeHeader(text: string, warnings: string[] = []): string {
  return text.replace(/(\?=)[ \t\r\n]+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, charset: string, encoding: string, encoded: string) => {
      const bytes = encoding.toLowerCase() === 'b' ? Buffer.from(encoded, 'base64') : quotedPrintable(Buffer.from(encoded, 'latin1'), true);
      return decodeText(bytes, charset, warnings);
    });
}

function headerBlock(raw: Buffer): { headers: Map<string, string[]>; body: Buffer } {
  let end = raw.indexOf('\r\n\r\n'); let delimiter = 4;
  if (end < 0) { end = raw.indexOf('\n\n'); delimiter = 2; }
  if (end < 0) { end = raw.length; delimiter = 0; }
  if (end > 1024 * 1024) throw new MimeParseError('MIME_LIMIT', 'MIME header exceeds 1 MB.');
  const headers = new Map<string, string[]>();
  const unfolded = raw.subarray(0, end).toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':'); if (colon < 1) continue;
    const name = line.slice(0, colon).toLowerCase().trim(); const value = line.slice(colon + 1).trim();
    const previous = headers.get(name);
    if (previous) previous.push(value);
    else headers.set(name, [value]);
  }
  return { headers, body: raw.subarray(end + delimiter) };
}

/** All top-level fields, unfolded but otherwise undecoded; preserve repeated values. */
export function parseHeaders(raw: Buffer): Record<string, string[]> {
  // fromEntries creates own data properties even for names such as __proto__.
  return Object.fromEntries(headerBlock(raw).headers);
}

function headersAndBody(raw: Buffer): { headers: Map<string, string>; body: Buffer } {
  const block = headerBlock(raw);
  return { headers: new Map([...block.headers].map(([name, values]) => [name, values.join('\n')])), body: block.body };
}

function percentBytes(value: string): Buffer {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '%' && /^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))) {
      bytes.push(parseInt(value.slice(index + 1, index + 3), 16)); index += 2;
    } else bytes.push(value.charCodeAt(index) & 255);
  }
  return Buffer.from(bytes);
}

export function parameterized(value: string, warnings: string[] = []): { value: string; params: Record<string, string> } {
  const pieces: string[] = []; let current = ''; let quoted = false; let escaped = false;
  for (const char of value) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\' && quoted) { current += char; escaped = true; continue; }
    if (char === '"') quoted = !quoted;
    if (char === ';' && !quoted) { pieces.push(current.trim()); current = ''; }
    else current += char;
  }
  pieces.push(current.trim());
  const params: Record<string, string> = Object.create(null);
  const raw = new Map<string, string>();
  for (const item of pieces.slice(1)) {
    const equal = item.indexOf('='); if (equal < 1) continue;
    const name = item.slice(0, equal).toLowerCase().trim(); let text = item.slice(equal + 1).trim();
    if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).replace(/\\(.)/g, '$1');
    raw.set(name, text);
  }
  const extended = (text: string) => {
    const match = /^([^']*)'[^']*'(.*)$/s.exec(text);
    return match ? decodeText(percentBytes(match[2]), match[1] || 'utf-8', warnings) : decodeText(percentBytes(text), 'utf-8', warnings);
  };
  for (const [name, text] of raw) {
    if (!name.includes('*')) params[name] = decodeHeader(text, warnings);
  }
  for (const [name, text] of raw) {
    if (name.endsWith('*') && !/\*\d+\*?$/.test(name)) params[name.slice(0, -1)] = extended(text);
  }
  // Join continuation bytes before decoding, so split UTF-8 characters survive.
  for (const [name] of raw) {
    const first = /^(.*?)\*0(\*)?$/.exec(name); if (!first) continue;
    const chunks: Buffer[] = []; let charset = 'utf-8'; let count = 0;
    for (let index = 0; index < 1000; index++) {
      const encoded = raw.has(`${first[1]}*${index}*`);
      const text = raw.get(`${first[1]}*${index}${encoded ? '*' : ''}`);
      if (text === undefined) break;
      let payload = text;
      if (index === 0 && encoded) {
        const prefix = /^([^']*)'[^']*'(.*)$/s.exec(payload);
        if (prefix) { charset = prefix[1] || 'utf-8'; payload = prefix[2]; }
      }
      chunks.push(encoded ? percentBytes(payload) : Buffer.from(payload, 'latin1')); count++;
    }
    if (count) params[first[1]] = decodeText(Buffer.concat(chunks), charset, warnings);
  }
  return { value: (pieces[0] || '').toLowerCase(), params };
}

export function parseAddresses(text: string): Array<{ name?: string; address?: string }> {
  if (text.length > 64 * 1024) throw new MimeParseError('MIME_LIMIT', 'Address header exceeds 64 KB.');
  const pieces: string[] = []; let current = ''; let quote = false; let escape = false; let angle = 0; let comment = 0;
  for (const char of text) {
    if (escape) { if (!comment) current += char; escape = false; continue; }
    if (char === '\\') { if (!comment) current += char; escape = true; continue; }
    if (!quote && char === '(') {
      if (++comment > 30) throw new MimeParseError('MIME_LIMIT', 'Address comment nesting limit exceeded.');
      continue;
    }
    if (!quote && char === ')') {
      if (!comment) throw new MimeParseError('MIME_ADDRESS', 'Unmatched address comment.');
      comment--; continue;
    }
    if (comment) continue;
    if (char === '"') quote = !quote;
    if (!quote && char === '<') angle++;
    if (!quote && char === '>') angle--;
    if (!quote && !angle && (char === ',' || char === ';')) { pieces.push(current); current = ''; }
    else if (!quote && !angle && char === ':') current = ''; // Group label.
    else current += char;
  }
  if (comment || quote || escape) throw new MimeParseError('MIME_ADDRESS', 'Unterminated address comment or quoted value.');
  pieces.push(current);
  return pieces.flatMap((piece) => {
    const match = /^(.*?)<([^<>]+)>\s*$/.exec(piece.trim());
    const address = (match ? match[2] : piece).trim();
    if (!address) return [];
    const name = match ? decodeHeader(match[1].trim().replace(/^"|"$/g, '').replace(/\\(.)/g, '$1')) : '';
    return [{ address, ...(name ? { name } : {}) }];
  });
}

function transfer(body: Buffer, encoding: string): Buffer {
  switch (encoding.trim().toLowerCase()) {
    case 'base64': return Buffer.from(body.toString('ascii').replace(/\s/g, ''), 'base64');
    case 'quoted-printable': return quotedPrintable(body);
    case '': case '7bit': case '8bit': case 'binary': return body;
    default: throw new MimeParseError('MIME_ENCODING', 'Unsupported MIME transfer encoding.');
  }
}

interface PartBudget { remaining: number }

function* multipart(body: Buffer, boundary: string, budget: PartBudget): Generator<Buffer> {
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) throw new MimeParseError('MIME_INVALID', 'Invalid MIME boundary.');
  const marker = Buffer.from(`--${boundary}`, 'utf8'); const closingMarker = Buffer.from(`--${boundary}--`, 'utf8');
  let begin: number | undefined; let offset = 0; let closed = false; let children = 0;
  while (offset <= body.length) {
    const found = body.indexOf(10, offset); const end = found < 0 ? body.length : found;
    let lineEnd = end;
    if (body[lineEnd - 1] === 13) lineEnd--;
    while (lineEnd > offset && (body[lineEnd - 1] === 32 || body[lineEnd - 1] === 9)) lineEnd--;
    const length = lineEnd - offset;
    const isMarker = length === marker.length && body.compare(marker, 0, marker.length, offset, lineEnd) === 0;
    const isClosing = length === closingMarker.length && body.compare(closingMarker, 0, closingMarker.length, offset, lineEnd) === 0;
    if (isMarker || isClosing) {
      if (begin !== undefined) {
        // The same budget is consumed by visit(), including all nested multipart children.
        // Check before creating the child view, rather than after an eager split.
        if (budget.remaining < 1) throw new MimeParseError('MIME_LIMIT', 'MIME nesting/part limit exceeded.');
        let partEnd = offset;
        if (body[partEnd - 1] === 10) partEnd--;
        if (body[partEnd - 1] === 13) partEnd--;
        children++;
        yield body.subarray(begin, Math.max(begin, partEnd));
      }
      if (isClosing) { closed = true; break; }
      begin = end + (found < 0 ? 0 : 1);
    }
    if (found < 0) break;
    offset = end + 1;
  }
  if (!closed || !children) throw new MimeParseError('MIME_INVALID', 'Incomplete MIME multipart body.');
}

export async function parseMail(raw: Buffer): Promise<ParsedMail> {
  const top = headersAndBody(raw).headers;
  const warnings: string[] = [];
  const result: ParsedMail = {
    subject: decodeHeader(top.get('subject') ?? '', warnings), messageId: top.get('message-id') ?? '',
    text: '', html: '', replyTo: { value: parseAddresses(top.get('reply-to') ?? '') },
    inReplyTo: top.get('in-reply-to') ?? '', references: (top.get('references') ?? '').match(/<[^<>]+>/g) ?? [],
    attachments: [], warnings,
  };
  const budget: PartBudget = { remaining: 1000 };
  const visit = (part: Buffer, depth: number, defaultType = 'text/plain') => {
    if (depth > 30 || budget.remaining < 1) throw new MimeParseError('MIME_LIMIT', 'MIME nesting/part limit exceeded.');
    budget.remaining--;
    const { headers, body } = headersAndBody(part);
    const type = parameterized(headers.get('content-type') ?? defaultType, warnings);
    const disposition = parameterized(headers.get('content-disposition') ?? '', warnings);
    const filename = disposition.params.filename || type.params.name;
    if (type.value.startsWith('multipart/') && disposition.value !== 'attachment' && !filename) {
      if (!type.params.boundary) throw new MimeParseError('MIME_INVALID', 'MIME multipart boundary is missing.');
      for (const child of multipart(body, type.params.boundary, budget)) visit(child, depth + 1, type.value === 'multipart/digest' ? 'message/rfc822' : 'text/plain');
      return;
    }
    const content = transfer(body, headers.get('content-transfer-encoding') ?? '');
    if (disposition.value === 'attachment' || filename || !['text/plain', 'text/html'].includes(type.value)) {
      result.attachments.push({ filename, contentType: type.value || 'application/octet-stream',
        contentId: headers.get('content-id'), size: content.length, content });
    } else {
      const text = decodeText(content, type.params.charset ?? 'utf-8', warnings);
      const key = type.value === 'text/html' ? 'html' : 'text';
      result[key] += (result[key] ? '\n' : '') + text;
    }
  };
  visit(raw, 0);
  return result;
}
