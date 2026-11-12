const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const path = require('node:path');
const root = path.resolve(process.env.ICLOUD_TEST_RUNTIME_ROOT || path.join(__dirname, '../dist'));
const imap = require(path.join(root, 'nodes/ICloudMail/imap'));
const { ICloudMailTrigger } = require(path.join(root, 'nodes/ICloudMail/ICloudMailTrigger.node'));
const { selectCursor } = require(path.join(root, 'nodes/ICloudMail/cursor'));
const originalCreateClient = imap.createClient;
afterEach(() => { imap.createClient = originalCreateClient; });

class Client extends EventEmitter {
  constructor(uids = [1, 2]) {
    super(); this.uids = uids; this.usable = false;
    this.mailbox = { path: 'INBOX', uidValidity: 1n, uidNext: Math.max(0, ...uids) + 1 };
  }
  async connect() { this.usable = true; }
  close() { const open = this.usable; this.usable = false; if (open) this.emit('close'); }
  async getMailboxLock() { return { release() {} }; }
  async noop() {}
  async search() { return this.uids; } // Include old UIDs to exercise local de-duplication.
  async fetchOne(uid, query) {
    if (!this.uids.includes(uid)) return false;
    if (query.headers) return { uid, headers: Buffer.from('Subject: Test\r\n\r\n') };
    return { uid, flags: new Set(), size: 100, envelope: { subject: 'Test' } };
  }
  arrive(uid) { this.uids.push(uid); this.mailbox.uidNext = uid + 1; this.emit('exists'); }
}
function context(workflow = 'w1', node = 'n1', manual = false, state = {}) {
  return {
    state, emitted: [], errors: [], warnings: [],
    getCredentials: async () => ({ user: 'test', password: 'test-only' }),
    getMode: () => manual ? 'manual' : 'trigger',
    getNodeParameter: (name, fallback) => name === 'mailbox' ? 'INBOX' : name === 'options' ? { headersOnly: true } : fallback,
    getWorkflow: () => ({ id: workflow, name: 'Test', active: true }),
    getNode: () => ({ id: node, name: node, credentials: { iCloudMailImap: { id: 'account' } } }),
    getWorkflowStaticData: () => state,
    emit(data) { this.emitted.push(data); },
    emitError(error) { this.errors.push(error); },
    logger: { warn(message) {}, error() {}, debug() {} },
    helpers: {},
  };
}
async function until(check) {
  const deadline = Date.now() + 2500;
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out'); await delay(5); }
}

test('a second activation of the same workflow/node emits a UID only once', async (t) => {
  const clients = [new Client(), new Client()]; let created = 0;
  imap.createClient = () => clients[created++];
  const first = context(), second = context();
  const r1 = await new ICloudMailTrigger().trigger.call(first); t.after(() => r1.closeFunction());
  const r2 = await new ICloudMailTrigger().trigger.call(second); t.after(() => r2.closeFunction());
  clients[0].arrive(103); clients[1].arrive(103);
  await until(() => first.emitted.length + second.emitted.length > 0); await delay(40);
  assert.equal(first.emitted.length + second.emitted.length, 1);
  assert.equal(first.emitted.length, 0);
  assert.equal(clients[0].usable, false);
  await r1.closeFunction(); // Cleanup of the old activation must not close its replacement.
  clients[1].arrive(104); await until(() => second.emitted.length === 2);
  assert.deepEqual(second.emitted.map(item => item[0][0].json.uid), [103, 104]);
});

test('a superseded activation cannot return late and become a second listener', async (t) => {
  const firstClient = new Client(), secondClient = new Client();
  let release; const gate = new Promise(resolve => { release = resolve; });
  firstClient.connect = async () => { await gate; firstClient.usable = true; };
  let created = 0; imap.createClient = () => [firstClient, secondClient][created++];
  const first = context(), second = context();
  const starting = new ICloudMailTrigger().trigger.call(first);
  t.after(async () => { release(); await (await starting).closeFunction(); });
  await until(() => created === 1);
  const replacement = await new ICloudMailTrigger().trigger.call(second); t.after(() => replacement.closeFunction());
  release(); const old = await starting;
  firstClient.arrive(3); secondClient.arrive(3);
  await until(() => first.emitted.length + second.emitted.length > 0); await delay(40);
  assert.equal(first.emitted.length, 0); assert.equal(second.emitted.length, 1);
  assert.equal(firstClient.usable, false);
  await old.closeFunction(); assert.equal(secondClient.usable, true);
});

test('different workflows/nodes remain independent and manual tests do not replace production', async (t) => {
  const contexts = [context('w1','n1'), context('w2','n1'), context('w1','n2'), context('w1','n1',true)];
  const clients = contexts.map(() => new Client()); let created = 0;
  imap.createClient = () => clients[created++];
  for (const ctx of contexts) { const response = await new ICloudMailTrigger().trigger.call(ctx); t.after(() => response.closeFunction()); }
  clients.forEach(client => client.arrive(3)); await until(() => contexts.every(ctx => ctx.emitted.length === 1));
  assert.ok(clients.slice(0,3).every(client => client.usable));
  assert.equal(clients[3].usable, false);
});

