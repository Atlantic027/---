const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = path.resolve(root, '../cloud-server');
const { stageHandwriting } = require('./resources.cjs');
// Explicit file allowlist: never recursively copy the server working directory.
const files = ['server.js', 'classroom-v2.js', 'public/index.html', 'public/teacher-v2.html', 'public/student-v2.html'];
const handwritingEntry = path.join(source, 'handwriting/index.js');
if (!fs.lstatSync(handwritingEntry).isFile() || fs.lstatSync(handwritingEntry).isSymbolicLink()) throw Error('Invalid handwriting entry');
fs.rmSync(path.join(root, 'backend'), { recursive: true, force: true });
const manifest = files.map(file => {
  const input = path.join(source, file);
  if (!fs.lstatSync(input).isFile() || fs.lstatSync(input).isSymbolicLink()) throw Error('Invalid backend resource');
  const content = fs.readFileSync(input);
  const output = path.join(root, 'backend', file);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, content);
  return { file, bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') };
});
const adapter = "module.exports = require('../../main/handwriting.cjs');\n";
fs.mkdirSync(path.join(root, 'backend/handwriting'), { recursive: true });
fs.writeFileSync(path.join(root, 'backend/handwriting/index.js'), adapter);
manifest.push({ file: 'handwriting/index.js', bytes: Buffer.byteLength(adapter), sha256: crypto.createHash('sha256').update(adapter).digest('hex'), generated: true });
const model = stageHandwriting(source, root);
if (!model.files.some(item => item.file === 'index.js') || !model.files.some(item => item.file === 'models/mnist-12.onnx')) throw Error('Handwriting entry or model was not staged');
fs.writeFileSync(path.join(root, 'backend/manifest.json'), JSON.stringify({ modelIncluded: true, files: manifest, handwriting: model }, null, 2));
console.log('Staged final teacher-v2 and', model.files.length, 'allowlisted model/runtime resources.');
