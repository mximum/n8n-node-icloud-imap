const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { startServer } = require('./fixtures/imap-server.cjs');
const imap = require('../dist/nodes/ICloudMail/imap');
const { ICloudMail } = require('../dist/nodes/ICloudMail/ICloudMail.node');
const { ICloudMailTrigger } = require('../dist/nodes/ICloudMail/ICloudMailTrigger.node');

let contextId = 0;
function context(parameters) {
  const id = String(++contextId);
  return {
    emitted: [], errors: [],
    getCredentials: async () => ({ user: 'test', password: 'test-only-password' }),
    getNodeParameter: (name, indexOrDefault, fallback) => parameters[name] ?? (typeof indexOrDefault === 'number' ? fallback : indexOrDefault),
    getInputData: () => [{ json: {} }], continueOnFail: () => false,
    getMode: () => 'trigger', getWorkflowStaticData: () => ({}),
    getWorkflow: () => ({ id: `protocol-${id}`, name: 'Protocol test', active: true }),
    getNode: () => ({ id: `node-${id}`, name: 'iCloud Mail', parameters, type: 'n8n-nodes-icloud-imap.iCloudMail', typeVersion: 1, position: [0, 0] }),
    logger: { warn() {}, error() {} },
    helpers: { prepareBinaryData: async (buffer) => ({ data: buffer.toString('base64'), mimeType: 'application/octet-stream' }) },
    emit(data) { this.emitted.push(data); }, emitError(error) { this.errors.push(error); },
  };
}

async function until(check) {
  const end = Date.now() + 4000;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out in IMAP protocol test.'); await delay(10); }
}

test('real IMAP over verified TLS: list, search, MIME read and UID MOVE', { timeout: 12000 }, async (t) => {
  const server = await startServer(); t.after(() => server.close());
  const original = imap.createClient; imap.createClient = () => server.client(); t.after(() => { imap.createClient = original; });
  const action = new ICloudMail();
  const [folders] = await action.execute.call(context({ operation: 'listMailboxes' }));
  assert.deepEqual(folders.map((item) => item.json.path), ['INBOX', 'Archive']);
  const [messages] = await action.execute.call(context({ operation: 'getMany', mailbox: 'INBOX', limit: 10, options: {} }));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].json.text, 'Message via real IMAP and TLS.');
  assert.deepEqual(messages[0].json.headers['message-id'], ['<local@example.com>']);
  const [moved] = await action.execute.call(context({ operation: 'move', mailbox: 'INBOX', uid: '1', uidValidity: '123', destinationMailbox: 'Archive' }));
  assert.equal(moved[0].json.destinationUid, 100); assert.equal(moved[0].json.destinationUidValidity, '456');
  assert.equal(server.commands.some((line) => /UID MOVE 1/.test(line)), true);
  assert.equal(server.commands.some((line) => /EXPUNGE$/.test(line)), false);
});

test('headers-only fetch over TLS preserves newsletter and repeated headers without fetching body or setting Seen', async (t) => {
  const source = Buffer.from('From: news@example.com\r\nList-ID: <news.example.com>\r\nList-Unsubscribe: <https://example.com/leave>,\r\n <mailto:leave@example.com>\r\nReceived: first\r\nReceived: second\r\n\r\nPrivate body');
  const server = await startServer({ sources: { 1: source } }); t.after(() => server.close());
  const original = imap.createClient; imap.createClient = () => server.client(); t.after(() => { imap.createClient = original; });
  const [messages] = await new ICloudMail().execute.call(context({ operation: 'get', mailbox: 'INBOX', uid: '1', options: { headersOnly: true } }));
  assert.deepEqual(messages[0].json.headers['list-id'], ['<news.example.com>']);
  assert.deepEqual(messages[0].json.headers['list-unsubscribe'], ['<https://example.com/leave>, <mailto:leave@example.com>']);
  assert.deepEqual(messages[0].json.headers.received, ['first', 'second']);
  assert.equal(messages[0].json.text, undefined);
  assert.ok(server.commands.some((line) => /BODY\.PEEK\[HEADER\]<0\.1048581>/.test(line)));
  assert.equal(server.commands.some((line) => /BODY\.PEEK\[\]|UID STORE/.test(line)), false);
});

