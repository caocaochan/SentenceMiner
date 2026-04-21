import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('sentenceMinerOverlay', {
  setInteractive(interactive: boolean) {
    ipcRenderer.send('overlay:set-interactive', Boolean(interactive));
  },
});
