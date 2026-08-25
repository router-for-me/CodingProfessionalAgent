export function doGlobalThisAlias() {
    const bridge = (globalThis as any).cpa
    return bridge
}
