const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(process.env.ICLOUD_TEST_RUNTIME_ROOT || path.join(__dirname, '../dist'));
const { parseMail, parseAddresses, MimeParseError } = require(path.join(root, 'nodes/ICloudMail/native/mime'));
const { ImapClient } = require(path.join(root, 'nodes/ICloudMail/native/client'));
const { responseCode } = require(path.join(root, 'nodes/ICloudMail/native/wire'));

function client() {
  const value = new ImapClient({ host: 'unused.invalid', port: 993, secure: true, auth: { user: 'dummy', pass: 'dummy' } });
  value.mailbox = { path: 'INBOX', uidValidity: 123n, uidNext: 2, exists: 1, readOnly: true };
  return value;
}
function multipart(children, boundary = 'b') {
  return Buffer.from(`Content-Type: multipart/mixed; boundary=${boundary}\r\n\r\n` +
    Array.from({ length: children }, () => `--${boundary}\r\n\r\n`).join('') + `--${boundary}--\r\n`);
}

test('hostile header/line inputs complete in a bounded process, with a valid mail control', () => {
  const result = spawnSync(process.execPath, ['--max-old-space-size=96', path.join(__dirname, 'fixtures/security-probe.cjs'), root, 'cpu'],
    { encoding: 'utf8', timeout: 2000, maxBuffer: 32 * 1024 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
});

test('MIME part budget is applied before allocating the next child view', () => {
  const result = spawnSync(process.execPath, ['--max-old-space-size=96', path.join(__dirname, 'fixtures/security-probe.cjs'), root, 'parts'],
    { encoding: 'utf8', timeout: 2000, maxBuffer: 32 * 1024 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
});

test('address comments are linear, nested/escaped comments and quoted parentheses remain valid', () => {
  assert.deepEqual(parseAddresses('Team: "Doe, Jane (Lead)" <jane@example.com>, sender@example.com (outer (nested) \\) ignored);'), [
    { name: 'Doe, Jane (Lead)', address: 'jane@example.com' }, { address: 'sender@example.com' },
  ]);
  assert.throws(() => parseAddresses('sender@example.com (unclosed'), MimeParseError);
  assert.throws(() => parseAddresses('('.repeat(31) + ')'.repeat(31)), /nesting/);
  assert.throws(() => parseAddresses('a'.repeat(65537)), /64 KB/);
  assert.throws(() => parseAddresses('sender@example.com )'), /Unmatched/);
});

test('MIME budget keeps the existing root-plus-999-children boundary', async () => {
  assert.equal((await parseMail(multipart(999))).text, '');
  await assert.rejects(parseMail(multipart(1000)), (error) => error instanceof MimeParseError && error.code === 'MIME_LIMIT');
});

test('nested siblings share one MIME part budget', async () => {
  const inner = (boundary, count) => multipart(count, boundary).toString();
  const raw = Buffer.from('Content-Type: multipart/mixed; boundary=outer\r\n\r\n--outer\r\n' + inner('a', 500) + '\r\n--outer\r\n' + inner('c', 500) + '\r\n--outer--\r\n');
  await assert.rejects(parseMail(raw), /part limit/);
  const accepted = Buffer.from('Content-Type: multipart/mixed; boundary=outer\r\n\r\n--outer\r\n' + inner('a', 400) + '\r\n--outer\r\n' + inner('c', 400) + '\r\n--outer--\r\n');
  assert.equal((await parseMail(accepted)).text, '');
});

test('multipart delimiters keep LF/CRLF, transport padding, preamble and epilogue behavior', async () => {
  for (const eol of ['\n', '\r\n']) {
    const raw = ['Content-Type: multipart/mixed; boundary=b', '', 'preamble', '--b \t', 'Content-Type: text/plain', '', 'hello', '--b--\t ', 'epilogue'].join(eol);
    assert.equal((await parseMail(Buffer.from(raw))).text, 'hello');
  }
});

test('MIME depth remains bounded', async () => {
  let raw = Buffer.from('Content-Type: text/plain\r\n\r\nleaf');
  for (let index = 0; index < 31; index++) raw = Buffer.concat([
    Buffer.from(`Content-Type: multipart/mixed; boundary=b${index}\r\n\r\n--b${index}\r\n`), raw, Buffer.from(`\r\n--b${index}--\r\n`),
  ]);
  await assert.rejects(parseMail(raw), /nesting/);
});

test('only leading OK response codes are extracted as control information', () => {
  assert.deepEqual(responseCode(['* OK [UIDVALIDITY 123] valid']), { tag: '*', name: 'UIDVALIDITY', args: '123' });
  assert.deepEqual(responseCode(['C1 OK [COPYUID 456 1 100] moved']), { tag: 'C1', name: 'COPYUID', args: '456 1 100' });
  for (const text of ['* OK text [UIDVALIDITY 777]', '* NO [UIDVALIDITY 777]', '* OK "[UIDVALIDITY 777]"',
    '* LIST () "/" "[UIDVALIDITY 777]"', '* 1 FETCH (UID 1 ENVELOPE (NIL "[UIDVALIDITY 777]" NIL NIL NIL NIL NIL NIL NIL NIL))']) {
    assert.equal(responseCode([text]), undefined);
  }
  assert.equal(responseCode(['* OK [UIDVALIDITY ', Buffer.from('777'), ']']), undefined);
});

test('quoted/literal envelope data and status prose cannot change UIDVALIDITY or UIDNEXT', () => {
  const value = client();
  const frames = [
    ['* 1 FETCH (UID 1 ENVELOPE (NIL "[UIDVALIDITY 777] [UIDNEXT 888]" NIL NIL NIL NIL NIL NIL NIL NIL))'],
    ['* 1 FETCH (UID 1 BODY[] ', Buffer.from('[UIDVALIDITY 777] [UIDNEXT 888]'), ')'],
    ['* LIST () "/" "[UIDVALIDITY 777]"'], ['* OK normal text [UIDVALIDITY 777]'], ['C1 OK [UIDVALIDITY 777] ignored'],
  ];
  for (const frame of frames) value.receive(frame);
  assert.equal(value.mailbox.uidValidity, 123n); assert.equal(value.mailbox.uidNext, 2);
  value.receive(['* oK [uidvalidity 456] genuine']);
  value.receive(['* OK [UIDNEXT 100] genuine']);
  assert.equal(value.mailbox.uidValidity, 456n); assert.equal(value.mailbox.uidNext, 100);
  value.close();
});

test('recognized malformed UID response codes fail without reinterpreting data', () => {
  for (const code of ['0', '4294967296', '1:2', '12 garbage', '999999999999999999999999999999999999']) {
    const value = client();
    assert.throws(() => value.receive([`* OK [UIDVALIDITY ${code}] bad`]), /Invalid IMAP UID/);
    assert.equal(value.mailbox.uidValidity, 123n); value.close();
  }
});

test('COPYUID mapping ignores unsolicited quoted content and accepts proper status codes', async () => {
  for (const code of ['C1 OK [COPYUID 456 1 100] moved', '* OK [COPYUID 456 1:1 100:100] copied']) {
    const value = client(); value.capabilities.set('MOVE', true);
    value.send = async () => ({ frames: [
      ['* 1 FETCH (UID 1 ENVELOPE (NIL "[COPYUID 999 1 666]" NIL NIL NIL NIL NIL NIL NIL NIL))'], [code],
    ] });
    const result = await value.messageMove(1, 'Archive', { uid: true });
    assert.equal(result.uidValidity, 456n); assert.equal(result.uidMap.get(1), 100); value.close();
  }
});

test('a fake COPYUID in a quoted string alone produces no destination mapping', async () => {
  const value = client(); value.capabilities.set('MOVE', true);
  value.send = async () => ({ frames: [['* LIST () "/" "[COPYUID 999 1 666]"'], ['C1 OK moved']] });
  const result = await value.messageMove(1, 'Archive', { uid: true });
  assert.equal(result.uidMap.size, 0); assert.equal(result.uidValidity, undefined); value.close();
});

test('COPYUID rejects multi-UID mappings for a single-UID operation', async () => {
  const value = client(); value.capabilities.set('MOVE', true);
  value.send = async () => ({ frames: [['C1 OK [COPYUID 456 1:2 100:101] bad']] });
  await assert.rejects(value.messageMove(1, 'Archive', { uid: true }), /Invalid IMAP UID/); value.close();
});
