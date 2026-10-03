const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// Only the CPU Windows x64 runtime is shipped. Install/download scripts and other platforms are excluded.
const fixed = [
  'index.js', 'package.json', 'package-lock.json',
  'models/mnist-12.onnx', 'models/LICENSE', 'models/MODEL-LICENSE-MIT.txt',
  'models/manifest.json', 'models/SHA256SUMS', 'models/UPSTREAM-README.md',
  'node_modules/onnxruntime-node/package.json',
  'node_modules/onnxruntime-common/package.json',
  ...['onnxruntime_binding.node', 'onnxruntime.dll', 'DirectML.dll', 'dxil.dll', 'dxcompiler.dll']
    .map(name => `node_modules/onnxruntime-node/bin/napi-v6/win32/x64/${name}`)
];
function runtimeFiles(base, relative) {
  return fs.readdirSync(path.join(base, relative), { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) throw Error('Symlink in runtime resources');
    const file = `${relative}/${entry.name}`;
    return entry.isDirectory() ? runtimeFiles(base, file) : /\.(js|json)$/.test(entry.name) ? [file] : [];
  });
}
function stageHandwriting(source, root) {
  const input = path.join(source, 'handwriting');
  const output = path.join(root, 'resources/handwriting');
  const files = [...fixed, ...runtimeFiles(input, 'node_modules/onnxruntime-node/dist'),
    ...runtimeFiles(input, 'node_modules/onnxruntime-common/dist/cjs')];
  for (const pkg of ['onnxruntime-node', 'onnxruntime-common']) {
    if (JSON.parse(fs.readFileSync(path.join(input, `node_modules/${pkg}/package.json`))).version !== '1.30.0') throw Error('Unexpected runtime version');
    for (const name of ['LICENSE', 'LICENSE.txt', 'ThirdPartyNotices.txt']) {
      if (fs.existsSync(path.join(input, `node_modules/${pkg}/${name}`))) files.push(`node_modules/${pkg}/${name}`);
    }
  }
  fs.rmSync(output, { recursive: true, force: true });
  const manifest = files.sort().map(file => {
    const sourceFile = path.join(input, file);
    // Reject symlinks in every component, not just the leaf.
    let current = input;
    for (const component of file.split('/')) { current = path.join(current, component); if (fs.lstatSync(current).isSymbolicLink()) throw Error('Symlink resource'); }
    const bytes = fs.readFileSync(sourceFile);
    if (file === 'models/mnist-12.onnx' && hash(bytes) !== '5c688690f8bacf667d4c2074af5ad0646ca328d7ab03eccf944a65b320171bdd') throw Error('MODEL_HASH_MISMATCH');
    fs.mkdirSync(path.dirname(path.join(output, file)), { recursive: true });
    fs.writeFileSync(path.join(output, file), bytes);
    return { file, bytes: bytes.length, sha256: hash(bytes) };
  });
  return { platform: 'win32', arch: 'x64', napi: 6, runtime: '1.30.0', files: manifest };
}
module.exports = { stageHandwriting };
