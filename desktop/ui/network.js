const bridge = window.classroomDesktop;
const status = document.querySelector('#status');
const select = document.querySelector('#networks');
let networks = [];
async function refresh() {
  document.querySelector('#addresses').textContent = JSON.stringify({ service: await bridge.getServiceStatus(), addresses: await bridge.getLocalAddresses() }, null, 2);
}
document.querySelector('#scan').onclick = async () => {
  status.textContent = '扫描中…';
  const result = await bridge.listNetworks(); networks = result.networks || []; select.replaceChildren();
  networks.forEach((network, index) => { const option = document.createElement('option'); option.value = index; option.textContent = `${network.ssid} (${network.signal}%, ${network.security})`; option.disabled = network.security === 'unsupported'; select.append(option); });
  status.textContent = result.error || `发现 ${networks.length} 个网络`;
};
document.querySelector('#connect').onclick = async () => {
  const network = networks[select.value]; if (!network || network.security === 'unsupported') return;
  const input = document.querySelector('#password'); const password = input.value; input.value = '';
  status.textContent = '连接中…';
  const result = await bridge.connectNetwork({ interfaceId: network.interfaceId, ssid: network.ssid, security: network.security, password });
  status.textContent = result.ok ? '已连接' : result.error; await refresh();
};
document.querySelector('#refresh').onclick = refresh;
if (bridge) refresh(); else status.textContent = '请从桌面软件的“课堂 → 网络设置”打开。';
