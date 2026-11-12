import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// Run against an unpacked tarball, not the development checkout.
const root = resolve(process.argv[2] ?? 'package');
let count = 0;
async function inspect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    assert.ok(!entry.isSymbolicLink(), `Symlink in package: ${relative}`);
    if (entry.isDirectory()) {
      assert.ok(relative === 'dist' || relative.startsWith('dist/'), `Unexpected directory: ${relative}`);
      await inspect(join(directory, entry.name), relative + '/');
    } else {
      assert.ok(['package.json', 'README.md', 'LICENSE'].includes(relative) ||
        /^dist\/(nodes|credentials|examples)\/.+\.(js|json|svg)$/.test(relative), `Unexpected file: ${relative}`);
      const text = await readFile(join(directory, entry.name), 'utf8');
      assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text), `Private key: ${relative}`);
      assert.ok(!/[A-Z]:[\\/]Users[\\/]|\/(?:root|home\/(?!node\/)[^/\s]+)\/|sourceMappingURL=/.test(text), `Local path or source map: ${relative}`);
      count++;
    }
  }
}
await inspect(root);
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.deepEqual(manifest.dependencies, {});
console.log(`Checked ${count} npm files: runtime, general examples, README and license only.`);
