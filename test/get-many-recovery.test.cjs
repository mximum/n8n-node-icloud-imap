const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./fixtures/imap-server.cjs');
const imap = require('../dist/nodes/ICloudMail/imap');
const { ICloudMail } = require('../dist/nodes/ICloudMail/ICloudMail.node');
const { ImapClient, MissingSearchResponseError, ImapCommandError } = require('../dist/nodes/ICloudMail/native/client');

function context(overrides = {}, count = 1) {
  const parameters = { operation: 'getMany', mailbox: 'INBOX', limit: 10, options: { headersOnly: true }, ...overrides };
  return {
    getCredentials: async () => ({ user: 'test', password: 'test-only-password' }),
    getInputData: () => Array.from({ length: count }, () => ({ json: {} })),
    getNodeParameter: (name, index, fallback) => parameters[name] ?? fallback,
    continueOnFail: () => false,
  };
}
async function fixture(t, options) {
  const server = await startServer(options);
  const original = imap.createClient;
  imap.createClient = () => server.client();
  t.after(() => { imap.createClient = original; server.close(); });
  return server;
}

for (const [name, response] of [['SEARCH', '* SEARCH'], ['ESEARCH', '* ESEARCH UID COUNT 0'], ['missing', '']]) {
  test(`Get Many returns no items for an empty mailbox with ${name}`, async (t) => {
    const server = await fixture(t, { inbox: [], searchResponse: () => response });
    assert.deepEqual(await new ICloudMail().execute.call(context()), [[]]);
    assert.equal(server.commands.filter(s => /UID FETCH/.test(s)).length, name === 'missing' ? 1 : 0);
  });
}

test('FETCH fallback excludes Deleted, sorts descending and applies the limit without marking read', async (t) => {
  const server = await fixture(t, { inbox: [2, 8, 4, 6], deletedUids: [8], searchResponse: () => '' });
  const [items] = await new ICloudMail().execute.call(context({ limit: 2 }));
  assert.deepEqual(items.map(item => item.json.uid), [6, 4]);
  assert.equal(server.commands.some(s => /UID STORE|BODY\.PEEK\[\]/.test(s)), false);
});

for (const filters of [{ from: 'sender@example.com' }, { subject: 'test' }, { unreadOnly: true }, { since: '2026-01-01' }, { text: 'hello', to: 'reader@example.com', before: '2026-10-01' }]) {
  test(`missing filtered SEARCH never returns unfiltered mail: ${JSON.stringify(filters)}`, async (t) => {
    const server = await fixture(t, { inbox: [1], searchResponse: () => '' });
    await assert.rejects(new ICloudMail().execute.call(context({ filters })), /Filters were preserved/);
    const searches = server.commands.filter(s => /UID SEARCH/.test(s)).map(s => s.replace(/^\S+ /, ''));
    assert.equal(searches.length, 2); assert.equal(searches[0], searches[1]);
    assert.equal(server.commands.some(s => /BODY|UID STORE/.test(s)), false);
  });
}

test('filtered retry uses the actual search result, including empty results', async (t) => {
  let searches = 0;
  const server = await fixture(t, { inbox: [1, 2], searchResponse: () => ++searches === 1 ? '' : '* SEARCH' });
  assert.deepEqual(await new ICloudMail().execute.call(context({ filters: { subject: 'absent' } })), [[]]);
  assert.equal(server.commands.filter(s => /UID SEARCH/.test(s)).length, 2);
});

test('empty candidate set does not retry filtered SEARCH', async (t) => {
  const server = await fixture(t, { inbox: [1], deletedUids: [1], searchResponse: () => '' });
  assert.deepEqual(await new ICloudMail().execute.call(context({ filters: { unreadOnly: true } })), [[]]);
  assert.equal(server.commands.filter(s => /UID SEARCH/.test(s)).length, 1);
});

for (const inbox of [[], [3, 9]]) {
  test(`missing UIDNEXT and SEARCH are recovered, including deleted UIDs (${inbox.length} mails)`, async (t) => {
    const server = await startServer({ inbox, deletedUids: inbox, omitUidNext: true, searchResponse: () => '' });
    const client = server.client(); t.after(() => { client.close(); server.close(); });
    await client.connect(); const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try { assert.equal(client.mailbox.uidNext, inbox.length ? 10 : 1); }
    finally { lock.release(); }
  });
}