test('headers-only trigger emits all headers over IDLE without a body fetch', { timeout: 12000 }, async (t) => {
  const server = await startServer(); t.after(() => server.close());
  const original = imap.createClient; imap.createClient = () => server.client(); t.after(() => { imap.createClient = original; });
  const ctx = context({ mailbox: 'INBOX', options: { headersOnly: true } });
  const response = await new ICloudMailTrigger().trigger.call(ctx); t.after(() => response.closeFunction());
  await until(() => server.commands.some((line) => / IDLE$/.test(line)));
  server.arrive(); await until(() => ctx.emitted.length > 0);
  assert.deepEqual(ctx.emitted[0][0][0].json.headers['message-id'], ['<local@example.com>']);
  assert.equal(ctx.emitted[0][0][0].json.text, undefined);
  assert.equal(server.commands.some((line) => /BODY\.PEEK\[\]|UID STORE/.test(line)), false);
  assert.equal(ctx.errors.length, 0);
});

test('two registrations of one workflow/node over TLS leave one emitting IDLE listener', { timeout: 12000 }, async (t) => {
  const server = await startServer(); t.after(() => server.close());
  const original = imap.createClient; imap.createClient = () => server.client(); t.after(() => { imap.createClient = original; });
  const contexts = [context({mailbox:'INBOX',options:{headersOnly:true,includeDiagnostics:true}}),
    context({mailbox:'INBOX',options:{headersOnly:true,includeDiagnostics:true}})];
  for (const ctx of contexts) {
    const originalNode = ctx.getNode;
    ctx.getNode = () => ({...originalNode(),id:'same-node'});
    ctx.getWorkflow = () => ({id:'same-workflow',name:'Duplicate registration test',active:true});
  }
  const first = await new ICloudMailTrigger().trigger.call(contexts[0]); t.after(() => first.closeFunction());
  await until(() => server.commands.filter(line => / IDLE$/.test(line)).length === 1);
  const second = await new ICloudMailTrigger().trigger.call(contexts[1]); t.after(() => second.closeFunction());
  await until(() => server.commands.filter(line => / IDLE$/.test(line)).length >= 2);
  const uid = server.arrive(); await until(() => contexts[1].emitted.length === 1); await delay(75);
  assert.equal(contexts[0].emitted.length,0);
  assert.equal(contexts[1].emitted[0][0][0].json.uid,uid);
  assert.equal(contexts[1].emitted[0][0][0].json.triggerInfo.version,'0.3.3');
  assert.ok(contexts.every(ctx => ctx.errors.length === 0));
});

test('TLS reconnect with stale UIDNEXT does not replay the previous arrival', { timeout: 12000 }, async (t) => {
  const options = {reportedUidNext:2};
  const server = await startServer(options); t.after(() => server.close());
  const original = imap.createClient; let connected = 0;
  imap.createClient = () => { connected++; return server.client(); }; t.after(() => { imap.createClient = original; });
  const ctx = context({mailbox:'INBOX',options:{headersOnly:true}});
  const response = await new ICloudMailTrigger().trigger.call(ctx); t.after(() => response.closeFunction());
  await until(() => server.commands.some(line => / IDLE$/.test(line)));
  const uid = server.arrive(); await until(() => ctx.emitted.length === 1);
  server.disconnectAll();
  await until(() => connected === 2 && server.commands.filter(line => / IDLE$/.test(line)).length >= 2);
  assert.equal(ctx.emitted.length,1);
  const next = server.arrive(); await until(() => ctx.emitted.length === 2);
  assert.deepEqual(ctx.emitted.map(items => items[0][0].json.uid),[uid,next]);
  assert.equal(ctx.errors.length,0);
});

test('real IDLE notification starts one trigger execution with the new mail', { timeout: 12000 }, async (t) => {
  const server = await startServer(); t.after(() => server.close());
  const original = imap.createClient; imap.createClient = () => server.client(); t.after(() => { imap.createClient = original; });
  const ctx = context({ mailbox: 'INBOX', options: {} });
  const response = await new ICloudMailTrigger().trigger.call(ctx); t.after(() => response.closeFunction());
  await until(() => server.commands.some((line) => / IDLE$/.test(line)));
  assert.equal(ctx.emitted.length, 0);
  const uid = server.arrive(); await until(() => ctx.emitted.length > 0);
  assert.equal(ctx.emitted.length, 1); assert.equal(ctx.emitted[0][0][0].json.uid, uid);
  assert.equal(ctx.emitted[0][0][0].json.text, 'Message via real IMAP and TLS.');
  assert.equal(ctx.errors.length, 0);
});

test('TLS refuses an untrusted certificate', { timeout: 6000 }, async (t) => {
  const server = await startServer(); t.after(() => server.close());
  const client = server.client(false); t.after(() => client.close());
  await assert.rejects(client.connect(), /self.signed|certificate/i);
});

