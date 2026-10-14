// Bridge between the UI and the main process. The UI gets only these functions,
// no direct access to Node.js or Electron.
const { contextBridge, ipcRenderer } = require('electron');

const CHANNEL = /^(grabber|downloads|settings|dialog|app|tools):[a-zA-Z]+$/;

contextBridge.exposeInMainWorld('adl', {
  /** Call a main-process action, e.g. invoke('downloads:start'). */
  invoke(channel, arg) {
    if (!CHANNEL.test(channel)) throw new Error(`Unknown action: ${channel}`);
    return ipcRenderer.invoke(channel, arg);
  },
  /** Receive state snapshots. Returns an unsubscribe function. */
  onState(callback) {
    const handler = (_e, state) => callback(state);
    ipcRenderer.on('state', handler);
    ipcRenderer.send('state:request');
    return () => ipcRenderer.off('state', handler);
  },
  /** Questions from the main process: callback({id, title, message, detail, confirm, cancel}). */
  onPrompt(callback) {
    ipcRenderer.on('prompt', (_e, q) => callback(q));
  },
  /** Short messages to show as a toast. */
  onNotice(callback) {
    ipcRenderer.on('notice', (_e, message) => callback(message));
  },
  platform: process.platform,
});