test('Get reuses one TLS connection and mailbox selection for 10 input items', async (t) => {
  let connections = 0;
  const server = await fixture(t, { onConnection: () => connections++ });
  const [items] = await new ICloudMail().execute.call(context({ operation: 'get', uid: '1' }, 10));
  assert.equal(items.length, 10);
  assert.deepEqual(items.map(item => item.pairedItem.item), Array.from({ length: 10 }, (_, i) => i));
  assert.equal(connections, 1);
  assert.equal(server.commands.filter(s => /EXAMINE /.test(s)).length, 1);
  assert.equal(server.commands.filter(s => /AUTHENTICATE /.test(s)).length, 1);
  assert.equal(server.commands.filter(s => /LOGOUT/.test(s)).length, 1);
});

test('connection reuse reselects a different mailbox and read/write mode', async (t) => {
  const server = await fixture(t, {}); const ctx = context({ operation: 'get', uid: '1' }, 3);
  const param = ctx.getNodeParameter;
  ctx.getNodeParameter = (name, index, fallback) => name === 'mailbox' ? ['INBOX', 'Archive', 'Archive'][index]
    : name === 'options' ? { headersOnly: true, markAsRead: index === 2 } : param(name, index, fallback);
  const [items] = await new ICloudMail().execute.call(ctx);
  assert.equal(items.length, 3);
  assert.deepEqual(server.commands.filter(s => / (?:EXAMINE|SELECT) /.test(s)).map(s => s.replace(/^\S+ /, '')),
    ['EXAMINE "INBOX"', 'EXAMINE "Archive"', 'SELECT "Archive"']);
});

test('continue-on-error opens a fresh connection for the next item, without retrying the failed item', async (t) => {
  let connections = 0;
  const server = await fixture(t, { onConnection: () => connections++ }); const ctx = context({ operation: 'get' }, 2);
  ctx.continueOnFail = () => true; const param = ctx.getNodeParameter;
  ctx.getNodeParameter = (name, index, fallback) => name === 'uid' ? (index === 0 ? '999' : '1') : param(name, index, fallback);
  const [items] = await new ICloudMail().execute.call(ctx);
  assert.match(items[0].json.error, /does not exist/); assert.equal(items[1].json.uid, 1);
  assert.deepEqual(items.map(item => item.pairedItem.item), [0, 1]);
  assert.equal(connections, 2);
  assert.equal(server.commands.filter(s => /UID FETCH 999 /.test(s)).length, 1);
});

test('SEARCH fallback propagates command/connection failures instead of converting them to empty results', async () => {
  const client = new ImapClient({ host: 'unused', port: 993, secure: true, auth: { user: 'test', pass: 'test' } });
  const failure = new ImapCommandError('NO', 'SEARCH');
  client.search = async () => { throw failure; };
  await assert.rejects(client.searchWithFallback({ deleted: false }), e => e === failure);
  client.search = async () => { throw new MissingSearchResponseError(); };
  client.fetchUidsAfter = async () => { throw new Error('connection lost'); };
  await assert.rejects(client.searchWithFallback({ deleted: false }), /connection lost/);
  client.mailbox = { uidValidity: 1n };
  client.fetchUidsAfter = async () => { client.mailbox.uidValidity = 2n; return []; };
  await assert.rejects(client.searchWithFallback({ deleted: false }), /UIDVALIDITY changed/);
});

test('FETCH fallback rejects missing flags and propagates response size limits', async () => {
  const client = new ImapClient({ host: 'unused', port: 993, secure: true, auth: { user: 'test', pass: 'test' } });
  client.run = async () => ({ frames: [['* 1 FETCH (UID 1)']] });
  await assert.rejects(client.fetchUndeletedUidsAfter(0), /missing FLAGS/);
  client.run = async () => { throw new Error('IMAP response exceeds the configured byte limit.'); };
  await assert.rejects(client.fetchUndeletedUidsAfter(0), /byte limit/);
});
