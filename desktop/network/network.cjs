const { spawn } = require('node:child_process');
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateConnect(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).some(k => !['interfaceId', 'ssid', 'password', 'security'].includes(k))) throw Error('INVALID_INPUT');
  const { interfaceId, ssid, password, security } = value;
  if (typeof interfaceId !== 'string' || !GUID.test(interfaceId)) throw Error('INVALID_INTERFACE');
  if (typeof ssid !== 'string' || !ssid.length || Buffer.byteLength(ssid, 'utf8') > 32 || /[\x00-\x1f\x7f]/.test(ssid)) throw Error('INVALID_SSID');
  if (!['open', 'wpa2-personal'].includes(security) || typeof password !== 'string') throw Error('INVALID_SECURITY');
  if (security === 'open' ? password !== '' : !/^[\x20-\x7e]{8,63}$/.test(password)) throw Error('INVALID_PASSWORD');
  return { interfaceId, ssid, password, security };
}
function createNetwork(helper, spawnProcess = spawn) {
  let busy = false;
  async function run(request) {
    if (busy) return { ok: false, error: 'BUSY' };
    busy = true;
    try {
      return await new Promise(resolve => {
        const child = spawnProcess(helper, [], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = ''; let settled = false;
        const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
        const timer = setTimeout(() => { child.kill(); finish({ ok: false, error: 'TIMEOUT' }); }, 35000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => { output += chunk; if (output.length > 1024 * 1024) { child.kill(); finish({ ok: false, error: 'INVALID_RESPONSE' }); } });
        // Never relay native stderr, which may contain user input.
        child.stderr.resume();
        child.on('error', () => finish({ ok: false, error: 'HELPER_UNAVAILABLE' }));
        child.stdin.on('error', () => finish({ ok: false, error: 'HELPER_UNAVAILABLE' }));
        child.on('close', () => { try { finish(JSON.parse(output)); } catch { finish({ ok: false, error: 'INVALID_RESPONSE' }); } });
        child.stdin.end(JSON.stringify(request));
      });
    } finally { busy = false; }
  }
  return {
    listNetworks: () => run({ action: 'scan' }),
    connectNetwork: input => { const valid = validateConnect(input); return run({ action: 'connect', ...valid }); }
  };
}
module.exports = { createNetwork, validateConnect };