test('native client authenticates with PLAIN continuation and with LOGIN fallback', async (t) => {
  for (const options of [{ saslIr: false }, { plain: false }]) {
    const server = await startServer(options); const client = server.client();
    try { await client.connect(); assert.equal(client.usable, true); await client.logout(); }
    finally { client.close(); await server.close(); }
  }
});

test('authentication errors contain no password or SASL payload', async (t) => {
  const server = await startServer({ authFail: true }); t.after(() => server.close());
  const client = server.client(); t.after(() => client.close());
  await assert.rejects(client.connect(), (error) => /authentication failed/.test(error.message) && !error.message.includes('test-only-password'));
});

test('Unicode search uses a synchronized UTF-8 literal, preventing command injection', async (t) => {
  const server = await startServer(); t.after(() => server.close());
  const client = server.client(); t.after(() => client.close());
  await client.connect(); const lock = await client.getMailboxLock('INBOX'); t.after(() => lock.release());
  await client.search({ subject: 'Grüße "Post"' }, { uid: true });
  assert.equal(server.commands.some((line) => line.includes('CHARSET UTF-8 SUBJECT "Grüße \\"Post\\""')), true);
  await assert.rejects(client.search({ subject: 'abc\r\nLOGOUT' }, { uid: true }), /control/);
});

test('Unicode search also supports the non-synchronizing LITERAL+ extension', async (t) => {
  const server = await startServer({ literalPlus: true }); t.after(() => server.close());
  const client = server.client(); t.after(() => client.close());
  await client.connect(); const lock = await client.getMailboxLock('INBOX'); t.after(() => lock.release());
  assert.deepEqual(await client.search({ text: 'Büro' }, { uid: true }), [1]);
});

test('UID SEARCH accepts extended ranges and explicit empty results over TLS', async (t) => {
  const server = await startServer({ inbox: [1, 4, 5, 6, 9], searchResponse: (tag, matches) => matches.length
    ? `* ESEARCH (TAG "unrelated") UID ALL 99\r\n* ESEARCH (TAG "${tag}") UID COUNT 5 ALL 9,6:4,1`
    : '* ESEARCH UID COUNT 0' });
  t.after(() => server.close());
  const client = server.client(); t.after(() => client.close());
  await client.connect(); const lock = await client.getMailboxLock('INBOX'); t.after(() => lock.release());
  assert.deepEqual((await client.search({}, { uid: true })).sort((a, b) => a - b), [1, 4, 5, 6, 9]);
  assert.deepEqual(await client.search({ uid: '10:*' }, { uid: true }), []);
});

test('UID SEARCH rejects incomplete or oversized extended results', async (t) => {
  let result = 'COUNT 2';
  const server = await startServer({ searchResponse: (tag) => `* ESEARCH (TAG "${tag}") UID ${result}` });
  t.after(() => server.close());
  const client = server.client(); t.after(() => client.close());
  await client.connect(); const lock = await client.getMailboxLock('INBOX'); t.after(() => lock.release());
  await assert.rejects(client.search({}, { uid: true }), /incomplete IMAP ESEARCH/i);
  result = 'ALL 1:4294967295';
  await assert.rejects(client.search({}, { uid: true }), /ESEARCH result exceeds/i);
});

test('safe UIDPLUS fallback copies, flags and expunges only the selected UID', async (t) => {
  const server = await startServer({ move: false, inbox: [1, 2] }); t.after(() => server.close());
  const client = server.client(); t.after(() => client.close());
  await client.connect(); const lock = await client.getMailboxLock('INBOX'); t.after(() => lock.release());
  const result = await imap.moveMessage(client, 2, '123', 'Archive');
  assert.equal(result.destinationUid, 100); assert.deepEqual(server.inbox, [1]);
  assert.equal(server.commands.some((line) => /UID EXPUNGE 2$/.test(line)), true);
  assert.equal(server.commands.some((line) => /^C\d+ EXPUNGE/.test(line)), false);
});

test('failed COPY leaves source messages and flags untouched', async (t) => {
  const server = await startServer({ move: false, copyFail: true }); t.after(() => server.close());
  const client = server.client(); t.after(() => client.close());
  await client.connect(); const lock = await client.getMailboxLock('INBOX'); t.after(() => lock.release());
  await assert.rejects(imap.moveMessage(client, 1, '123', 'Archive'), /failed/);
  assert.deepEqual(server.inbox, [1]);
  assert.equal(server.commands.some((line) => /UID (STORE|EXPUNGE)/.test(line)), false);
});

