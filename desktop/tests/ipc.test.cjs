const test = require('node:test');
const assert = require('node:assert/strict');
const { trustedSender } = require('../main/security.cjs');
function fake(url, origin) { const sender = { mainFrame: null }; sender.mainFrame = { url, origin }; return { sender, senderFrame: sender.mainFrame }; }
test('IPC sender is limited to the local teacher/network pages', () => {
  const origin = 'http://127.0.0.1:12345'; const browser = { isDestroyed: () => false, webContents: null }; browser.webContents = fake(`${origin}/teacher-v2.html`, origin).sender;
  assert.equal(trustedSender({ sender: browser.webContents, senderFrame: browser.webContents.mainFrame }, browser, origin), true);
  const event = { sender: browser.webContents, senderFrame: browser.webContents.mainFrame };
  event.senderFrame.url = `${origin}/evil.html`; assert.equal(trustedSender(event, browser, origin), false);
  event.senderFrame.url = `${origin}/teacher-v2.html`; event.senderFrame.origin = 'https://evil.test'; assert.equal(trustedSender(event, browser, origin), false);
  event.senderFrame.origin = origin;
  assert.equal(trustedSender({ sender: browser.webContents, senderFrame: { ...event.senderFrame } }, browser, origin), false);
  assert.equal(trustedSender(fake(`${origin}/teacher-v2.html`, origin), browser, origin), false);
  assert.equal(trustedSender(fake('file:///tmp/teacher-v2.html', 'null'), browser, origin), false);
});
