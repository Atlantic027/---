const asar = require('@electron/asar');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const archive = path.join(root, 'dist/win-unpacked/resources/app.asar');
const resources = path.join(root, 'dist/win-unpacked/resources/handwriting');
const entries = asar.listPackage(archive).map(x => `/${x.replaceAll('\\', '/')}`);
const manifest = JSON.parse(asar.extractFile(archive, 'backend/manifest.json'));
for (const item of manifest.files) {
  const bytes = asar.extractFile(archive, `backend/${item.file}`.replaceAll('/', '\\'));
  assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'), item.sha256);
}
const forbidden = entries.filter(x => /\/(?:backend\/)?(?:data|uploads|config|launcher|firmware)(?:\/|$)/.test(x));
assert.deepEqual(forbidden, []);
assert.equal(entries.includes('/node_modules/electron'), false);
assert.equal(entries.includes('/node_modules/electron-builder'), false);
assert.equal(fs.existsSync(resources), true);
function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    assert.equal(entry.isSymbolicLink(), false);
    const relative = prefix + entry.name;
    return entry.isDirectory() ? walk(path.join(dir, entry.name), relative + '/') : [relative];
  });
}
assert.deepEqual(walk(resources).sort(), manifest.handwriting.files.map(x => x.file).sort(), 'resource tree must exactly match allowlist');
for (const item of manifest.handwriting.files) {
  const file = path.join(resources, item.file);
  assert.equal(fs.existsSync(file), true, `missing resource ${item.file}`);
  assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'), item.sha256, `resource hash ${item.file}`);
}
const modelIncluded = manifest.modelIncluded === true && manifest.handwriting.platform === 'win32' && manifest.handwriting.arch === 'x64' && manifest.handwriting.files.some(item => item.file === 'models/mnist-12.onnx') && manifest.handwriting.files.some(item => item.file.endsWith('/onnxruntime_binding.node'));
assert.equal(modelIncluded, true, 'model manifest is incomplete');
fs.writeFileSync(path.join(root, 'dist/PACKAGE-AUDIT.json'), JSON.stringify({ backendFilesVerified: manifest.files, modelFilesVerified: manifest.handwriting.files, forbiddenEntries: forbidden, modelIncluded, packagedEntries: entries.length }, null, 2));
console.log('Packaged backend and allowlisted model/native hashes verified; forbidden archive directories absent.');
