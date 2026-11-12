const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ImapFramer, values, quote, encodeMailbox, decodeMailbox } = require('../dist/nodes/ICloudMail/native/wire');
const { parseMail, parseHeaders, decodeHeader, parameterized, parseAddresses } = require('../dist/nodes/ICloudMail/native/mime');

test('all headers preserve duplicates, empty fields, custom fields and encoded values, with folding and case normalization', () => {
  const headers = parseHeaders(Buffer.from('Received: first\r\nreceived: second\r\nList-Unsubscribe: <mailto:leave@example.com>,\r\n\t<https://example.com/unsubscribe>\r\nSubject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=\r\nX-Custom: value:with:colons\r\nX-Empty:\r\n\r\nBody: not a header'));
  assert.deepEqual(headers.received, ['first', 'second']);
  assert.deepEqual(headers['list-unsubscribe'], ['<mailto:leave@example.com>, <https://example.com/unsubscribe>']);
  assert.deepEqual(headers.subject, ['=?UTF-8?Q?Gr=C3=BC=C3=9Fe?=']);
  assert.deepEqual(headers['x-custom'], ['value:with:colons']);
  assert.deepEqual(headers['x-empty'], ['']);
  assert.equal(headers.body, undefined);
});

test('headers accept LF and absent fields without exposing prototype properties', () => {
  const headers = parseHeaders(Buffer.from('__proto__: data\nconstructor: value\nX-Test: yes\n\ntext'));
  assert.deepEqual(headers.__proto__, ['data']);
  assert.deepEqual(headers.constructor, ['value']);
  assert.equal(Object.getPrototypeOf(headers), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(parseHeaders(Buffer.from('\r\n\r\nbody')), {});
  assert.throws(() => parseHeaders(Buffer.alloc(1024 * 1024 + 1, 65)), /header exceeds/);
});

test('framer handles byte-by-byte delivery and literal CRLF/protocol-like content', () => {
  const body = Buffer.from('x\r\nC1 OK fake\r\n* 9 EXISTS\r\n😀');
  const wire = Buffer.concat([Buffer.from(`* 1 FETCH (UID 4 BODY[] {${body.length}}\r\n`), body, Buffer.from(')\r\nC1 OK done\r\n')]);
  const frames = []; const parser = new ImapFramer((frame) => frames.push(frame));
  for (const byte of wire) parser.push(Buffer.from([byte]));
  assert.equal(frames.length, 2);
  const tokens = values(frames[0]);
  assert.equal(tokens[3][1], '4'); assert.deepEqual(tokens[3][3], body);
});

test('framer preserves multiple and empty literals in one response', () => {
  const frames = []; const parser = new ImapFramer((frame) => frames.push(frame));
  parser.push(Buffer.from('* 1 FETCH (UID 8 BODY[1] {3}\r\nabc BODY[2] {0}\r\n BODY[3] {2}\r\nxy)\r\n'));
  const token = values(frames[0])[3];
  assert.equal(token[3].toString(), 'abc'); assert.equal(token[5].length, 0); assert.equal(token[7].toString(), 'xy');
});

test('literal and response nesting limits reject oversized/malformed data', () => {
  assert.throws(() => new ImapFramer(() => {}, 100).push(Buffer.from('* 1 FETCH (BODY[] {101}\r\n')), /limit/);
  assert.throws(() => values(['('.repeat(102) + ')'.repeat(102)]), /nesting/);
  assert.throws(() => values(['* LIST ("unfinished)']), /Unterminated/);
  assert.throws(() => values([')']), /Unbalanced/);
});

test('free-form server status text is not interpreted as structured IMAP data', () => {
  assert.deepEqual(values(['C5 OK Server says: unmatched ) and " here']), ['C5', 'OK', 'Server says: unmatched ) and " here']);
});

test('quoted command values escape syntax and refuse command injection', () => {
  assert.equal(quote('a"b\\c'), '"a\\"b\\\\c"');
  assert.throws(() => quote('a\r\nLOGOUT'), /printable ASCII/);
  assert.throws(() => quote('ä'), /printable ASCII/);
});

test('modified UTF-7 matches known folder vectors and round-trips Unicode', () => {
  assert.equal(encodeMailbox('~peter/mail/台北/日本語'), '~peter/mail/&U,BTFw-/&ZeVnLIqe-');
  assert.equal(decodeMailbox('&U,BTFw-'), '台北');
  for (const path of ['INBOX', 'A&B', 'Entwürfe', '📨/Privat & Büro', '日本語']) assert.equal(decodeMailbox(encodeMailbox(path)), path);
  assert.throws(() => encodeMailbox('Archive\nINBOX'), /control/);
});

test('RFC 2047 encoded words support UTF-8, ISO-8859-1 and adjacent folding', () => {
  assert.equal(decodeHeader('=?UTF-8?B?R3LDvMOfZQ==?='), 'Grüße');
  assert.equal(decodeHeader('=?ISO-8859-1?Q?Andr=E9?='), 'André');
  assert.equal(decodeHeader('=?UTF-8?Q?Hallo_?=\r\n =?UTF-8?Q?Welt?='), 'Hallo Welt');
});

test('RFC 2231 filenames join bytes before decoding and prefer extended parameters', () => {
  const parameters = parameterized("attachment; filename*=utf-8''Gr%C3%BC%C3%9Fe.txt; filename=old.txt");
  assert.equal(parameters.params.filename, 'Grüße.txt');
  assert.equal(parameterized("attachment; filename*0*=utf-8''Gr%C3; filename*1*=%BC%C3%9Fe.txt").params.filename, 'Grüße.txt');
  assert.equal(parameterized('attachment; filename="a;b.txt"').params.filename, 'a;b.txt');
});

test('address lists preserve quoted commas and group addresses', () => {
  assert.deepEqual(parseAddresses('Team: "Doe, Jane" <jane@example.com>, sender@example.com;'), [
    { name: 'Doe, Jane', address: 'jane@example.com' }, { address: 'sender@example.com' },
  ]);
});

test('nested multipart alternative/related parses text, HTML and inline bytes', async () => {
  const raw = Buffer.from('Subject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=\r\nReply-To: Sender <sender@example.com>\r\nReferences: <a@b> <c@d>\r\nContent-Type: multipart/related; boundary="outer"\r\n\r\nPreamble\r\n--outer\r\nContent-Type: multipart/alternative; boundary="inner"\r\n\r\n--inner\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nGr=FC=DFe\r\n--inner\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Grüße</p>\r\n--inner--\r\n--outer\r\nContent-Type: image/png\r\nContent-ID: <image-1>\r\nContent-Disposition: inline; filename*=utf-8\'\'Bild%C3%A4.png\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECAw==\r\n--outer--\r\nEpilogue');
  const parsed = await parseMail(raw);
  assert.equal(parsed.subject, 'Grüße'); assert.equal(parsed.text, 'Grüße');
  assert.equal(parsed.html, '<p>Grüße</p>'); assert.equal(parsed.attachments[0].filename, 'Bildä.png');
  assert.deepEqual(parsed.attachments[0].content, Buffer.from([0, 1, 2, 3]));
  assert.equal(parsed.attachments[0].contentId, '<image-1>');
  assert.deepEqual(parsed.references, ['<a@b>', '<c@d>']);
});

test('multipart boundaries must be full lines, not a substring of message text', async () => {
  const parsed = await parseMail(Buffer.from('Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nHello --b world\r\n--b--\r\n'));
  assert.equal(parsed.text, 'Hello --b world');
});

test('malformed multipart and unknown transfer encodings fail explicitly', async () => {
  await assert.rejects(parseMail(Buffer.from('Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\n\r\ntruncated')), /Incomplete/);
  await assert.rejects(parseMail(Buffer.from('Content-Type: text/plain\r\nContent-Transfer-Encoding: proprietary\r\n\r\nhello')), /Unsupported/);
});

test('unknown charsets produce an explicit warning rather than silent substitution', async () => {
  const parsed = await parseMail(Buffer.from('Content-Type: text/plain; charset=x-unknown\r\n\r\nhello'));
  assert.equal(parsed.text, 'hello'); assert.match(parsed.warnings[0], /Unsupported charset/);
});

test('attached .eml stays a separate attachment and does not overwrite the parent body', async () => {
  const parsed = await parseMail(Buffer.from('Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nParent\r\n--b\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename=forward.eml\r\n\r\nSubject: Child\r\n\r\nChild body\r\n--b--\r\n'));
  assert.equal(parsed.text, 'Parent'); assert.equal(parsed.attachments[0].contentType, 'message/rfc822');
  assert.match(parsed.attachments[0].content.toString(), /Subject: Child/);
});
