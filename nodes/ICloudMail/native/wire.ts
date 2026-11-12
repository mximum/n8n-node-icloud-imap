/** IMAP response framing and values. Literal bytes are never decoded as protocol text. */
export type Frame = Array<string | Buffer>;
export type Value = string | Buffer | null | Value[];

export class ImapFramer {
  private buffer: Buffer = Buffer.alloc(0);
  private parts: Frame = [];
  private remaining = 0;
  private literalParts: Buffer[] = [];
  private frameBytes = 0;
  constructor(private readonly onFrame: (frame: Frame) => void, private readonly maxBytes = 110 * 1024 * 1024) {}

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length || this.remaining === 0 && this.literalParts.length) {
      if (this.remaining) {
        const count = Math.min(this.remaining, this.buffer.length);
        this.literalParts.push(this.buffer.subarray(0, count));
        this.buffer = this.buffer.subarray(count); this.remaining -= count;
        if (this.remaining) return;
        this.parts.push(Buffer.concat(this.literalParts)); this.literalParts = [];
        continue;
      }
      const end = this.buffer.indexOf('\r\n');
      if (end < 0) {
        if (this.buffer.length > 1024 * 1024) throw new Error('IMAP response line exceeds 1 MB.');
        return;
      }
      const line = this.buffer.subarray(0, end).toString('latin1');
      this.buffer = this.buffer.subarray(end + 2); this.frameBytes += end + 2;
      if (this.frameBytes > this.maxBytes) throw new Error('IMAP response exceeds the configured byte limit.');
      const literal = /(?:~)?\{(\d+)\+?\}$/.exec(line);
      if (literal) {
        const size = Number(literal[1]);
        if (!Number.isSafeInteger(size) || size + this.frameBytes > this.maxBytes) throw new Error('IMAP literal exceeds the configured byte limit.');
        this.parts.push(line.slice(0, literal.index)); this.frameBytes += size;
        if (size) this.remaining = size;
        else this.parts.push(Buffer.alloc(0));
      } else {
        this.parts.push(line);
        const frame = this.parts; this.parts = []; this.frameBytes = 0;
        this.onFrame(frame);
      }
    }
  }
}

export function values(frame: Frame): Value[] {
  // Status response text is free-form, not a parenthesized IMAP data value.
  const status = typeof frame[0] === 'string' && /^([^\s]+)\s+(OK|NO|BAD|BYE|PREAUTH)\b(.*)$/i.exec(frame[0]);
  if (status) return [status[1], status[2], status[3].trim()];
  if (typeof frame[0] === 'string' && frame[0].startsWith('+')) return ['+', frame[0].slice(1)];
  const root: Value[] = []; const stack = [root]; let count = 0;
  const add = (value: Value) => {
    if (++count > 200_000) throw new Error('Too many IMAP response values.');
    stack[stack.length - 1].push(value);
  };
  for (const part of frame) {
    if (Buffer.isBuffer(part)) { add(part); continue; }
    let index = 0;
    while (index < part.length) {
      const char = part[index++];
      if (/\s/.test(char)) continue;
      if (char === '(') {
        if (stack.length > 100) throw new Error('IMAP nesting limit exceeded.');
        const list: Value[] = []; add(list); stack.push(list);
      } else if (char === ')') {
        if (stack.length === 1) throw new Error('Unbalanced IMAP list.');
        stack.pop();
      } else if (char === '"') {
        let text = ''; let complete = false;
        while (index < part.length) {
          const next = part[index++];
          if (next === '"') { complete = true; break; }
          if (next === '\\') {
            if (index >= part.length) throw new Error('Invalid quoted IMAP value.');
            text += part[index++];
          } else text += next;
        }
        if (!complete) throw new Error('Unterminated quoted IMAP value.');
        add(text);
      } else {
        let atom = char;
        while (index < part.length && !/[\s()]/.test(part[index])) atom += part[index++];
        add(atom.toUpperCase() === 'NIL' ? null : atom);
      }
    }
  }
  if (stack.length !== 1) throw new Error('Incomplete IMAP list.');
  return root;
}

export function quote(text: string): string {
  if (/[\x00-\x1f\x7f-\uffff]/.test(text)) throw new Error('IMAP quoted strings must contain printable ASCII.');
  return `"${text.replace(/["\\]/g, '\\$&')}"`;
}

export function encodeMailbox(text: string): string {
  if (/[\x00-\x1f\x7f]/.test(text)) throw new Error('Mailbox path contains a control character.');
  return text.replace(/[^\x20-\x7e]+|&/gu, (run) => {
    if (run === '&') return '&-';
    const bytes = Buffer.from(run, 'utf16le'); bytes.swap16();
    return `&${bytes.toString('base64').replace(/\//g, ',').replace(/=+$/, '')}-`;
  });
}

export function decodeMailbox(text: string): string {
  return text.replace(/&([A-Za-z0-9+,]*)-/g, (_, code: string) => {
    if (!code) return '&';
    const bytes = Buffer.from(code.replace(/,/g, '/'), 'base64');
    if (bytes.length % 2) throw new Error('Invalid modified UTF-7 mailbox name.');
    return bytes.swap16().toString('utf16le');
  });
}

export const atom = (value: Value | undefined): string => Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'string' ? value : '';
export const frameText = (frame: Frame): string => frame.filter((part) => typeof part === 'string').join(' ');

/** Only a leading response code of an OK status response can carry trusted control data. */
export function responseCode(frame: Frame): { tag: string; name: string; args: string } | undefined {
  if (frame.length !== 1 || typeof frame[0] !== 'string') return undefined;
  const match = /^(\*|[A-Za-z0-9]+) +OK +\[([A-Za-z][A-Za-z0-9-]*)(?: +([^\]\r\n]*))?\](?: |$)/i.exec(frame[0]);
  if (!match) return undefined;
  return { tag: match[1], name: match[2].toUpperCase(), args: match[3] ?? '' };
}
