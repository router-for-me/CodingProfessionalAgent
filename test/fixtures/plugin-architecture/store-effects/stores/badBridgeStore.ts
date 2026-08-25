export function useBadBridgeStore() {
    return {
        save: (payload: any) => {
            return (window as any).electronBridge.invoke('db:save', payload)
        },
    }
}
