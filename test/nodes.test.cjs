const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const imap = require('../dist/nodes/ICloudMail/imap');
const { selectCursor, newUids } = require('../dist/nodes/ICloudMail/cursor');
const { ICloudMail } = require('../dist/nodes/ICloudMail/ICloudMail.node');
const { ICloudMailTrigger } = require('../dist/nodes/ICloudMail/ICloudMailTrigger.node');
const originalCreateClient = imap.createClient;
afterEach(() => { imap.createClient = originalCreateClient; });

class FakeClient extends EventEmitter {
  constructor(uids = [1, 2]) {
    super();
    this.uids = [...uids];
    this.usable = false;
    this.capabilities = new Map([['MOVE', true], ['UIDPLUS', true]]);
    this.mailbox = { path: 'INBOX', uidValidity: 123n, uidNext: Math.max(0, ...uids) + 1 };
    this.calls = [];
    this.locked = false;
  }
  async connect() { this.usable = true; }
  async logout() { this.close(); }
  close() { const wasOpen = this.usable; this.usable = false; if (wasOpen) this.emit('close'); }
  async noop() { this.calls.push(['noop']); }
  async getMailboxLock(path, options) {
    assert.equal(this.locked, false, 'scans must not overlap');
    this.locked = true;
    this.calls.push(['lock', path, options]);
    return { release: () => { this.locked = false; } };
  }
  async list() { return [{ path: 'INBOX', name: 'INBOX', delimiter: '/', flags: new Set() },
    { path: 'Archive', name: 'Archive', delimiter: '/', flags: new Set(['\\Archive']) }]; }
  async search(query, options) { this.calls.push(['search', query, options]); return [...this.uids]; }
  async searchWithFallback(query) { return this.search(query, { uid: true }); }
  async fetchOne(uid, query, options) {
    this.calls.push(['fetch', uid, query, options]);
    if (!this.uids.includes(uid)) return false;
    if (query.headers) return { uid, seq: 1, headers: this.headerSource ?? Buffer.from(
      'From: Sender <sender@example.com>\r\nSubject: Test message\r\nList-Unsubscribe: <mailto:unsubscribe@example.com>\r\n\r\n') };
    if (query.source) return { uid, seq: 1, source: this.source ?? Buffer.from(
      'From: Sender <sender@example.com>\r\nTo: test@example.com\r\nSubject: Test message\r\nMessage-ID: <test@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello world!') };
    return { uid, seq: 1, size: this.size ?? 200, flags: new Set(),
      envelope: { subject: 'Test message', messageId: '<test@example.com>', from: [{ address: 'sender@example.com' }] } };
  }
  async messageMove(uid, destination, options) {
    this.calls.push(['move', uid, destination, options]);
    this.uids = this.uids.filter((value) => value !== uid);
    return { destination, uidValidity: 456n, uidMap: new Map([[uid, 99]]) };
  }
  async messageFlagsAdd(uid, flags, options) { this.calls.push(['flags', uid, flags, options]); return true; }
  arrive(uid) { this.uids.push(uid); this.mailbox.uidNext = uid + 1; this.emit('exists', { path: 'INBOX', count: this.uids.length }); }
}

let contextId = 0;
function context(parameters = {}, manual = false, state = {}) {
  const id = String(++contextId);
  return {
    state, emitted: [], errors: [], warnings: [],
    getCredentials: async () => ({ user: 'test', password: 'not-a-real-password' }),
    getNodeParameter(name, indexOrDefault, fallback) {
      return parameters[name] ?? (typeof indexOrDefault === 'number' ? fallback : indexOrDefault);
    },
    getInputData: () => [{ json: {} }],
    getWorkflow: () => ({ id: `workflow-${id}`, name: 'Test workflow', active: true }),
    getNode: () => ({ id: `node-${id}`, name: 'iCloud Mail', type: 'n8n-nodes-icloud-imap.iCloudMail', typeVersion: 1,
      position: [0, 0], parameters, credentials: { iCloudMailImap: { id: 'credential-1' } } }),
    continueOnFail: () => false,
    getMode: () => manual ? 'manual' : 'trigger',
    getWorkflowStaticData: () => state,
    emit(data) { this.emitted.push(data); }, emitError(error) { this.errors.push(error); },
    logger: { warn(message) { /* no secrets */ }, error() {}, debug() {} },
    helpers: { prepareBinaryData: async (buffer, fileName, mimeType) => ({ data: buffer.toString('base64'), fileName, mimeType }) },
  };
}

async function until(check, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting for test condition.');
    await delay(5);
  }
}