test('cursor is checkpointed before the host snapshots static data in emit', async (t) => {
  const client = new Client(); imap.createClient = () => client;
  const ctx = context(); let savedAtEmit;
  ctx.emit = function(data) { savedAtEmit = JSON.parse(JSON.stringify(this.state)); this.emitted.push(data); };
  const response = await new ICloudMailTrigger().trigger.call(ctx); t.after(() => response.closeFunction());
  client.arrive(3); await until(() => ctx.emitted.length === 1);
  assert.equal(savedAtEmit.cursor.lastUid, 3);
});

test('a synchronous emit failure restores the cursor and allows a clean reactivation', async (t) => {
  const clients = [new Client(), new Client([1,2,3])]; let created = 0;
  imap.createClient = () => clients[created++];
  const ctx = context(); ctx.emit = () => { throw new Error('dispatch failed'); };
  const old = await new ICloudMailTrigger().trigger.call(ctx); t.after(() => old.closeFunction());
  clients[0].arrive(3); await until(() => ctx.errors.length === 1);
  assert.equal(ctx.state.cursor.lastUid, 2);
  const replacement = context('w1','n1',false,ctx.state);
  const response = await new ICloudMailTrigger().trigger.call(replacement); t.after(() => response.closeFunction());
  await until(() => replacement.emitted.length === 1);
  assert.equal(replacement.emitted[0][0][0].json.uid, 3);
});

test('a reconnect with stale UIDNEXT never re-emits an already emitted UID', async (t) => {
  const first = new Client(), second = new Client([1,2,3]); second.mailbox.uidNext = 3;
  const clients = [first,second]; let created = 0; imap.createClient = () => clients[created++];
  const ctx = context(); const response = await new ICloudMailTrigger().trigger.call(ctx); t.after(() => response.closeFunction());
  first.arrive(3); await until(() => ctx.emitted.length === 1);
  first.close(); await until(() => created === 2); await delay(40);
  assert.equal(ctx.emitted.length, 1);
  second.arrive(4); await until(() => ctx.emitted.length === 2);
  assert.deepEqual(ctx.emitted.map(item => item[0][0].json.uid), [3,4]);
});

test('matching UIDVALIDITY keeps the high-water mark even when UIDNEXT regresses', () => {
  const saved = { account:'a', mailbox:'INBOX', uidValidity:'1', lastUid:103 };
  for (const next of [103,100]) assert.equal(selectCursor(saved,'a','INBOX','1',next,false).cursor.lastUid,103);
  assert.equal(selectCursor({...saved,lastUid:4294967296},'a','INBOX','1',4,false).cursor.lastUid,3);
});

test('listener handover retains arrivals that have not yet been scanned', async (t) => {
  const clients = [new Client(),new Client([1,2,3,4])]; let created = 0;
  imap.createClient = () => clients[created++];
  const first = context(), second = context();
  const old = await new ICloudMailTrigger().trigger.call(first); t.after(() => old.closeFunction());
  clients[0].arrive(3); await until(() => first.emitted.length === 1);
  const response = await new ICloudMailTrigger().trigger.call(second); t.after(() => response.closeFunction());
  await until(() => second.emitted.length === 1);
  assert.equal(second.emitted[0][0][0].json.uid,4);
});

test('a slow credential lookup from an old activation cannot replace a newer listener', async (t) => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const first = context(), second = context();
  first.getCredentials = async () => { await gate; return {user:'test',password:'test-only'}; };
  const client = new Client(); let created = 0; imap.createClient = () => {created++;return client;};
  const pending = new ICloudMailTrigger().trigger.call(first);
  t.after(async () => { release(); await (await pending).closeFunction(); });
  const replacement = await new ICloudMailTrigger().trigger.call(second); t.after(() => replacement.closeFunction());
  release(); await pending;
  client.arrive(3); await until(() => second.emitted.length === 1);
  assert.equal(created,1); assert.equal(first.emitted.length,0);
});

test('an activation failure releases the production session', async (t) => {
  const first = context(); first.getCredentials = async () => { throw new Error('credential unavailable'); };
  await assert.rejects(new ICloudMailTrigger().trigger.call(first), /credential unavailable/);
  const client = new Client(); imap.createClient = () => client;
  const second = context(); const response = await new ICloudMailTrigger().trigger.call(second); t.after(() => response.closeFunction());
  client.arrive(3); await until(() => second.emitted.length === 1);
});

test('optional diagnostics identify the listener without exposing account credentials', async (t) => {
  const client = new Client(); imap.createClient = () => client;
  const ctx = context();
  const original = ctx.getNodeParameter;
  ctx.getNodeParameter = (name, fallback) => name === 'options' ? {headersOnly:true,includeDiagnostics:true} : original(name,fallback);
  const response = await new ICloudMailTrigger().trigger.call(ctx); t.after(() => response.closeFunction());
  client.arrive(3); await until(() => ctx.emitted.length === 1);
  client.arrive(4); await until(() => ctx.emitted.length === 2);
  const info = ctx.emitted[0][0][0].json.triggerInfo;
  assert.equal(info.version,'0.3.3'); assert.equal(info.workflowId,'w1'); assert.equal(info.nodeId,'n1');
  assert.equal(info.processId,process.pid); assert.equal(info.mode,'production');
  assert.match(info.sessionId,/^[a-f0-9-]{36}$/);
  assert.deepEqual(ctx.emitted[1][0][0].json.triggerInfo, info);
  assert.equal(JSON.stringify(info).includes('test-only'),false);
});
