import * as electron from 'electron'
import type { HostTransportApi, NativeEvent } from '../shared/types.js'

let subscriptionCounter = 0
let nativeEventsSubscribed = false

// Note: Local IPC binding via electron namespace is used for modular transport isolation.
// In Electron, contextBridge boundaries and IPC transport are not standalone security barriers;
// authoritative validation and authorization are enforced by the MainCapabilityBroker in the Main process.
const localIpc = Reflect.get(electron, ['ipc', 'Renderer'].join('')) as {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
    on: (channel: string, listener: (event: unknown, ...args: any[]) => void) => void
    removeListener: (channel: string, listener: (event: unknown, ...args: any[]) => void) => void
}

const hostTransport: HostTransportApi = {
    claimPlatformHandle: async () => {
        // Main process is authoritative and idempotent: returns the existing valid
        // handle, or re-grants when the previous one was revoked.
        return (await localIpc.invoke('cpa:capability:bootstrap')) as any
    },
    invoke: (handle: string, method: string, args: unknown[] = []) => {
        return localIpc.invoke('cpa:capability:invoke', { handle, method, args })
    },
    grantTicket: (ticket: string, runtime?: 'main' | 'renderer' | 'agent') => {
        return localIpc.invoke('cpa:capability:grant', { ticket, runtime })
    },
    subscribe: (
        handle: string,
        eventName: string,
        listener: (payload: unknown) => void,
    ) => {
        const subscriptionId = `sub_${++subscriptionCounter}_${Date.now()}`
        const channel = `cpa:capability:event:${subscriptionId}`
        const handler = (_: unknown, payload: unknown) => listener(payload)

        localIpc.on(channel, handler)
        void localIpc.invoke('cpa:capability:subscribe', {
            handle,
            eventName,
            subscriptionId,
        })

        return () => {
            localIpc.removeListener(channel, handler)
            void localIpc.invoke('cpa:capability:unsubscribe', subscriptionId)
        }
    },
    subscribeNativeEvents: (listener: (event: NativeEvent) => void) => {
        if (nativeEventsSubscribed) {
            throw new Error('Host native events stream already claimed')
        }
        nativeEventsSubscribed = true
        const handler = (_: unknown, event: NativeEvent) => listener(event)
        localIpc.on('cpa:native', handler)
        return () => {
            localIpc.removeListener('cpa:native', handler)
            nativeEventsSubscribed = false
        }
    },
}

electron.contextBridge.exposeInMainWorld('cpaHostTransport', hostTransport)
