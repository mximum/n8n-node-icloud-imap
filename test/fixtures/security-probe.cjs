// Bounded regression probe; accepts a dist/custom directory to test exact shipped files.
const assert = require('node:assert/strict');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const root = path.resolve(process.argv[2]);
const mode = process.argv[3];
const { parseMail } = require(path.join(root, 'nodes/ICloudMail/native/mime.js'));

async function main() {
  if (mode === 'control') {
    const parsed = await parseMail(Buffer.from('Subject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello'));
    assert.equal(parsed.subject, 'Grüße'); assert.equal(parsed.text, 'Hello');
    return { mode, subject: parsed.subject, text: parsed.text };
  }
  if (mode === 'cpu') {
    const start = performance.now();
    const folded = '('.repeat(32000).match(/.{1,70}/g).join('\r\n ');
    await assert.rejects(parseMail(Buffer.from('Reply-To: ' + folded + '\r\nContent-Type: text/plain\r\n\r\nx')), /Address|address/);
    const longLine = Buffer.from('Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\n' + ' '.repeat(32000) + 'X\r\n--b--\r\n');
    assert.equal((await parseMail(longLine)).text.at(-1), 'X');
    assert.equal((await parseMail(Buffer.from('Reply-To: Sender (comment) <sender@example.com>\r\nContent-Type: text/plain\r\n\r\nHello'))).text, 'Hello');
    return { mode, milliseconds: performance.now() - start };
  }
  if (mode === 'parts') {
    const raw = Buffer.from('Content-Type: multipart/mixed; boundary=b\r\n\r\n' + '--b\r\n\r\n'.repeat(4000) + '--b--\r\n');
    const original = Buffer.prototype.subarray; let allocatedChildren = 0;
    Buffer.prototype.subarray = function (...args) {
      const result = original.apply(this, args);
      if (result.length === 0 && new Error().stack.includes('at multipart')) allocatedChildren++;
      return result;
    };
    try { await assert.rejects(parseMail(raw), /part limit/); }
    finally { Buffer.prototype.subarray = original; }
    assert.ok(allocatedChildren <= 999, `Created ${allocatedChildren} child views before rejection`);
    return { mode, inputBytes: raw.length, allocatedChildren };
  }
  throw new Error('Unknown security probe.');
}
main().then((result) => process.stdout.write(JSON.stringify(result) + '\n')).catch((error) => {
  process.stderr.write(error.stack + '\n'); process.exitCode = 1;
});
