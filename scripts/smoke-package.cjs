const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] ?? '.');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packagedExamples = path.join(root, 'dist', 'examples');
const usePackagedExamples = fs.existsSync(packagedExamples);
const examples = usePackagedExamples ? packagedExamples : path.join(root, 'examples');
const registered = new Set();
for (const relative of manifest.n8n.nodes) {
  const absolute = path.join(root, relative);
  const className = path.basename(relative).split('.')[0];
  const Node = require(absolute)[className];
  assert.equal(typeof Node, 'function', `Missing node class ${className}`);
  const instance = new Node();
  assert.ok(instance.description.name);
  assert.ok(fs.existsSync(path.join(path.dirname(absolute), instance.description.icon.replace('file:', ''))));
  for (const credential of instance.description.credentials) {
    assert.equal(typeof instance.methods.credentialTest[credential.testedBy], 'function');
  }
  registered.add(`${manifest.name}.${instance.description.name}`);
  if (!usePackagedExamples) registered.add(`CUSTOM.${instance.description.name}`);
}
for (const relative of manifest.n8n.credentials) {
  const className = path.basename(relative).split('.')[0];
  const instance = new (require(path.join(root, relative))[className])();
  assert.equal(instance.name, 'iCloudMailImap');
  assert.ok(instance.properties.find((property) => property.name === 'password').typeOptions.password);
}
for (const name of fs.readdirSync(examples)) {
  const workflow = JSON.parse(fs.readFileSync(path.join(examples, name), 'utf8'));
  assert.equal(workflow.active, false);
  assert.deepEqual(workflow.pinData ?? {}, {});
  for (const node of workflow.nodes) {
    assert.equal(node.credentials, undefined);
    if (node.parameters.operation === 'move') assert.equal(node.disabled, true);
    if (!node.type.startsWith('n8n-nodes-base.')) assert.ok(registered.has(node.type), `Unknown type in ${name}: ${node.type}`);
  }
}
console.log(`Package smoke check passed: ${manifest.name}@${manifest.version}; 2 nodes, credentials, icons and example registrations load.`);