test('production transport pins verified TLS and the Apple IMAP host', () => {
  const client = originalCreateClient({ user: 'max', password: 'app-password' });
  assert.equal(client.options.host, 'imap.mail.me.com');
  assert.equal(client.options.port, 993);
  assert.equal(client.options.secure, true);
  assert.equal(client.options.tls.rejectUnauthorized, true);
  assert.equal(client.options.logger, false);
  client.close();
});

test('UID validation refuses ranges, wildcards, scientific notation and invalid values', () => {
  assert.equal(imap.parseUid('42'), 42);
  for (const value of ['', '0', '-1', '1:9', '*', '1,2', '1e3', '1.5', '4294967296', null]) {
    assert.throws(() => imap.parseUid(value));
  }
});

test('a failed move is not replayed when the next input item reconnects', async () => {
  const clients = [];
  imap.createClient = () => {
    const client = new FakeClient([1, 2]); clients.push(client);
    const move = client.messageMove.bind(client);
    client.messageMove = async (...args) => {
      if (clients.length === 1) {
        client.calls.push(['failedMove', ...args]);
        throw new Error('Connection lost after MOVE; outcome unknown');
      }
      return move(...args);
    };
    return client;
  };
  const ctx = context({ operation: 'move', mailbox: 'INBOX', uidValidity: '123', destinationMailbox: 'Archive' });
  ctx.getInputData = () => [{ json: {} }, { json: {} }]; ctx.continueOnFail = () => true;
  const param = ctx.getNodeParameter.bind(ctx);
  ctx.getNodeParameter = (name, index, fallback) => name === 'uid' ? String(index + 1) : param(name, index, fallback);
  const [result] = await new ICloudMail().execute.call(ctx);
  assert.match(result[0].json.error, /outcome unknown/);
  assert.equal(clients.length, 2);
  assert.equal(clients[0].calls.filter(c => c[0] === 'failedMove').length, 1);
  assert.deepEqual(clients[1].calls.filter(c => c[0] === 'move').map(c => c[1]), [2]);
  assert.equal(clients.every(c => !c.usable), true);
});

test('UIDVALIDITY mismatch prevents any move', async () => {
  const client = new FakeClient();
  await assert.rejects(imap.moveMessage(client, 1, '999', 'Archive'), /UIDVALIDITY/);
  assert.equal(client.calls.length, 0);
});

test('move uses UIDs and reports the destination UID/validity', async () => {
  const client = new FakeClient();
  const result = await imap.moveMessage(client, 2, '123', 'Archive');
  assert.equal(result.destinationUid, 99);
  assert.equal(result.destinationUidValidity, '456');
  assert.deepEqual(client.calls.find((call) => call[0] === 'move'), ['move', 2, 'Archive', { uid: true }]);
});

test('move refuses same folder, missing messages and unsafe expunge fallback', async () => {
  const client = new FakeClient();
  await assert.rejects(imap.moveMessage(client, 1, '123', 'inbox'), /different/);
  await assert.rejects(imap.moveMessage(client, 10, '123', 'Archive'), /no longer exists/);
  client.capabilities.clear();
  await assert.rejects(imap.moveMessage(client, 1, '123', 'Archive'), /neither MOVE nor UIDPLUS/);
});

test('failed move is not retried', async () => {
  const client = new FakeClient(); let count = 0;
  client.messageMove = async () => { count++; return false; };
  await assert.rejects(imap.moveMessage(client, 1, '123', 'Archive'), /did not confirm/);
  assert.equal(count, 1);
});

test('cursor initializes to new arrivals and can include existing mail explicitly', () => {
  assert.equal(selectCursor(undefined, 'a', 'INBOX', '123', 10, false).cursor.lastUid, 9);
  assert.equal(selectCursor(undefined, 'a', 'INBOX', '123', 10, true).cursor.lastUid, 0);
});

test('saved cursor resumes, UID reset rebaselines, account changes isolate state', () => {
  const saved = { account: 'a', mailbox: 'INBOX', uidValidity: '123', lastUid: 4 };
  assert.equal(selectCursor(saved, 'a', 'INBOX', '123', 10, false).cursor.lastUid, 4);
  const reset = selectCursor(saved, 'a', 'INBOX', '456', 20, true);
  assert.equal(reset.reset, true); assert.equal(reset.cursor.lastUid, 19);
  assert.equal(selectCursor(saved, 'b', 'INBOX', '123', 10, false).cursor.lastUid, 9);
});

