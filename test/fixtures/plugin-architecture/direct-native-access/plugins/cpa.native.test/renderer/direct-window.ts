export function doDirectNative() {
    return (window as any).electronBridge.invoke('test:direct')
}

export function doDirectHostTransport() {
    return (window as any).cpaHostTransport.invoke('handle', 'test')
}
