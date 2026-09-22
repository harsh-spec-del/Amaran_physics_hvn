import { contextBridge, ipcRenderer } from 'electron';

// Login/credentials removed — the app opens straight to the workspace.
// What's left is local data persistence for Data Studio's dynamic
// records, which was never really an access-control boundary, just
// happened to be exposed under the same bridge as the old auth calls.
contextBridge.exposeInMainWorld('amaranData', {
  writeData: (records: unknown[]) => ipcRenderer.invoke('data:write', records),
  readData: () => ipcRenderer.invoke('data:read'),
});
