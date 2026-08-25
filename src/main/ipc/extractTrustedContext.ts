import type { RpcInvocationContext } from '@cpa/plugin-api'

/**
 * Extracts a verified, trusted invocation context from an Electron IPC event.
 * Identity is derived authoritatively from event.sender / event.senderFrame and never from renderer payloads.
 */
export function extractTrustedInvocationContext(
    event: any,
    overrides?: {
        pluginId?: string
        runtime?: 'main' | 'renderer' | 'agent'
        clientId?: string
    },
): RpcInvocationContext {
    const sender = event?.sender
    const senderFrame = event?.senderFrame

    const senderId: number = typeof sender?.id === 'number' ? sender.id : 0
    const frameUrl: string = senderFrame
        ? typeof senderFrame.url === 'string'
            ? senderFrame.url
            : ''
        : typeof sender?.getURL === 'function'
          ? sender.getURL()
          : ''
    const processId: number | undefined =
        typeof senderFrame?.processId === 'number'
            ? senderFrame.processId
            : typeof sender?.getProcessId === 'function'
              ? sender.getProcessId()
              : undefined
    const routingId: number | undefined =
        typeof senderFrame?.routingId === 'number' ? senderFrame.routingId : undefined

    let documentId: string | undefined
    if (typeof senderFrame?.frameToken === 'string' && senderFrame.frameToken) {
        documentId = `${senderId}:${senderFrame.frameToken}`
    } else if (processId !== undefined && routingId !== undefined) {
        documentId = `${senderId}:${processId}:${routingId}`
    } else if (routingId !== undefined) {
        documentId = `${senderId}:${routingId}`
    } else if (senderId > 0) {
        documentId = `${senderId}`
    }

    return {
        pluginId: overrides?.pluginId ?? '',
        senderId,
        frameUrl,
        transport: 'electron',
        runtime: overrides?.runtime,
        processId,
        routingId,
        documentId,
        clientId: overrides?.clientId ?? overrides?.pluginId ?? 'desktop-main',
    }
}
