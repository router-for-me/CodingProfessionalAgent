import type { RpcInvocationContext, WebRouteContext, WebRouteRequest } from '@cpa/plugin-api'

/**
 * WebIdentityAdapter manages client identity extraction, unique client ID generation,
 * and standard RpcInvocationContext creation across Web HTTP and WebSocket transports.
 */
export class WebIdentityAdapter {
    private clientIdSeq = 0

    /**
     * Generate a unique client identifier for a WebSocket connection.
     */
    generateWsClientId(): string {
        return `client_ws_${++this.clientIdSeq}_${Date.now()}`
    }

    /**
     * Create an RpcInvocationContext for a WebSocket client connection.
     */
    createWsInvocationContext(clientId: string): RpcInvocationContext {
        return {
            pluginId: 'web-ws',
            senderId: 0,
            frameUrl: '',
            transport: 'web',
            runtime: undefined,
            clientId,
            documentId: `web:${clientId}`,
        }
    }

    /**
     * Create an RpcInvocationContext for an HTTP RPC request.
     */
    createHttpInvocationContext(
        request?: WebRouteRequest,
        clientId?: string,
    ): RpcInvocationContext {
        const resolvedClientId = clientId || 'http-rpc'
        return {
            pluginId: 'web-rpc',
            senderId: 0,
            frameUrl: request?.url ?? '',
            transport: 'web',
            runtime: undefined,
            clientId: resolvedClientId,
            documentId: `web:${resolvedClientId}`,
        }
    }

    /**
     * Adapt an incoming invocation context, ensuring all required fields are populated.
     */
    adaptInvocationContext(
        context?: Partial<RpcInvocationContext>,
        fallbackClientId = 'http-rpc',
    ): RpcInvocationContext {
        const clientId = context?.clientId ?? fallbackClientId
        return {
            pluginId: context?.pluginId ?? 'web-rpc',
            senderId: context?.senderId ?? 0,
            frameUrl: context?.frameUrl ?? '',
            transport: context?.transport ?? 'web',
            runtime: context?.runtime,
            processId: context?.processId,
            routingId: context?.routingId,
            clientId,
            documentId: context?.documentId ?? `web:${clientId}`,
        }
    }

    /**
     * Create a WebRouteContext from an incoming request and optional invocation context overrides.
     */
    createRouteContext(
        request: WebRouteRequest,
        customRpcContext?: Partial<RpcInvocationContext>,
    ): WebRouteContext {
        const rpcContext = this.adaptInvocationContext(customRpcContext, 'http-rpc')
        rpcContext.frameUrl = request.url || rpcContext.frameUrl
        return {
            request,
            rpcContext,
        }
    }
}
