export function doComputedAccess(dynamicKey: string) {
    const eb1 = (window as any)['electronBridge']
    const eb2 = (globalThis as any)['electron' + 'Bridge']
    const eb3 = (window as any)[`electronBridge`]
    const dynamicGlobal = (window as any)[dynamicKey]
    return { eb1, eb2, eb3, dynamicGlobal }
}