test('IMAP reversed n:* responses do not replay old mail; batches sort and deduplicate', () => {
  assert.deepEqual(newUids([2], 99, 50), []);
  assert.deepEqual(newUids([8, 6, 6, 2, 9], 5, 2), [6, 8]);
});

test('search supports unread/address/text/date filters and rejects invalid dates', () => {
  const query = imap.buildSearch({ unreadOnly: true, from: 'max', subject: 'invoice', since: '2026-10-01' });
  assert.equal(query.seen, false); assert.equal(query.deleted, false);
  assert.equal(query.from, 'max'); assert.equal(query.since.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.throws(() => imap.buildSearch({ since: 'broken' }), /Invalid/);
});

test('message parsing returns text and preserves unread flags', async () => {
  const client = new FakeClient();
  const result = await imap.readMessage(context(), client, 1, { headersOnly: false, downloadAttachments: false, maxMessageSizeMB: 25 });
  assert.equal(result.json.text, 'Hello world!');
  assert.equal(result.json.uidValidity, '123');
  assert.deepEqual(result.json.headers['message-id'], ['<test@example.com>']);
  assert.equal(client.calls.some((call) => call[0] === 'flags'), false);
  assert.equal(client.calls.every((call) => call[0] !== 'fetch' || call[3].uid), true);
});

test('headers-only and oversized messages avoid full body downloads', async () => {
  const client = new FakeClient();
  const headerResult = await imap.readMessage(context(), client, 1, { headersOnly: true, downloadAttachments: false, maxMessageSizeMB: 1 });
  assert.deepEqual(headerResult.json.headers['list-unsubscribe'], ['<mailto:unsubscribe@example.com>']);
  assert.equal(headerResult.json.text, undefined);
  client.size = 2 * 1024 * 1024;
  const result = await imap.readMessage(context(), client, 1, { headersOnly: false, downloadAttachments: true, maxMessageSizeMB: 1 });
  assert.equal(result.json.bodySkipped, true);
  assert.deepEqual(result.json.headers.subject, ['Test message']);
  assert.equal(client.calls.some((call) => call[2]?.source), false);
});

test('header failures follow trigger parser policy but missing IMAP headers remain transport errors', async () => {
  const client = new FakeClient();
  const options = { headersOnly: true, downloadAttachments: false, maxMessageSizeMB: 1 };
  client.headerSource = Buffer.alloc(1024 * 1024 + 5, 65);
  await assert.rejects(imap.readMessage(context(), client, 1, options), /header exceeds/);
  const result = await imap.readMessage(context(), client, 1, { ...options, onParseError: 'metadata' });
  assert.equal(result.json.parseError.code, 'MIME_LIMIT');
  client.fetchOne = async (_uid, query) => query.headers ? { uid: 1 } : { uid: 1, size: 200 };
  await assert.rejects(imap.readMessage(context(), client, 1, { ...options, onParseError: 'metadata' }), /header response is missing/);
});

test('valid headers remain available when body MIME parsing fails in trigger mode', async () => {
  const client = new FakeClient();
  client.source = Buffer.from('List-ID: <news.example.com>\r\nContent-Type: multipart/mixed; boundary=missing\r\n\r\ninvalid multipart');
  const result = await imap.readMessage(context(), client, 1,
    { headersOnly: false, downloadAttachments: false, maxMessageSizeMB: 1, onParseError: 'metadata' });
  assert.deepEqual(result.json.headers['list-id'], ['<news.example.com>']);
  assert.equal(result.json.parseError.code, 'MIME_INVALID');
});

test('MIME attachments become n8n binary data', async () => {
  const client = new FakeClient();
  client.source = Buffer.from('From: test@example.com\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nBody\r\n--b\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="test.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--b--\r\n');
  const result = await imap.readMessage(context(), client, 1, { headersOnly: false, downloadAttachments: true, maxMessageSizeMB: 25 });
  assert.equal(result.binary.attachment_0.fileName, 'test.txt');
  assert.equal(Buffer.from(result.binary.attachment_0.data, 'base64').toString(), 'hello');
});

test('Get Many sorts latest first, pairs items, and only marks read when requested', async () => {
  const client = new FakeClient([1, 2, 3]); imap.createClient = () => client;
  const ctx = context({ operation: 'getMany', mailbox: 'INBOX', limit: 2, options: { headersOnly: true, markAsRead: true } });
  const [items] = await new ICloudMail().execute.call(ctx);
  assert.deepEqual(items.map((item) => item.json.uid), [3, 2]);
  assert.deepEqual(items[0].pairedItem, { item: 0 });
  assert.deepEqual(items[0].json.flags, ['\\Seen']);
  assert.equal(client.usable, false); assert.equal(client.locked, false);
});

test('Get missing UID returns a useful error and Continue On Fail preserves pairing', async () => {
  const ctx = context({ operation: 'get', mailbox: 'INBOX', uid: '99', options: {} });
  imap.createClient = () => new FakeClient();
  await assert.rejects(new ICloudMail().execute.call(ctx), /does not exist/);
  ctx.continueOnFail = () => true;
  const [items] = await new ICloudMail().execute.call(ctx);
  assert.match(items[0].json.error, /does not exist/);
  assert.deepEqual(items[0].pairedItem, { item: 0 });
});

test('List Mailboxes exposes exact server folder paths', async () => {
  imap.createClient = () => new FakeClient();
  const [items] = await new ICloudMail().execute.call(context({ operation: 'listMailboxes' }));
  assert.deepEqual(items.map((item) => item.json.path), ['INBOX', 'Archive']);
});

test('trigger emits only new mail, serializes duplicate events and closes cleanly', async (t) => {
  const client = new FakeClient(); imap.createClient = () => client;
  const ctx = context({ mailbox: 'INBOX', options: { headersOnly: true } });
  const response = await new ICloudMailTrigger().trigger.call(ctx);
  t.after(() => response.closeFunction());
  await delay(20); assert.equal(ctx.emitted.length, 0);
  client.arrive(3); client.emit('exists'); client.emit('exists');
  await until(() => ctx.emitted.length === 1);
  await delay(20); assert.equal(ctx.emitted.length, 1);
  assert.equal(ctx.emitted[0][0][0].json.uid, 3); assert.equal(ctx.state.cursor.lastUid, 3);
  await response.closeFunction(); client.arrive(4); await delay(20);
  assert.equal(ctx.emitted.length, 1); assert.equal(client.usable, false);
});

test('trigger catches up all batches from a saved cursor', async (t) => {
  const client = new FakeClient([1, 2, 3, 4, 5]); imap.createClient = () => client;
  const state = { cursor: { account: 'credential-1:test', mailbox: 'INBOX', uidValidity: '123', lastUid: 1 } };
  const ctx = context({ mailbox: 'INBOX', options: { headersOnly: true, batchSize: 2 } }, false, state);
  const response = await new ICloudMailTrigger().trigger.call(ctx); t.after(() => response.closeFunction());
  await until(() => ctx.emitted.length === 4);
  assert.deepEqual(ctx.emitted.map((items) => items[0][0].json.uid), [2, 3, 4, 5]);
});

test('manual test waits for a new arrival without touching production state', async (t) => {
  const client = new FakeClient(); imap.createClient = () => client;
  const state = { cursor: { account: 'credential-1:test', mailbox: 'INBOX', uidValidity: '123', lastUid: 0 } };
  const before = JSON.stringify(state);
  const ctx = context({ mailbox: 'INBOX', options: { headersOnly: true, includeExisting: true } }, true, state);
  const response = await new ICloudMailTrigger().trigger.call(ctx); t.after(() => response.closeFunction());
  await response.manualTriggerFunction(); await delay(20); assert.equal(ctx.emitted.length, 0);
  client.arrive(3); await until(() => ctx.emitted.length === 1);
  assert.equal(JSON.stringify(state), before); assert.equal(client.usable, false);
});

test('trigger reconnect catches mail arriving while disconnected', async (t) => {
  const first = new FakeClient([1]); const second = new FakeClient([1, 2, 3]);
  const clients = [first, second]; let created = 0;
  imap.createClient = () => clients[created++];
  const ctx = context({ mailbox: 'INBOX', options: { headersOnly: true } });
  const response = await new ICloudMailTrigger().trigger.call(ctx); t.after(() => response.closeFunction());
  first.close();
  await until(() => ctx.emitted.length === 2, 2500);
  assert.equal(created, 2);
  assert.deepEqual(ctx.emitted.map((items) => items[0][0].json.uid), [2, 3]);
});

test('trigger initial connection failure closes the client', async () => {
  const client = new FakeClient(); let closed = false;
  client.connect = async () => { throw new Error('Authentication failed'); };
  client.close = () => { closed = true; };
  imap.createClient = () => client;
  await assert.rejects(new ICloudMailTrigger().trigger.call(context({ mailbox: 'INBOX' })), /Authentication/);
  assert.equal(closed, true);
});

test('trigger fetch failure does not advance past the failed message', async (t) => {
  const client = new FakeClient([1]); imap.createClient = () => client;
  const ctx = context({ mailbox: 'INBOX', options: { headersOnly: true } });
  const response = await new ICloudMailTrigger().trigger.call(ctx); t.after(() => response.closeFunction());
  client.fetchOne = async () => { throw new Error('Fetch failure'); };
  client.arrive(2); await until(() => ctx.errors.length === 1);
  assert.equal(ctx.state.cursor.lastUid, 1); assert.equal(ctx.emitted.length, 0);
});

test('trigger emits explicit metadata for malformed MIME and continues to later valid mail', async (t) => {
  const client = new FakeClient([1]); imap.createClient = () => client;
  const fetch = client.fetchOne.bind(client);
  client.fetchOne = async (uid, query, options) => uid === 2 && query.source ? { uid, source: Buffer.from(
    'Content-Type: text/plain\r\nContent-Transfer-Encoding: x-invalid\r\n\r\nhello') } : fetch(uid, query, options);
  const ctx = context({ mailbox: 'INBOX', options: {} });
  const response = await new ICloudMailTrigger().trigger.call(ctx); t.after(() => response.closeFunction());
  client.arrive(2); client.arrive(3);
  await until(() => ctx.emitted.length === 2);
  assert.equal(ctx.emitted[0][0][0].json.uid, 2);
  assert.equal(ctx.emitted[0][0][0].json.parseError.code, 'MIME_ENCODING');
  assert.equal(ctx.emitted[0][0][0].json.bodySkipped, true);
  assert.equal(ctx.emitted[0][0][0].binary, undefined);
  assert.equal(ctx.emitted[1][0][0].json.text, 'Hello world!');
  assert.equal(ctx.state.cursor.lastUid, 3); assert.equal(client.usable, true); assert.equal(ctx.errors.length, 0);
  client.emit('exists'); await delay(20); assert.equal(ctx.emitted.length, 2);
  assert.equal(client.calls.some((call) => call[0] === 'flags' || call[0] === 'move'), false);
});

test('manual trigger returns one parse-error item without changing production cursor', async (t) => {
  const client = new FakeClient([1]); imap.createClient = () => client;
  client.source = Buffer.from('Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\n\r\ntruncated');
  const state = { cursor: { untouched: true } }; const before = JSON.stringify(state);
  const ctx = context({ mailbox: 'INBOX', options: {} }, true, state);
  const response = await new ICloudMailTrigger().trigger.call(ctx); t.after(() => response.closeFunction());
  client.arrive(2); await until(() => ctx.emitted.length === 1);
  assert.equal(ctx.emitted[0][0][0].json.parseError.code, 'MIME_INVALID');
  assert.equal(JSON.stringify(state), before); assert.equal(client.usable, false);
});

test('action MIME errors retain fail and Continue On Fail behavior without marking read', async () => {
  const client = new FakeClient(); client.source = Buffer.from('Content-Transfer-Encoding: invalid\r\n\r\nx');
  imap.createClient = () => client;
  const ctx = context({ operation: 'get', uid: '1', mailbox: 'INBOX', options: { markAsRead: true } });
  await assert.rejects(new ICloudMail().execute.call(ctx), /Unsupported MIME/);
  ctx.continueOnFail = () => true;
  const [items] = await new ICloudMail().execute.call(ctx);
  assert.match(items[0].json.error, /Unsupported MIME/);
  assert.equal(client.calls.some((call) => call[0] === 'flags'), false);
});

test('trigger does not mistake binary-storage failure for malformed MIME', async (t) => {
  const client = new FakeClient([1]); imap.createClient = () => client;
  client.source = Buffer.from('Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=file.bin\r\n\r\nx');
  const ctx = context({ mailbox: 'INBOX', options: { downloadAttachments: true } });
  ctx.helpers.prepareBinaryData = async () => { throw new Error('Storage unavailable'); };
  const response = await new ICloudMailTrigger().trigger.call(ctx); t.after(() => response.closeFunction());
  client.arrive(2); await until(() => ctx.errors.length === 1);
  assert.equal(ctx.emitted.length, 0); assert.equal(ctx.state.cursor.lastUid, 1);
  assert.match(ctx.errors[0].message, /Storage unavailable/);
});

test('a genuine UIDVALIDITY change during move existence check is rejected before mutation', async () => {
  const client = new FakeClient();
  const fetch = client.fetchOne.bind(client);
  client.fetchOne = async (...args) => { const item = await fetch(...args); client.mailbox.uidValidity = 456n; return item; };
  await assert.rejects(imap.moveMessage(client, 1, '123', 'Archive'), /UIDVALIDITY/);
  assert.equal(client.calls.some((call) => call[0] === 'move'), false);
});
