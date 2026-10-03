const { app, BrowserWindow, ipcMain, Menu, shell, dialog, Tray, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { trustedSender } = require('./security.cjs');
const { addresses, startDiscovery } = require('./discovery.cjs');
const { createNetwork } = require('../network/network.cjs');
const args = process.argv.slice(1);
const option = name => args.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3);
const verificationDir = option('verify-dir');
if (verificationDir) {
  if (!path.isAbsolute(verificationDir)) throw Error('verify-dir must be absolute');
  app.setPath('userData', verificationDir);
}
const serverOnly = args.includes('--server-only');
let server, wss, stopDiscovery, mainWindow, networkWindow, origin, port, tray;
let stopping = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
  app.whenReady().then(start).catch(error => {
    if (verificationDir) { fs.mkdirSync(verificationDir, { recursive: true }); fs.writeFileSync(path.join(verificationDir, 'failure.json'), JSON.stringify({ error: error.message, stack: error.stack })); }
    else dialog.showErrorBox('MAX35 Teacher', '本地服务启动失败，请检查端口是否占用及用户数据目录权限。');
    app.exit(1);
  });
}
function secureWindow(url) {
  const window = new BrowserWindow({ width: 1200, height: 800, show: !verificationDir, webPreferences: { preload: path.join(__dirname, '../preload/preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => { if (![`${origin}/teacher-v2.html`, `${origin}/desktop-network.html`].includes(target)) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.loadURL(url);
  return window;
}
async function start() {
  const root = app.getPath('userData');
  fs.mkdirSync(root, { recursive: true });
  process.env.DATA_DIR = path.join(root, 'data');
  process.env.UPLOAD_DIR = path.join(root, 'uploads');
  const requested = verificationDir ? 0 : Number(option('port') ?? 8080);
  if (!Number.isInteger(requested) || requested < 0 || requested > 65535) throw Error('Invalid port');
  process.env.PORT = String(requested);
  const handwriting = require('./handwriting.cjs');
  await handwriting.initialize();
  const backend = require('../backend/server.js');
  server = backend.server; wss = backend.wss;
  // Mounted locally by desktop; no network control HTTP endpoints exist.
  backend.app.get('/desktop-network.html', (_req, res) => res.sendFile(path.join(__dirname, '../ui/network.html')));
  backend.app.get('/desktop-network.js', (_req, res) => res.type('js').sendFile(path.join(__dirname, '../ui/network.js')));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(requested, verificationDir ? '127.0.0.1' : '0.0.0.0', resolve); });
  port = server.address().port; origin = `http://127.0.0.1:${port}`;
  // Existing v2 discovery captures PORT at require-time. Override only its response in the desktop adapter.
  const discoveryLayer = backend.app._router.stack.find(layer => layer.route?.path === '/api/v2/discovery');
  if (discoveryLayer) discoveryLayer.route.stack[0].handle = (_req, res) => res.json({ service: 'cloud-classroom', protocol: 'v2', ip: '127.0.0.1', port });
  const helper = app.isPackaged ? path.join(process.resourcesPath, 'network/WlanHelper.exe') : path.join(__dirname, '../network/bin/WlanHelper.exe');
  const network = createNetwork(helper);
  const status = () => ({ running: server.listening, origin, port, teacherUrl: `${origin}/teacher-v2.html`, candidate: true, modelIncluded: handwriting.getHealth().available, handwriting: handwriting.getHealth() });
  backend.app.get('/api/desktop/health', (_req, res) => res.json(status()));
  if (!handwriting.getHealth().available && !verificationDir) dialog.showMessageBox({ type: 'warning', title: 'MAX35 启动健康检查', message: 'handwriting unavailable：手写识别不可用', detail: '课程与教师控制台仍可使用。请检查模型及 Windows x64 原生运行库。' });
  const handlers = { 'desktop:list-networks': () => network.listNetworks(), 'desktop:connect-network': input => network.connectNetwork(input), 'desktop:addresses': () => addresses(), 'desktop:status': status };
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, async (event, input) => {
    if (![mainWindow, networkWindow].some(window => trustedSender(event, window, origin))) throw Error('FORBIDDEN_SENDER');
    try { return await handler(input); } catch { return { ok: false, error: 'INVALID_INPUT' }; }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '课堂', submenu: [
    { label: '教师页面', click: () => { if (!mainWindow || mainWindow.isDestroyed()) mainWindow = secureWindow(`${origin}/teacher-v2.html`); else mainWindow.show(); } },
    { label: '网络设置', click: () => { if (!networkWindow || networkWindow.isDestroyed()) { networkWindow = secureWindow(`${origin}/desktop-network.html`); networkWindow.on('closed', () => { networkWindow = null; }); } else networkWindow.focus(); } },
    { role: 'quit', label: '退出并停止服务' }
  ] }]));
  if (!verificationDir) stopDiscovery = startDiscovery(port);
  if (!serverOnly) mainWindow = secureWindow(`${origin}/teacher-v2.html`);
  else if (!verificationDir) {
    tray = new Tray(nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==').resize({ width: 16, height: 16 }));
    tray.setToolTip(`MAX35 Teacher — ${origin}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '浏览器教师入口', click: () => shell.openExternal(`${origin}/teacher-v2.html`) },
      { label: '停止服务并退出', click: () => app.quit() }
    ]));
    await shell.openExternal(`${origin}/teacher-v2.html`);
  }
  if (verificationDir) {
    const scan = await network.listNetworks();
    let renderer = null;
    if (mainWindow) {
      if (mainWindow.webContents.isLoading()) await new Promise(resolve => mainWindow.webContents.once('did-finish-load', resolve));
      renderer = await mainWindow.webContents.executeJavaScript('(async () => ({ node: typeof process, require: typeof require, keys: Object.keys(window.classroomDesktop), status: await window.classroomDesktop.getServiceStatus() }))()');
      renderer.teacherUi = await mainWindow.webContents.executeJavaScript(`(async () => {
        document.getElementById('inputTeacherName').value = '桌面 UI 隔离验证';
        document.getElementById('inputCourseTitle').value = 'Portable UI course';
        document.getElementById('btnCreateCourse').click();
        for (let i = 0; i < 100; i++) {
          const code = document.getElementById('dashCourseCode').textContent.trim();
          if (/^[A-Z0-9]{6}$/.test(code)) return { url: location.href, title: document.title, courseCodeVisible: true, dashboardVisible: getComputedStyle(document.getElementById('viewDashboard')).display !== 'none' };
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw Error('Teacher UI did not create/display course');
      })()`);
    }
    fs.writeFileSync(path.join(root, 'ready.json'), JSON.stringify({ ...status(), pid: process.pid, packaged: app.isPackaged, electron: process.versions.electron, renderer, scan: { ok: scan.ok, error: scan.error, nativeCode: scan.nativeCode, networksCount: scan.networks?.length ?? 0 } }, null, 2));
    const watcher = setInterval(() => { if (fs.existsSync(path.join(root, 'stop'))) { clearInterval(watcher); app.quit(); } }, 250);
    setTimeout(() => app.quit(), 90000).unref();
  }
}
app.on('window-all-closed', () => { if (!serverOnly) app.quit(); });
app.on('before-quit', event => {
  if (stopping || !server?.listening) return;
  event.preventDefault(); stopping = true;
  if (stopDiscovery) stopDiscovery();
  for (const client of wss.clients) client.terminate();
  wss.close(); server.close(() => app.exit(0)); server.closeAllConnections();
  setTimeout(() => app.exit(0), 3000).unref();
});
