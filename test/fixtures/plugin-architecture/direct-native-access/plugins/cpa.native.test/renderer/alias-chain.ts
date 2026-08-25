export function doAliasChain() {
    const { electronBridge: b } = window as any
    b.invoke('test:b')

    const w = window as any
    w.electronBridge.invoke('test:w')

    const g = globalThis as any
    const eb = g.electronBridge
    eb.invoke('test:eb')

    const { cpa: c } = globalThis as any
    c.doSomething()
}
