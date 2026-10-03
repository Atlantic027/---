const test = require('node:test');
const assert = require('node:assert/strict');
const { validateConnect } = require('../network/network.cjs');
const id = '12345678-1234-1234-1234-123456789abc';
test('network input accepts UTF-8 SSID and rejects injection/control input', () => {
  assert.equal(validateConnect({ interfaceId: id, ssid: '教师 Wi-Fi', password: 'password1', security: 'wpa2-personal' }).ssid, '教师 Wi-Fi');
  assert.throws(() => validateConnect({ interfaceId: id, ssid: 'x\nnetsh', password: 'password1', security: 'wpa2-personal' }), /INVALID_SSID/);
  assert.throws(() => validateConnect({ interfaceId: id, ssid: 'x', password: 'short', security: 'wpa2-personal' }), /INVALID_PASSWORD/);
  assert.throws(() => validateConnect({ interfaceId: id, ssid: 'x', password: 'x', security: 'open', extra: 'nope' }), /INVALID_INPUT/);
});
const { createNetwork } = require('../network/network.cjs');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
test('connection secret goes only to stdin, shell is disabled, UTF-8 survives split bytes', async () => {
  let received;
  const network = createNetwork('fixed-helper.exe', (file, args, options) => {
    assert.equal(file, 'fixed-helper.exe'); assert.deepEqual(args, []); assert.equal(options.shell, false);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    child.stdin = new Writable({ write(chunk, _enc, callback) { received = JSON.parse(chunk.toString()); callback(); } });
    child.stdin.on('finish', () => {
      const bytes = Buffer.from(JSON.stringify({ ok: true, connected: true, ssid: '中文 & $(calc)' }));
      for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
      child.emit('close', 0);
    });
    return child;
  });
  const result = await network.connectNetwork({ interfaceId: id, ssid: '中文 & $(calc)', password: 'a"&|<>123', security: 'wpa2-personal' });
  assert.equal(result.ssid, '中文 & $(calc)'); assert.equal(received.password, 'a"&|<>123');
});
test('invalid command payload is rejected before starting native helper', () => {
  const network = createNetwork('fixed-helper.exe', () => assert.fail('must not spawn'));
  assert.throws(() => network.connectNetwork({ interfaceId: `${id}&calc`, ssid: 'abc', password: '', security: 'open' }));
});
test('native errors are returned without stderr/secret leakage', async () => {
  const network = createNetwork('fixed-helper.exe', () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    child.stdin = new Writable({ write(_chunk, _enc, callback) { callback(); } });
    child.stdin.on('finish', () => { child.stderr.write('SECRET'); child.stdout.write('{"ok":false,"error":"WLAN_ERROR","nativeCode":1062}'); child.emit('close', 0); });
    return child;
  });
  assert.deepEqual(await network.listNetworks(), { ok: false, error: 'WLAN_ERROR', nativeCode: 1062 });
});
