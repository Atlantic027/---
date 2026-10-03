function trustedSender(event, window, origin) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
  try {
    const url = new URL(event.senderFrame.url);
    return event.senderFrame.origin === origin && url.origin === origin && ['/teacher-v2.html', '/desktop-network.html'].includes(url.pathname);
  } catch { return false; }
}
module.exports = { trustedSender };
