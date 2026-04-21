import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('sentenceMinerOverlay', {
  setInteractive(interactive: boolean) {
    ipcRenderer.send('overlay:set-interactive', Boolean(interactive));
  },
  openYomitanSettings() {
    ipcRenderer.send('overlay:open-yomitan-settings');
  },
});
