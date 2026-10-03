const os = require('node:os');
const dgram = require('node:dgram');
function addresses() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, entries]) => entries.filter(x => x.family === 'IPv4' && !x.internal).map(x => ({ name, ip: x.address, netmask: x.netmask })));
}
function announcement(ip, port) { return { service: 'cloud-classroom', protocol: 'v2', ip, port }; }
function startDiscovery(port) {
  const socket = dgram.createSocket('udp4');
  let ready = false;
  socket.on('error', () => { ready = false; });
  socket.bind(0, () => { try { socket.setBroadcast(true); ready = true; } catch {} });
  const timer = setInterval(() => {
    if (!ready) return;
    for (const { ip, netmask } of addresses()) {
      const mask = netmask.split('.').map(Number);
      const broadcast = ip.split('.').map((v, i) => Number(v) | (255 ^ mask[i])).join('.');
      socket.send(Buffer.from(JSON.stringify(announcement(ip, port))), 41235, broadcast, () => {});
    }
  }, 5000);
  return () => { clearInterval(timer); socket.close(); };
}
module.exports = { addresses, announcement, startDiscovery };
