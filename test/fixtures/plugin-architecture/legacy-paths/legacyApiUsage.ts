// Old deprecated definePlugin with embedded manifest
export function legacyPlugin() {
    return (globalThis as any).definePlugin({
        manifest: { id: 'legacy' },
        activate() {},
    })
}
