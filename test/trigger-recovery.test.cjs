const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtempSync, readdirSync, readFileSync, mkdirSync, renameSync, rmdirSync, unlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { startServer } = require('./fixtures/imap-server.cjs');
const imap = require('../dist/nodes/ICloudMail/imap');
const { ICloudMailTrigger } = require('../dist/nodes/ICloudMail/ICloudMailTrigger.node');

class Client extends EventEmitter {
  constructor(uids, dates = {}) {
    super();
    this.uids = uids;
    this.dates = dates;
    this.usable = false;
    this.mailbox = { path: 'INBOX', uidValidity: 123n, uidNext: Math.max(0, ...uids) + 1 };
  }
  async connect() { this.usable = true; }
  async getMailboxLock() { return { release() {} }; }
  async noop() {}
  async search() { return this.uids; }
  close() { if (this.usable) { this.usable = false; this.emit('close'); } }
  async fetchOne(uid, query) {
    if (!this.uids.includes(uid)) return false;
    if (query.headers) return { uid, headers: Buffer.from('Subject: Test\r\n\r\n') };
    return { uid, internalDate: this.dates[uid], flags: new Set(), size: 100 };
  }
}

async function until(predicate) {
  const deadline = Date.now() + 4_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for trigger recovery');
    await delay(5);
  }
}

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'icloud-success-'));
  const originalPath = process.env.ICLOUD_IMAP_CHECKPOINT_DIR;
  const originalClient = imap.createClient;
  process.env.ICLOUD_IMAP_CHECKPOINT_DIR = directory;
  const activations = [];
  t.after(async () => {
    for (const activation of activations) await activation.closeFunction();
    imap.createClient = originalClient;
    if (originalPath === undefined) delete process.env.ICLOUD_IMAP_CHECKPOINT_DIR;
    else process.env.ICLOUD_IMAP_CHECKPOINT_DIR = originalPath;
    for (const file of readdirSync(directory)) unlinkSync(join(directory, file));
    rmdirSync(directory);
  });
  const checkpointPath = () => join(directory, readdirSync(directory).find(file => file.endsWith('.json')));
  return {
    checkpointPath,
    read: () => JSON.parse(readFileSync(checkpointPath(), 'utf8')),
    async activate(ctx) {
      const activation = await new ICloudMailTrigger().trigger.call(ctx);
      activations.push(activation);
      return activation;
    },
  };
}

function context(options = {}, state = {}, mode = 'trigger') {
  const warnings = [];
  return {
    runs: [], errors: [], warnings,
    getCredentials: async () => ({ user: 'test', password: 'test-only-password' }),
    getMode: () => mode,
    getWorkflow: () => ({ id: 'recovery-workflow' }),
    getNode: () => ({ id: 'recovery-node', credentials: { iCloudMailImap: { id: 'test-account' } } }),
    getWorkflowStaticData: () => state,
    getNodeParameter: name => name === 'mailbox' ? 'INBOX' : { headersOnly: true, resumeAfterSuccess: true, retryInterval: 1, ...options },
    emit(data, _response, done) { this.runs.push({ uid: data[0][0].json.uid, done }); },
    emitError(error) { this.errors.push(error); },
    logger: { warn(message) { warnings.push(message); } },
  };
}
const uids = ctx => ctx.runs.map(run => run.uid);
const finish = (ctx, index, status = 'success') => ctx.runs[index].done.resolve({ status });

test('after a TLS disconnect, retry the failed UID and drain later arrivals in order from the persisted success checkpoint', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const checkpoint = setup(t);
  let connections = 0;
  imap.createClient = () => { connections++; return server.client(); };
  const ctx = context({ batchSize: 1 });
  const activation = await checkpoint.activate(ctx);
  await until(() => server.commands.some(command => / IDLE$/.test(command)));
  const first = server.arrive();
  await until(() => ctx.runs.length === 1);
  assert.equal(checkpoint.read().lastUid, first - 1);
  server.disconnectAll();
  const second = server.arrive();
  const third = server.arrive();
  await until(() => connections >= 2 && server.commands.filter(command => / IDLE$/.test(command)).length >= 2);
  assert.ok(ctx.warnings.some(message => /IMAP connection closed\. Reconnecting in 1s/.test(message)));
  assert.deepEqual(uids(ctx), [first]);
  finish(ctx, 0, 'error');
  await until(() => ctx.runs.length === 2);
  assert.deepEqual(uids(ctx), [first, first]);
  assert.equal(checkpoint.read().lastUid, first - 1);
  finish(ctx, 1);
  await until(() => ctx.runs.length === 3);
  assert.equal(checkpoint.read().lastUid, first);
  assert.deepEqual(uids(ctx), [first, first, second]);
  finish(ctx, 2);
  await until(() => ctx.runs.length === 4);
  assert.equal(ctx.runs[3].uid, third);
  finish(ctx, 3);
  await until(() => checkpoint.read().lastUid === third);
  await activation.closeFunction();
  const next = server.arrive();
  const restarted = context({ includeExisting: true });
  await checkpoint.activate(restarted);
  await until(() => restarted.runs.length === 1);
  assert.deepEqual(uids(restarted), [next]);
  finish(restarted, 0);
  await until(() => checkpoint.read().lastUid === next);
  assert.deepEqual(ctx.errors, []);
});

