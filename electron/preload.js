const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Native dialog — returns full absolute path via main process
    browseFile: (options) => ipcRenderer.invoke('dialog:open-file', options),
    // Full path for a File object from <input type="file">
    getFilePath: (file) => webUtils.getPathForFile(file),
});
