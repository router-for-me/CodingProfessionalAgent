export function doWindowAlias() {
    const { electronBridge } = window as any
    return electronBridge.invoke('test:alias')
}