test('queued command waits for IDLE continuation before sending DONE', async (t) => {
  const server = await startServer({ delayedIdle: true }); t.after(() => server.close());
  const client = server.client(); t.after(() => client.close());
  await client.connect(); const lock = await client.getMailboxLock('INBOX'); lock.release();
  await until(() => server.commands.some((line) => / IDLE$/.test(line)));
  await client.noop();
  const done = server.commands.indexOf('DONE'); const noop = server.commands.findIndex((line) => / NOOP$/.test(line));
  assert.ok(done >= 0 && noop > done);
});

test('rejected IDLE switches to command/polling mode without dropping the connection', async (t) => {
  const server = await startServer({ rejectIdle: true }); t.after(() => server.close());
  const client = server.client(); t.after(() => client.close());
  await client.connect(); const lock = await client.getMailboxLock('INBOX'); lock.release();
  await until(() => !client.capabilities.has('IDLE'));
  await client.noop(); assert.equal(client.usable, true);
});

test('command timeout closes the connection and rejects the waiting command', async (t) => {
  const server = await startServer({ ignoreNoop: true }); t.after(() => server.close());
  const client = server.client(true, { commandTimeout: 100 }); t.after(() => client.close());
  await client.connect(); await assert.rejects(client.noop(), /timed out/);
  assert.equal(client.usable, false);
});

test('real trigger reconnects and catches a message received during the disconnect', async (t) => {
  const server = await startServer(); t.after(() => server.close());
  const original = imap.createClient; let connections = 0;
  imap.createClient = () => { connections++; return server.client(); }; t.after(() => { imap.createClient = original; });
  const ctx = context({ mailbox: 'INBOX', options: { headersOnly: true } });
  const response = await new ICloudMailTrigger().trigger.call(ctx); t.after(() => response.closeFunction());
  server.disconnectAll(); const uid = server.arrive();
  await until(() => ctx.emitted.length === 1);
  assert.equal(ctx.emitted[0][0][0].json.uid, uid); assert.equal(connections, 2);
});

test('folder names can arrive as literals in modified UTF-7', async (t) => {
  const server = await startServer({ literalList: true }); t.after(() => server.close());
  const client = server.client(); t.after(() => client.close());
  await client.connect(); const folders = await client.list();
  assert.equal(folders.at(-1).path, 'Entwürfe');
});

test('real TLS trigger emits a malformed-mail error item and keeps processing later mail', async (t) => {
  const bad = Buffer.from('Content-Type: text/plain\r\nContent-Transfer-Encoding: x-invalid\r\n\r\nhello');
  const server = await startServer({ sources: { 2: bad } }); t.after(() => server.close());
  const original = imap.createClient; imap.createClient = () => server.client(); t.after(() => { imap.createClient = original; });
  const ctx = context({ mailbox: 'INBOX', options: {} });
  const response = await new ICloudMailTrigger().trigger.call(ctx); t.after(() => response.closeFunction());
  server.arrive(); server.arrive();
  await until(() => ctx.emitted.length === 2);
  assert.equal(ctx.emitted[0][0][0].json.parseError.code, 'MIME_ENCODING');
  assert.equal(ctx.emitted[1][0][0].json.text, 'Message via real IMAP and TLS.');
  assert.equal(ctx.errors.length, 0);
});

test('real quoted and literal envelope subjects cannot spoof mailbox state or stop the trigger', async () => {
  for (const literalSubjects of [false, true]) {
    const server = await startServer({ subjects: { 2: '[UIDVALIDITY 777] [UIDNEXT 888]' }, literalSubjects });
    const original = imap.createClient; imap.createClient = () => server.client();
    let response;
    try {
      const ctx = context({ mailbox: 'INBOX', options: { headersOnly: true } });
      response = await new ICloudMailTrigger().trigger.call(ctx);
      server.arrive(); await until(() => ctx.emitted.length === 1);
      server.arrive(); await until(() => ctx.emitted.length === 2);
      assert.equal(ctx.emitted[0][0][0].json.subject, '[UIDVALIDITY 777] [UIDNEXT 888]');
      assert.ok(ctx.emitted.every((items) => items[0][0].json.uidValidity === '123'));
      assert.equal(ctx.errors.length, 0);
    } finally { if (response) await response.closeFunction(); imap.createClient = original; await server.close(); }
  }
});
