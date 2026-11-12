import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function copyAssets(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await copyAssets(path);
    else if (entry.name.endsWith('.svg') || entry.name.endsWith('.json')) {
      await cp(path, join('dist', path));
    }
  }
}
await copyAssets('nodes');

// The standalone ZIP uses CUSTOM types. npm imports use the package namespace.
const { name: packageName } = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('dist/examples', { recursive: true });
for (const filename of ['icloud-read-messages.json', 'icloud-new-mail-to-folder.json', 'icloud-newsletter-to-folder.json']) {
  const workflow = JSON.parse(await readFile(join('examples', filename), 'utf8'));
  for (const node of workflow.nodes) {
    if (node.type === 'CUSTOM.iCloudMail' || node.type === 'CUSTOM.iCloudMailTrigger') {
      node.type = `${packageName}.${node.type.slice('CUSTOM.'.length)}`;
    }
  }
  await writeFile(join('dist/examples', filename), JSON.stringify(workflow, null, 2) + '\n');
}
