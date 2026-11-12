const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, unlinkSync, rmdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

// No test key is checked in or reused. Only the local client trusts this cert.
function ephemeralTls() {
  const directory = mkdtempSync(join(tmpdir(), 'icloud-imap-test-tls-'));
  const keyFile = join(directory, 'key.pem');
  const certFile = join(directory, 'cert.pem');
  try {
    execFileSync(process.env.ICLOUD_TEST_OPENSSL || 'openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout', keyFile, '-out', certFile,
    ], { stdio: 'ignore', timeout: 15000, windowsHide: true });
    return { cert: readFileSync(certFile), key: readFileSync(keyFile) };
  } catch (error) {
    throw new Error('TLS tests require OpenSSL on PATH (or ICLOUD_TEST_OPENSSL).', { cause: error });
  } finally {
    for (const file of [keyFile, certFile]) {
      try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    rmdirSync(directory);
  }
}

module.exports = { ephemeralTls };
