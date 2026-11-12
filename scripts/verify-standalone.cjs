const { builtinModules, Module } = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const root = path.resolve(process.argv[2]);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.n8n.n8nNodesApiVersion, 1);
assert.equal(manifest.n8n.nodes.length, 2);
assert.equal(manifest.n8n.credentials.length, 1);
for (const file of [...manifest.n8n.nodes, ...manifest.n8n.credentials]) {
  assert.ok(fs.existsSync(path.join(root, file)), `Missing manifest target: ${file}`);
}
// Match the recursive discovery used by n8n's CustomDirectoryLoader. This is
// a filesystem check, not a substitute for starting a complete n8n instance.
function discover(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules') return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? discover(file) : /\.(node|credentials)\.js$/.test(entry.name) ? [file] : [];
  }).sort();
}
const expected = [...manifest.n8n.nodes, ...manifest.n8n.credentials].map(file => path.join(root, file)).sort();
assert.deepEqual(discover(root), expected, 'Direct package path discovery');
assert.deepEqual(discover(path.dirname(root)), expected, 'Parent custom directory discovery');
const original = Module._load;
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
let count = 0;
Module._load = function (request, ...rest) {
  if (!builtins.has(request) && !request.startsWith('.') && !path.isAbsolute(request)) {
    throw new Error(`Unexpected external runtime dependency: ${request}`);
  }
  return original.call(this, request, ...rest);
};
try {
  // n8n's loader instantiates exported classes using require() inside a VM.
  const context = vm.createContext({ require });
  for (const [relative, className] of [
    ['nodes/ICloudMail/ICloudMail.node.js', 'ICloudMail'],
    ['nodes/ICloudMail/ICloudMailTrigger.node.js', 'ICloudMailTrigger'],
    ['credentials/ICloudMailImap.credentials.js', 'ICloudMailImap'],
  ]) {
    const file = path.join(root, relative);
    const instance = new vm.Script(`new (require(${JSON.stringify(file)}).${className})()`).runInContext(context);
    assert.ok(instance.description || instance.properties);
    count++;
  }
  function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (entry.name.endsWith('.js')) {
        assert.equal(fs.readFileSync(file, 'utf8').includes('//# sourceMappingURL='), false, `Dangling source map: ${file}`);
        for (const match of fs.readFileSync(file, 'utf8').matchAll(/require\(["']([^"']+)["']\)/g)) {
          assert.ok(match[1].startsWith('.') || builtins.has(match[1]), `External import: ${match[1]}`);
        }
      }
    }
  }
  inspect(root);
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
  console.log(`Standalone verification passed: ${count} classes load in VM; manifest and direct/parent discovery match; no source-map references; only local files and Node.js built-ins; no node_modules. Full n8n startup not tested.`);
} finally { Module._load = original; }
