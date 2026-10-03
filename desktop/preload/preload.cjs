const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('classroomDesktop', Object.freeze({
  listNetworks: () => ipcRenderer.invoke('desktop:list-networks'),
  connectNetwork: input => ipcRenderer.invoke('desktop:connect-network', input),
  getLocalAddresses: () => ipcRenderer.invoke('desktop:addresses'),
  getServiceStatus: () => ipcRenderer.invoke('desktop:status')
}));
