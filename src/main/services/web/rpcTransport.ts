import type { RpcInvocationContext } from '@cpa/plugin-api'
import { WebIdentityAdapter } from './identityAdapter.js'

export type RpcDispatcher = (
    method: string,
    args: unknown[],
    context?: RpcInvocationContext,
) => Promise<unknown>

/**
 * WebRpcTransport handles RPC execution and payload wrapping across HTTP POST /api/rpc
 * and WebSocket duplex channels with standard RpcInvocationContext injection.
 */
export class WebRpcTransport {
    private dispatcher: RpcDispatcher | null = null
    private readonly identityAdapter: WebIdentityAdapter

    constructor(
        dispatcher?: RpcDispatcher | null,
        identityAdapter?: WebIdentityAdapter,
    ) {
        this.dispatcher = dispatcher ?? null
        this.identityAdapter = identityAdapter ?? new WebIdentityAdapter()
    }

    setDispatcher(dispatcher: RpcDispatcher): void {
        this.dispatcher = dispatcher
    }

    getDispatcher(): RpcDispatcher | null {
        return this.dispatcher
    }

    /**
     * Dispatch an RPC method call through the registered dispatcher with contextual client identity.
     */
    async dispatch(
        method: string,
        args: unknown[] = [],
        context?: Partial<RpcInvocationContext>,
    ): Promise<unknown> {
        if (!this.dispatcher) {
            throw new Error('RPC dispatcher is not registered')
        }

        const invocationContext = this.identityAdapter.adaptInvocationContext(
            context,
            'http-rpc',
        )

        return await this.dispatcher(method, args, invocationContext)
    }

    /**
     * Handle an HTTP POST /api/rpc payload and return standard response payload.
     */
    async handleHttpRequest(
        body: unknown,
        context?: Partial<RpcInvocationContext>,
    ): Promise<{ id?: unknown; result?: unknown; error?: string }> {
        if (typeof body !== 'object' || body === null) {
            return { error: 'Invalid JSON body' }
        }

        const { id, method, args, clientId, runtime } = body as {
            id?: unknown
            method?: unknown
            args?: unknown
            clientId?: unknown
            runtime?: unknown
        }

        if (typeof method !== 'string' || !method.trim()) {
            return { id, error: 'Method is required' }
        }

        const rpcArgs = Array.isArray(args) ? [...args] : []
        const requestClientId = typeof clientId === 'string' && clientId.trim() ? clientId.trim() : undefined
        const requestRuntime =
            runtime === 'main' || runtime === 'renderer' || runtime === 'agent'
                ? runtime
                : undefined
        const mergedContext: Partial<RpcInvocationContext> = {
            ...context,
            ...(requestRuntime ? { runtime: requestRuntime } : {}),
            ...(requestClientId
                ? {
                      clientId: requestClientId,
                      documentId: context?.documentId ?? `web:${requestClientId}`,
                  }
                : {}),
        }

        try {
            const result = await this.dispatch(method, rpcArgs, mergedContext)
            return { id, result }
        } catch (err: unknown) {
            const message = (err as Error)?.message || String(err)
            return { id, error: message }
        }
    }

    /**
     * Handle a WebSocket text message frame (ping or RPC method call).
     */
    async handleWsMessage(
        rawMessage: string,
        wsContext: { clientId: string },
    ): Promise<{
        isPing?: boolean
        response?: unknown
    }> {
        const msg = JSON.parse(rawMessage)

        if (msg.type === 'ping') {
            return {
                isPing: true,
                response: { type: 'pong' },
            }
        }

        if (msg.type === 'rpc' || msg.method) {
            const { id, method, args, runtime } = msg
            const rpcArgs = Array.isArray(args) ? [...args] : []

            const context = this.identityAdapter.createWsInvocationContext(wsContext.clientId)
            if (runtime === 'main' || runtime === 'renderer' || runtime === 'agent') {
                context.runtime = runtime
            }

            try {
                const result = await this.dispatch(method, rpcArgs, context)
                return {
                    response: {
                        type: 'rpc_result',
                        id,
                        result,
                    },
                }
            } catch (err: unknown) {
                const errorMsg = (err as Error)?.message || String(err)
                return {
                    response: {
                        type: 'rpc_error',
                        id,
                        error: errorMsg,
                    },
                }
            }
        }

        return {}
    }
}
