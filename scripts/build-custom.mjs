import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const destination = `artifacts/custom-${manifest.version}/icloud-imap`;
async function copyRuntime(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name); const to = join(target, entry.name);
    if (entry.isDirectory()) await copyRuntime(from, to);
    else if (/\.(js|json|svg)$/.test(entry.name)) {
      if (entry.name.endsWith('.node.json')) {
        const metadata = JSON.parse(await readFile(from, 'utf8'));
        metadata.node = metadata.node.replace(manifest.name + '.', 'CUSTOM.');
        await writeFile(to, JSON.stringify(metadata, null, 2) + '\n');
      } else await cp(from, to);
    }
  }
}
await copyRuntime('dist/nodes', join(destination, 'nodes'));
await copyRuntime('dist/credentials', join(destination, 'credentials'));
await writeFile(join(destination, 'package.json'), JSON.stringify({
  name: manifest.name, version: manifest.version, type: 'commonjs', private: true,
  description: 'Standalone custom nodes: built-in Node.js modules only.', dependencies: {},
  n8n: {
    n8nNodesApiVersion: 1,
    credentials: ['credentials/ICloudMailImap.credentials.js'],
    nodes: ['nodes/ICloudMail/ICloudMail.node.js', 'nodes/ICloudMail/ICloudMailTrigger.node.js'],
  },
}, null, 2) + '\n');
console.log(`Custom-node files ready: ${destination}`);