test('repeated missing SEARCH results fall back to UID FETCH while keeping the same IDLE connection', async (t) => {
  // Every SEARCH gets only a tagged OK, including when there are new mails.
  const server = await startServer({ searchResponse: () => undefined, deletedUids: [2] });
  t.after(() => server.close());
  const checkpoint = setup(t);
  let connections = 0;
  imap.createClient = () => { connections++; return server.client(); };
  const ctx = context();
  await checkpoint.activate(ctx);
  await until(() => server.commands.some(command => / IDLE$/.test(command)));
  assert.deepEqual(uids(ctx), []);
  assert.equal(checkpoint.read().lastUid, 1);
  server.arrive(); // Flagged as deleted by the fixture.
  const arrived = server.arrive();
  await until(() => ctx.runs.length === 1);
  assert.equal(checkpoint.read().lastUid, 1);
  assert.deepEqual(uids(ctx), [arrived]);
  finish(ctx, 0);
  await until(() => checkpoint.read().lastUid === arrived && server.commands.some(command => /UID FETCH 4:4294967295/.test(command)));
  assert.equal(connections, 1);
  assert.deepEqual(uids(ctx), [arrived]);
  assert.deepEqual(ctx.errors, []);
  assert.deepEqual(ctx.warnings, []);
});

test('retry a transient initial connection failure and resume from the existing activation baseline', async (t) => {
  const checkpoint = setup(t);
  let attempts = 0;
  imap.createClient = () => {
    const client = new Client([1, 2]);
    if (attempts++ === 0) client.connect = async () => { throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }); };
    return client;
  };
  const ctx = context({}, { cursor: { account: 'test-account:test', mailbox: 'INBOX', uidValidity: '123', lastUid: 1 } });
  await checkpoint.activate(ctx);
  await until(() => ctx.runs.length === 1);
  assert.equal(attempts, 2);
  assert.deepEqual(uids(ctx), [2]);
  finish(ctx, 0);
  await until(() => checkpoint.read().lastUid === 2);
  assert.deepEqual(ctx.errors, []);
});

test('initial backfill uses exact inclusive INTERNALDATE and traverses batches of older mail', async (t) => {
  const checkpoint = setup(t);
  const boundary = '2026-11-07T09:00:00Z';
  const dates = { 1: new Date('2026-11-07T08:59:59Z'), 2: new Date(boundary),
    3: new Date('2026-11-07T08:00:00Z'), 4: new Date('2026-11-07T09:00:01Z') };
  imap.createClient = () => new Client([1, 2, 3, 4], dates);
  const ctx = context({ catchUpFrom: boundary, batchSize: 1 },
    { cursor: { account: 'test-account:test', mailbox: 'INBOX', uidValidity: '123', lastUid: 4 } });
  await checkpoint.activate(ctx);
  await until(() => ctx.runs.length === 1);
  assert.deepEqual(uids(ctx), [2]);
  finish(ctx, 0);
  await until(() => ctx.runs.length === 2);
  assert.deepEqual(uids(ctx), [2, 4]);
  finish(ctx, 1);
  await until(() => checkpoint.read().lastUid === 4);
});

test('republishing while a run is in flight preserves its result and does not dispatch it twice', async (t) => {
  const checkpoint = setup(t);
  imap.createClient = () => new Client([1, 2]);
  const first = context({ includeExisting: true });
  await checkpoint.activate(first);
  await until(() => first.runs.length === 1);
  const replacement = context({ includeExisting: true });
  await checkpoint.activate(replacement);
  await delay(25);
  assert.deepEqual(uids(replacement), []);
  finish(first, 0);
  await until(() => replacement.runs.length === 1);
  assert.deepEqual(uids(replacement), [2]);
  finish(replacement, 0);
  await until(() => checkpoint.read().lastUid === 2);
});

test('a paused execution does not advance the checkpoint or get restarted automatically', async (t) => {
  const checkpoint = setup(t);
  imap.createClient = () => new Client([1, 2]);
  const ctx = context({ includeExisting: true });
  await checkpoint.activate(ctx);
  await until(() => ctx.runs.length === 1);
  finish(ctx, 0, 'waiting');
  await until(() => ctx.errors.length === 1);
  assert.match(ctx.errors[0].message, /unresolved/);
  assert.equal(checkpoint.read().lastUid, 0);
  assert.equal(checkpoint.read().blockedUid, 1);
  await assert.rejects(checkpoint.activate(context()), /outcome.*unresolved/i);
  assert.deepEqual(uids(ctx), [1]);
});

test('a changed UIDVALIDITY stops recovery before any message can be skipped or replayed', async (t) => {
  const checkpoint = setup(t);
  imap.createClient = () => new Client([1]);
  const old = await checkpoint.activate(context());
  await old.closeFunction();
  imap.createClient = () => {
    const client = new Client([1, 2]);
    client.mailbox.uidValidity = 456n;
    return client;
  };
  const ctx = context();
  await assert.rejects(checkpoint.activate(ctx), /UIDVALIDITY changed/);
  assert.deepEqual(ctx.runs, []);
  assert.equal(checkpoint.read().uidValidity, '123');
});

test('recover a confirmed result after a write failure without redispatching that UID in the same process', async (t) => {
  const checkpoint = setup(t);
  imap.createClient = () => new Client([1, 2]);
  const ctx = context({ includeExisting: true });
  await checkpoint.activate(ctx);
  await until(() => ctx.runs.length === 1);
  const file = checkpoint.checkpointPath();
  renameSync(file, `${file}.backup`);
  mkdirSync(file);
  try {
    finish(ctx, 0);
    await until(() => ctx.errors.length === 1);
    assert.match(ctx.errors[0].message, /Could not save/);
  } finally {
    rmdirSync(file);
    renameSync(`${file}.backup`, file);
  }
  const replacement = context();
  await checkpoint.activate(replacement);
  await until(() => replacement.runs.length === 1);
  assert.equal(checkpoint.read().lastUid, 1);
  assert.deepEqual(uids(replacement), [2]);
  finish(replacement, 0);
  await until(() => checkpoint.read().lastUid === 2);
});
