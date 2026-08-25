import { ipcRenderer } from 'electron'

export function doElectronImport() {
    return ipcRenderer.send('test')
}
