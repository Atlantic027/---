const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('packaging source includes only allowlisted model resources', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json')));
  assert.equal(pkg.build.files.includes('cloud-server/**'), false);
  assert.equal(pkg.build.files.includes('handwriting/**'), false);
  assert.equal(pkg.build.extraResources.some(x => x.to === 'handwriting'), true);
  assert.equal(pkg.build.extraResources[0].to, 'network/WlanHelper.exe');
});
