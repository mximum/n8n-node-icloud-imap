// Minimal, loopback-only IMAP fixture. TLS credentials are generated per process.
const tls = require('node:tls');
const { ImapClient } = require('../../dist/nodes/ICloudMail/native/client');
const { ephemeralTls } = require('./ephemeral-tls.cjs');

const { cert, key } = ephemeralTls();

async function startServer(options = {}) {
  const sockets = new Set(); const commands = [];
  const inbox = options.inbox ? [...options.inbox] : [1]; let uidNext = Math.max(0, ...inbox) + 1;
  const caps = ['IMAP4rev1', ...(options.plain === false ? [] : ['AUTH=PLAIN']),
    ...(options.saslIr === false ? [] : ['SASL-IR']), 'UIDPLUS', ...(options.move === false ? [] : ['MOVE']),
    ...(options.idle === false ? [] : ['IDLE']), ...(options.literalPlus ? ['LITERAL+'] : [])].join(' ');
  const source = Buffer.from('From: Sender <sender@example.com>\r\nTo: recipient@example.com\r\nSubject: Local TLS mail\r\nMessage-ID: <local@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nMessage via real IMAP and TLS.');
  const server = tls.createServer({ cert, key }, (socket) => {
    options.onConnection?.();
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    socket.write(`* OK [CAPABILITY ${caps}] Test IMAP ready\r\n`);
    let input = ''; let idleTag; let authTag; let prefix = ''; let literalSize = 0;
    const ok = (tag, message = 'done') => socket.write(`${tag} OK ${message}\r\n`);
    socket.on('data', (data) => {
      input += data.toString('latin1');
      while (input.length) {
        if (literalSize) {
          if (input.length < literalSize) return;
          prefix += JSON.stringify(Buffer.from(input.slice(0, literalSize), 'latin1').toString('utf8'));
          input = input.slice(literalSize); literalSize = 0;
        }
        const index = input.indexOf('\r\n'); if (index < 0) return;
        let line = prefix + input.slice(0, index); input = input.slice(index + 2); prefix = '';
        const literal = /\{(\d+)(\+)?\}$/.exec(line);
        if (literal) {
          prefix = line.slice(0, literal.index); literalSize = Number(literal[1]);
          if (!literal[2]) socket.write('+ literal ready\r\n');
          continue;
        }
        if (authTag) { ok(authTag, 'Authenticated'); authTag = undefined; continue; }
        commands.push(line.replace(/AUTHENTICATE PLAIN.*/, 'AUTHENTICATE PLAIN [test credential]').replace(/LOGIN .*/, 'LOGIN [test credential]'));
        if (line === 'DONE') { ok(idleTag, 'IDLE done'); idleTag = undefined; continue; }
        const [tag, raw, ...rest] = line.split(' '); const command = raw?.toUpperCase(); const args = rest.join(' ');
        if (command === 'CAPABILITY') { socket.write(`* CAPABILITY ${caps}\r\n`); ok(tag); }
        else if (command === 'AUTHENTICATE' && args === 'PLAIN') { authTag = tag; socket.write('+ authenticate\r\n'); }
        else if (command === 'AUTHENTICATE' || command === 'LOGIN') {
          if (options.authFail) socket.write(`${tag} NO authentication rejected\r\n`);
          else ok(tag, 'Authenticated');
        }
        else if (command === 'LIST' || command === 'LSUB') {
          if (args.endsWith('""')) socket.write('* LIST (\\Noselect) "/" ""\r\n');
          else {
            socket.write('* LIST (\\Inbox) "/" "INBOX"\r\n* LIST (\\Archive) "/" "Archive"\r\n');
            if (options.literalList) socket.write('* LIST () "/" {12}\r\nEntw&APw-rfe\r\n');
          }
          ok(tag);
        } else if (command === 'SELECT' || command === 'EXAMINE') {
          socket.selected = true;
          socket.write(`* FLAGS (\\Seen \\Deleted)\r\n* ${inbox.length} EXISTS\r\n* OK [UIDVALIDITY 123] valid\r\n`);
          if (!options.omitUidNext) socket.write(`* OK [UIDNEXT ${options.reportedUidNext ?? uidNext}] next\r\n`);
          ok(tag, `[${command === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] selected`);
        } else if (command === 'UID' && args.toUpperCase().startsWith('SEARCH ')) {
          const start = Number(/UID (\d+):\*/i.exec(args)?.[1] ?? 0);
          const matches = inbox.filter((uid) => uid >= start);
          const response = options.searchResponse ? options.searchResponse(tag, matches, args) : `* SEARCH ${matches.join(' ')}`;
          if (response) socket.write(`${response}\r\n`);
          ok(tag);
        } else if (command === 'UID' && /^FETCH \d+:4294967295 \(UID FLAGS\)$/i.test(args)) {
          const start = Number(args.split(' ')[1].split(':')[0]);
          for (const [index, uid] of inbox.entries()) {
            if (uid < start) continue;
            const flags = options.deletedUids?.includes(uid) ? '\\Deleted' : '';
            socket.write(`* ${index + 1} FETCH (UID ${uid} FLAGS (${flags}))\r\n`);
          }
          ok(tag, 'FETCH done');
        } else if (command === 'UID' && args.toUpperCase().startsWith('FETCH ')) {
          const uid = Number(args.split(' ')[1]); const sequence = inbox.indexOf(uid) + 1;
          const messageSource = options.sources?.[uid] ?? source;
          if (sequence) {
            if (/BODY\.PEEK\[HEADER\]/i.test(args)) {
              let end = messageSource.indexOf('\r\n\r\n') + 4;
              if (end < 4) end = messageSource.length;
              const limit = Number(/<0\.(\d+)>/.exec(args)?.[1] ?? end);
              const header = messageSource.subarray(0, Math.min(end, limit));
              socket.write(`* ${sequence} FETCH (UID ${uid} BODY[HEADER]<0> {${header.length}}\r\n`);
              socket.write(header); socket.write(')\r\n');
            } else if (/BODY\.PEEK\[\]/i.test(args)) {
              const partial = /<\d+\.\d+>/.test(args) ? '<0>' : '';
              socket.write(`* ${sequence} FETCH (UID ${uid} BODY[]${partial} {${messageSource.length}}\r\n`);
              socket.write(messageSource); socket.write(')\r\n');
            } else {
              const subject = options.subjects?.[uid] ?? 'Local TLS mail';
              const prefix = `* ${sequence} FETCH (UID ${uid} FLAGS () RFC822.SIZE ${messageSource.length} INTERNALDATE "30-Oct-2026 12:00:00 +0000" ENVELOPE ("Fri, 30 Oct 2026 12:00:00 +0000" `;
              const suffix = ' (("Sender" NIL "sender" "example.com")) NIL NIL ((NIL NIL "recipient" "example.com")) NIL NIL NIL "<local@example.com>"))\r\n';
              if (options.literalSubjects) {
                const bytes = Buffer.from(subject, 'utf8');
                socket.write(prefix + `{${bytes.length}}\r\n`); socket.write(bytes); socket.write(suffix);
              } else socket.write(prefix + '"' + subject.replace(/["\\]/g, '\\$&') + '"' + suffix);
            }
          }
          ok(tag, 'FETCH done');
        } else if (command === 'UID' && args.toUpperCase().startsWith('COPY ')) {
          if (options.copyFail) socket.write(`${tag} NO copy rejected\r\n`);
          else ok(tag, `[COPYUID 456 ${Number(args.split(' ')[1])} 100] COPY done`);
        } else if (command === 'UID' && args.toUpperCase().startsWith('STORE ')) ok(tag, 'STORE done');
        else if (command === 'UID' && args.toUpperCase().startsWith('EXPUNGE ')) {
          const uid = Number(args.split(' ')[1]); const sequence = inbox.indexOf(uid) + 1;
          if (sequence) { inbox.splice(sequence - 1, 1); socket.write(`* ${sequence} EXPUNGE\r\n`); }
          ok(tag, 'UID EXPUNGE done');
        } else if (command === 'UID' && args.toUpperCase().startsWith('MOVE ')) {
          const uid = Number(args.split(' ')[1]); const sequence = inbox.indexOf(uid) + 1;
          if (!sequence) socket.write(`${tag} NO no such UID\r\n`);
          else { inbox.splice(sequence - 1, 1); socket.write(`* ${sequence} EXPUNGE\r\n`); ok(tag, `[COPYUID 456 ${uid} 100] MOVE done`); }
        } else if (command === 'IDLE') {
          if (options.rejectIdle) socket.write(`${tag} NO IDLE unavailable\r\n`);
          else {
            idleTag = tag;
            if (options.delayedIdle) setTimeout(() => { if (!socket.destroyed) socket.write('+ idling\r\n'); }, 50);
            else socket.write('+ idling\r\n');
          }
        }
        else if (command === 'NOOP' && options.ignoreNoop) { /* command timeout fixture */ }
        else if (command === 'NOOP' || command === 'CLOSE') ok(tag);
        else if (command === 'LOGOUT') { socket.write('* BYE logging out\r\n'); ok(tag); socket.end(); }
        else socket.write(`${tag} BAD unsupported test command: ${command}\r\n`);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    commands,
    client(trustCertificate = true, overrides = {}) {
      const client = new ImapClient({ host: '127.0.0.1', port: server.address().port,
        secure: true, auth: { user: 'test', pass: 'test-only-password' },
        tls: { ...(trustCertificate ? { ca: cert } : {}), rejectUnauthorized: true },
        logger: false, autoIdleDelay: 50, connectionTimeout: 2000, socketTimeout: 5000, ...overrides });
      client.on('error', () => {}); return client;
    },
    arrive() {
      const uid = uidNext++; inbox.push(uid);
      for (const socket of sockets) if (socket.selected) socket.write(`* ${inbox.length} EXISTS\r\n`);
      return uid;
    },
    disconnectAll() { for (const socket of sockets) socket.destroy(); },
    inbox,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
module.exports = { startServer };
