const test = require('node:test');
const assert = require('node:assert/strict');
const { announcement, addresses } = require('../main/discovery.cjs');
test('UDP announcement contains only public discovery contract', () => {
  assert.deepEqual(announcement('192.168.1.4', 4444), { service: 'cloud-classroom', protocol: 'v2', ip: '192.168.1.4', port: 4444 });
  assert.ok(addresses().every(x => x.ip !== '127.0.0.1'));
});
