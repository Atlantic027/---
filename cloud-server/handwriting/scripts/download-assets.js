'use strict';
// Build-time data downloads only; never imported by index.js. No remote code.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');
const expected = '5c688690f8bacf667d4c2074af5ad0646ca328d7ab03eccf944a65b320171bdd';
const pointerUrl = 'https://api.github.com/repos/onnx/models/git/blobs/dd60a90ebfcb1afb61a46cf0a99081a0fd951bc8';
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
async function download(url) {
  const { stdout } = await execute(process.platform === 'win32' ? 'curl.exe' : 'curl',
    ['-fsSL', '--retry', '4', '--retry-all-errors', '--connect-timeout', '15', '--max-time', '180', '-H', 'User-Agent: classroom-handwriting', url],
    { encoding: 'buffer', maxBuffer: 5000000, windowsHide: true });
  return stdout;
}
async function jsonAsset(relative, value) {
  await fs.writeFile(path.join(root, relative), JSON.stringify(value, null, 2) + '\n');
}
async function main() {
  await fs.mkdir(path.join(root, 'models'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests/fixtures'), { recursive: true });
  const pointerResponse = JSON.parse((await download(pointerUrl)).toString());
  const pointer = Buffer.from(pointerResponse.content, 'base64').toString();
  if (!pointer.includes(`oid sha256:${expected}`) || !pointer.includes('size 26143')) throw new Error('Pinned upstream LFS pointer mismatch');
  const urls = [
    'https://github.com/onnx/models/raw/refs/heads/main/validated/vision/classification/mnist/model/mnist-12.onnx?download=1',
    'https://media.githubusercontent.com/media/onnx/models/main/validated/vision/classification/mnist/model/mnist-12.onnx',
    'https://raw.githubusercontent.com/onnx/models/main/validated/vision/classification/mnist/model/mnist-12.onnx'
  ];
  const attempts = [];
  let model, source;
  for (const url of urls) {
    try {
      const data = await download(url);
      if (digest(data) !== expected || data.length !== 26143) throw new Error('Not the pinned ONNX model (possibly an LFS pointer)');
      model = data; source = url; attempts.push({ url, success: true }); break;
    } catch (error) { attempts.push({ url, error: error.message }); console.error(`Asset attempt failed: ${url}`); }
  }
  await jsonAsset('models/download-attempts.json', attempts);
  if (!model) throw new Error('All official model download endpoints failed; see models/download-attempts.json');
  // Deserialize on the target runtime before publishing the model asset.
  const session = await require('onnxruntime-node').InferenceSession.create(model, { executionProviders: ['cpu'] });
  await session.release();
  const readmeUrl = 'https://api.github.com/repos/onnx/models/contents/validated/vision/classification/mnist/README.md';
  const readme = Buffer.from(JSON.parse((await download(readmeUrl)).toString()).content, 'base64');
  if (!readme.toString().includes('## License\nMIT')) throw new Error('Model license declaration changed');
  await fs.writeFile(path.join(root, 'models/UPSTREAM-README.md'), readme);
  await fs.writeFile(path.join(root, 'models/mnist-12.onnx'), model);
  await fs.writeFile(path.join(root, 'models/SHA256SUMS'), `${expected}  mnist-12.onnx\n`);
  await jsonAsset('models/manifest.json', { source, pointerUrl, sha256: expected, bytes: model.length, license: 'MIT', licenseSource: readmeUrl });
  const url = 'https://archive.ics.uci.edu/ml/machine-learning-databases/pendigits/pendigits.tes';
  let sampleCount = 0;
  try {
    const samples = await download(url);
    const rows = samples.toString().trim().split(/\r?\n/);
    if (rows.length !== 3498 || rows.some(row => row.split(',').length !== 17)) throw new Error('Incomplete PenDigits test split');
    sampleCount = rows.length;
    await fs.writeFile(path.join(root, 'tests/fixtures/pendigits.tes'), samples);
    await jsonAsset('tests/fixtures/manifest.json', { source: url, sha256: digest(samples), bytes: samples.length, license: 'CC-BY-4.0', citation: 'Alpaydin & Alimoglu (1996), DOI 10.24432/C5MG6K' });
  } catch (error) {
    const fixture = path.join(root, 'tests/fixtures/pendigits.tes');
    if (!await fs.access(fixture).then(() => true).catch(() => false)) throw new Error(`Model installed, but PenDigits fixture download failed and no verified local fixture exists: ${error.message}`);
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'tests/fixtures/manifest.json'), 'utf8'));
    if (manifest.bytes !== (await fs.stat(fixture)).size || digest(await fs.readFile(fixture)) !== manifest.sha256) throw new Error('Existing PenDigits fixture does not match its manifest');
    sampleCount = (await fs.readFile(fixture, 'utf8')).trim().split(/\r?\n/).length;
    console.warn(`Model installed; retained existing verified PenDigits fixture after download failure: ${error.message}`);
  }
  console.log({ source, sha256: expected, modelBytes: model.length, samples: sampleCount });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
