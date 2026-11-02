const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('isekai', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  selectSource: (id) => ipcRenderer.invoke('select-source', id),
  listApps: () => ipcRenderer.invoke('list-apps'),
  startAudio: (pid) => ipcRenderer.invoke('start-audio', pid),
  stopAudio: () => ipcRenderer.invoke('stop-audio'),
  copy: (text) => ipcRenderer.invoke('copy', text),
  iceServers: () => ipcRenderer.invoke('ice-servers'),
  setFullscreen: (on) => ipcRenderer.invoke('set-fullscreen', on),
  onAudio: (fn) => ipcRenderer.on('audio-pcm', (_e, chunk) => fn(chunk)),
  onAudioEnded: (fn) => ipcRenderer.on('audio-ended', () => fn()),
});
