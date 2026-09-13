import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useGatewayDiscovery } from './useGatewayDiscovery'
import type { DiscoveredGateway } from '@cpa/plugin-api'
import { setHostBridge } from '@/application/services/hostTransport'

const mockGateways: DiscoveredGateway[] = [
    {
        instanceName: 'Test CPA',
        host: 'cpa.local',
        port: 8317,
        addresses: ['192.168.1.100'],
        primaryAddress: '192.168.1.100',
        baseUrl: 'http://192.168.1.100:8317',
        product: 'cliproxyapi',
        version: '1.0.0',
        authRequired: true,
    },
]

describe('useGatewayDiscovery', () => {
    afterEach(() => {
        setHostBridge(null)
    })

    it('initializes with default states', () => {
        const { result } = renderHook(() => useGatewayDiscovery())
        expect(result.current.isDiscovering).toBe(false)
        expect(result.current.gateways).toEqual([])
        expect(result.current.hasDiscovered).toBe(false)
        expect(result.current.error).toBeNull()
    })

    it('triggers discovery and updates states on success', async () => {
        const discoverFn = vi.fn().mockResolvedValue(mockGateways)
        const { result } = renderHook(() => useGatewayDiscovery({ discoverFn }))

        let promise: Promise<DiscoveredGateway[]>
        act(() => {
            promise = result.current.triggerDiscovery(1000)
        })

        expect(result.current.isDiscovering).toBe(true)
        let discovered: DiscoveredGateway[]
        await act(async () => {
            discovered = await promise!
        })
        expect(discovered!).toEqual(mockGateways)
        expect(result.current.isDiscovering).toBe(false)
        expect(result.current.gateways).toEqual(mockGateways)
        expect(result.current.hasDiscovered).toBe(true)
    })

    it('handles discovery error gracefully without crash', async () => {
        const discoverFn = vi.fn().mockRejectedValue(new Error('Network offline'))
        const { result } = renderHook(() => useGatewayDiscovery({ discoverFn }))

        await act(async () => {
            const list = await result.current.triggerDiscovery()
            expect(list).toEqual([])
        })

        expect(result.current.isDiscovering).toBe(false)
        expect(result.current.gateways).toEqual([])
        expect(result.current.hasDiscovered).toBe(true)
        expect(result.current.error).toBe('Network offline')
    })

    it('reuses ongoing promise when triggerDiscovery is called concurrently', async () => {
        let resolvePromise: (value: DiscoveredGateway[]) => void
        const deferred = new Promise<DiscoveredGateway[]>((resolve) => {
            resolvePromise = resolve
        })
        const discoverFn = vi.fn().mockReturnValue(deferred)
        const { result } = renderHook(() => useGatewayDiscovery({ discoverFn }))

        let p1: Promise<DiscoveredGateway[]>
        let p2: Promise<DiscoveredGateway[]>
        act(() => {
            p1 = result.current.triggerDiscovery(2000)
            p2 = result.current.triggerDiscovery(2000)
        })

        expect(p1!).toBe(p2!)
        expect(discoverFn).toHaveBeenCalledTimes(1)

        await act(async () => {
            resolvePromise!(mockGateways)
            await p1!
        })

        expect(result.current.isDiscovering).toBe(false)
        expect(result.current.gateways).toEqual(mockGateways)
        expect(result.current.hasDiscovered).toBe(true)
    })

    it('delegates to getHostBridge().GatewayDiscover when discoverFn is not provided', async () => {
        const gatewayDiscover = vi.fn().mockResolvedValue(mockGateways)
        setHostBridge({ GatewayDiscover: gatewayDiscover } as any)

        const { result } = renderHook(() => useGatewayDiscovery())

        let promise: Promise<DiscoveredGateway[]>
        act(() => {
            promise = result.current.triggerDiscovery(1500)
        })

        let discovered: DiscoveredGateway[]
        await act(async () => {
            discovered = await promise!
        })

        expect(gatewayDiscover).toHaveBeenCalledWith(1500)
        expect(discovered!).toEqual(mockGateways)
        expect(result.current.gateways).toEqual(mockGateways)
    })

    it('allows triggering a new discovery after previous discovery has finished', async () => {
        const discoverFn = vi.fn().mockResolvedValue(mockGateways)
        const { result } = renderHook(() => useGatewayDiscovery({ discoverFn }))

        await act(async () => {
            await result.current.triggerDiscovery(1000)
        })
        expect(discoverFn).toHaveBeenCalledTimes(1)

        const secondGateways: DiscoveredGateway[] = [
            {
                ...mockGateways[0],
                instanceName: 'Second CPA',
            },
        ]
        discoverFn.mockResolvedValue(secondGateways)

        await act(async () => {
            const list = await result.current.triggerDiscovery(2000)
            expect(list).toEqual(secondGateways)
        })
        expect(discoverFn).toHaveBeenCalledTimes(2)
        expect(result.current.gateways).toEqual(secondGateways)
    })

    it('handles non-array response from bridge safely', async () => {
        const discoverFn = vi.fn().mockResolvedValue(null as any)
        const { result } = renderHook(() => useGatewayDiscovery({ discoverFn }))

        await act(async () => {
            const list = await result.current.triggerDiscovery()
            expect(list).toEqual([])
        })
        expect(result.current.gateways).toEqual([])
        expect(result.current.hasDiscovered).toBe(true)
        expect(result.current.error).toBeNull()
    })

    it('handles component unmount cleanly while discovery is pending', async () => {
        let resolvePromise: (value: DiscoveredGateway[]) => void
        const deferred = new Promise<DiscoveredGateway[]>((resolve) => {
            resolvePromise = resolve
        })
        const discoverFn = vi.fn().mockReturnValue(deferred)
        const { result, unmount } = renderHook(() => useGatewayDiscovery({ discoverFn }))

        let promise: Promise<DiscoveredGateway[]>
        act(() => {
            promise = result.current.triggerDiscovery(2000)
        })

        expect(result.current.isDiscovering).toBe(true)
        unmount()

        await act(async () => {
            resolvePromise!(mockGateways)
            const list = await promise!
            expect(list).toEqual(mockGateways)
        })
    })

    it('allows retry and succeeds when discoverFn throws synchronously on first attempt', async () => {
        let attempt = 0
        const discoverFn = vi.fn().mockImplementation(() => {
            attempt++
            if (attempt === 1) {
                throw new Error('Synchronous discovery failure')
            }
            return Promise.resolve(mockGateways)
        })
        const { result } = renderHook(() => useGatewayDiscovery({ discoverFn }))

        let firstResult: DiscoveredGateway[] | undefined
        await act(async () => {
            firstResult = await result.current.triggerDiscovery()
        })

        expect(firstResult).toEqual([])
        expect(result.current.error).toBe('Synchronous discovery failure')
        expect(result.current.isDiscovering).toBe(false)
        expect(result.current.hasDiscovered).toBe(true)
        expect(discoverFn).toHaveBeenCalledTimes(1)

        let secondResult: DiscoveredGateway[] | undefined
        await act(async () => {
            secondResult = await result.current.triggerDiscovery()
        })

        expect(secondResult).toEqual(mockGateways)
        expect(result.current.error).toBeNull()
        expect(result.current.gateways).toEqual(mockGateways)
        expect(result.current.isDiscovering).toBe(false)
        expect(discoverFn).toHaveBeenCalledTimes(2)
    })

    it('deduplicates across interleaved calls without clearing subsequent ongoing scan', async () => {
        let resolveFirst: (value: DiscoveredGateway[]) => void
        const firstDeferred = new Promise<DiscoveredGateway[]>((resolve) => {
            resolveFirst = resolve
        })

        let resolveSecond: (value: DiscoveredGateway[]) => void
        const secondDeferred = new Promise<DiscoveredGateway[]>((resolve) => {
            resolveSecond = resolve
        })

        const discoverFn = vi.fn()
            .mockImplementationOnce(() => firstDeferred)
            .mockImplementation(() => secondDeferred)

        const { result } = renderHook(() => useGatewayDiscovery({ discoverFn }))

        let p1: Promise<DiscoveredGateway[]>
        act(() => {
            p1 = result.current.triggerDiscovery(1000)
        })
        expect(discoverFn).toHaveBeenCalledTimes(1)

        let p2: Promise<DiscoveredGateway[]> | undefined
        let p3: Promise<DiscoveredGateway[]> | undefined

        // Attach to p1 resolution: trigger p2 immediately, and trigger p3 in next microtask while p2 is in flight
        const chained = p1!.then(() => {
            p2 = result.current.triggerDiscovery(2000)
            return Promise.resolve().then(() => {
                p3 = result.current.triggerDiscovery(2000)
            })
        })

        await act(async () => {
            resolveFirst!(mockGateways)
            await chained
        })

        expect(p2).toBeDefined()
        expect(p3).toBeDefined()
        expect(p2).toBe(p3)
        expect(discoverFn).toHaveBeenCalledTimes(2)

        const secondGateways: DiscoveredGateway[] = [
            {
                ...mockGateways[0],
                instanceName: 'Second CPA',
            },
        ]

        await act(async () => {
            resolveSecond!(secondGateways)
            const res = await p2!
            expect(res).toEqual(secondGateways)
        })

        expect(result.current.isDiscovering).toBe(false)
        expect(result.current.gateways).toEqual(secondGateways)
    })
})
