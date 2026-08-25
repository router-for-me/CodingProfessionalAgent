import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WebRouteRegistry } from '../src/main/services/web/routeRegistry.js'
import { WebRpcTransport } from '../src/main/services/web/rpcTransport.js'
import { WebIdentityAdapter } from '../src/main/services/web/identityAdapter.js'
import type { WebRouteContribution, RpcInvocationContext } from '@cpa/plugin-api'

describe('WebRouteRegistry & Web Transport', () => {
    let routeRegistry: WebRouteRegistry
    let identityAdapter: WebIdentityAdapter
    let transport: WebRpcTransport

    beforeEach(() => {
        identityAdapter = new WebIdentityAdapter()
        routeRegistry = new WebRouteRegistry()
        transport = new WebRpcTransport(null, identityAdapter)
    })

    describe('Route Registry', () => {
        it('keeps auth status rpc profiling plugin-resources and static route order', () => {
            const routes: WebRouteContribution[] = [
                {
                    id: 'static',
                    method: '*',
                    path: '*',
                    order: 600,
                    authenticate: false,
                    handle: async () => ({ status: 200 }),
                },
                {
                    id: 'rpc',
                    method: 'POST',
                    path: '/api/rpc',
                    order: 300,
                    authenticate: true,
                    handle: async () => ({ status: 200 }),
                },
                {
                    id: 'auth',
                    method: '*',
                    path: '/api/auth/*',
                    order: 100,
                    authenticate: false,
                    handle: async () => ({ status: 200 }),
                },
                {
                    id: 'profiling',
                    method: '*',
                    path: '/api/profile/*,/debug/pprof/*',
                    order: 400,
                    authenticate: true,
                    handle: async () => ({ status: 200 }),
                },
                {
                    id: 'status',
                    method: 'GET',
                    path: '/api/status,/api/health',
                    order: 200,
                    authenticate: true,
                    handle: async () => ({ status: 200 }),
                },
                {
                    id: 'plugin-resources',
                    method: 'GET',
                    path: '/api/plugins/resources/*',
                    order: 500,
                    authenticate: true,
                    handle: async () => ({ status: 200 }),
                },
            ]

            for (const route of routes) {
                routeRegistry.register(route)
            }

            expect(routeRegistry.list().map((route) => route.id)).toEqual([
                'auth',
                'status',
                'rpc',
                'profiling',
                'plugin-resources',
                'static',
            ])
        })

        it('supports dynamic plugin route registration and unregistration', () => {
            const customRoute: WebRouteContribution = {
                id: 'custom-plugin-route',
                method: 'GET',
                path: '/api/custom',
                order: 250,
                authenticate: true,
                handle: async () => ({ status: 200, body: 'custom' }),
            }

            const unregister = routeRegistry.register(customRoute)
            expect(routeRegistry.get('custom-plugin-route')).toBeDefined()
            expect(routeRegistry.has('custom-plugin-route')).toBe(true)

            const matched = routeRegistry.match('GET', '/api/custom')
            expect(matched?.id).toBe('custom-plugin-route')

            unregister()
            expect(routeRegistry.has('custom-plugin-route')).toBe(false)
            expect(routeRegistry.match('GET', '/api/custom')).toBeUndefined()
        })

        it('matches route paths accurately with wildcard and method matching', () => {
            routeRegistry.register({
                id: 'exact-route',
                method: 'POST',
                path: '/api/exact',
                order: 100,
                authenticate: true,
                handle: async () => ({ status: 200 }),
            })

            routeRegistry.register({
                id: 'wildcard-route',
                method: 'GET',
                path: '/api/wildcard/*',
                order: 200,
                authenticate: true,
                handle: async () => ({ status: 200 }),
            })

            routeRegistry.register({
                id: 'fallback-static',
                method: '*',
                path: '*',
                order: 900,
                authenticate: false,
                handle: async () => ({ status: 200 }),
            })

            expect(routeRegistry.match('POST', '/api/exact')?.id).toBe('exact-route')
            expect(routeRegistry.match('GET', '/api/exact')?.id).toBe('fallback-static')
            expect(routeRegistry.match('GET', '/api/wildcard/sub/path')?.id).toBe('wildcard-route')
            expect(routeRegistry.match('GET', '/other/path')?.id).toBe('fallback-static')
        })
    })

    describe('Identity Adapter & RPC Transport', () => {
        it('injects client identity through invocation context', async () => {
            const handler = vi.fn().mockResolvedValue({ success: true })
            transport.setDispatcher(handler)

            const args = ['session-123', 'running', 'run-456', 'client-arg-ignore']
            await transport.dispatch('SessionBroadcastRunStatus', args, { clientId: 'web-1' })

            expect(handler).toHaveBeenCalledWith(
                'SessionBroadcastRunStatus',
                args,
                expect.objectContaining({
                    clientId: 'web-1',
                    transport: 'web',
                }),
            )
        })

        it('adapts HTTP RPC requests and provides default http-rpc client identity', async () => {
            const handler = vi.fn().mockResolvedValue({ status: 'ok' })
            transport.setDispatcher(handler)

            const httpResult = await transport.handleHttpRequest({
                id: 'req-1',
                method: 'session:getActiveRuns',
                args: ['sess-1'],
            })

            expect(httpResult).toEqual({
                id: 'req-1',
                result: { status: 'ok' },
            })
            expect(handler).toHaveBeenCalledWith(
                'session:getActiveRuns',
                ['sess-1'],
                expect.objectContaining({
                    clientId: 'http-rpc',
                    transport: 'web',
                }),
            )
        })

        it('adapts WebSocket RPC messages and injects connection clientId', async () => {
            const handler = vi.fn().mockResolvedValue('pong-data')
            transport.setDispatcher(handler)

            const wsContext = { clientId: 'client_ws_42_123456' }

            // Ping handling
            const pingRes = await transport.handleWsMessage(JSON.stringify({ type: 'ping' }), wsContext)
            expect(pingRes).toEqual({
                isPing: true,
                response: { type: 'pong' },
            })

            // RPC handling
            const rpcRes = await transport.handleWsMessage(
                JSON.stringify({
                    type: 'rpc',
                    id: 'ws-msg-1',
                    method: 'native:test',
                    args: ['data-1'],
                }),
                wsContext,
            )

            expect(rpcRes).toEqual({
                response: {
                    type: 'rpc_result',
                    id: 'ws-msg-1',
                    result: 'pong-data',
                },
            })

            expect(handler).toHaveBeenCalledWith(
                'native:test',
                ['data-1'],
                expect.objectContaining({
                    clientId: 'client_ws_42_123456',
                    transport: 'web',
                }),
            )
        })

        it('handles RPC errors gracefully in HTTP and WS transports', async () => {
            const handler = vi.fn().mockRejectedValue(new Error('RPC method execution failed'))
            transport.setDispatcher(handler)

            const httpRes = await transport.handleHttpRequest({
                id: 'req-err',
                method: 'broken:method',
                args: [],
            })
            expect(httpRes).toEqual({
                id: 'req-err',
                error: 'RPC method execution failed',
            })

            const wsRes = await transport.handleWsMessage(
                JSON.stringify({
                    type: 'rpc',
                    id: 'ws-err',
                    method: 'broken:method',
                    args: [],
                }),
                { clientId: 'client-1' },
            )
            expect(wsRes).toEqual({
                response: {
                    type: 'rpc_error',
                    id: 'ws-err',
                    error: 'RPC method execution failed',
                },
            })
        })
    })
})
