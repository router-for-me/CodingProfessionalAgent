import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/features/agent-runtime/native/electronNativeBridge', () => {
    return {
        ElectronNativeBridge: class FakeBridge {
            dispose = vi.fn(async () => undefined)
        },
    }
})

vi.mock('@/features/agent-runtime/CLIProxyAPIAgentService', () => {
    return {
        CLIProxyAPIAgentService: class FakeService {
            dispose = vi.fn(async () => undefined)
        },
    }
})

vi.mock('@/features/agent/useAgentStream', async () => {
    const actual = await vi.importActual<typeof import('@/features/agent/useAgentStream')>(
        '@/features/agent/useAgentStream',
    )
    return {
        ...actual,
        disposeAgentRuntime: vi.fn(async (service: { dispose: () => void | Promise<void> }) => {
            await Promise.resolve(service.dispose())
        }),
    }
})

describe('production agent runtime factory', () => {
    afterEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
    })

    it('create/dispose counts are balanced (StrictMode safe)', async () => {
        const mod = await import('./providers')
        mod.__resetProductionRuntimeCountersForTests()

        const first = mod.createProductionAgentRuntime()
        const second = mod.createProductionAgentRuntime()
        expect(mod.__getProductionRuntimeCountersForTests()).toEqual({
            create: 2,
            dispose: 0,
        })

        await first.dispose()
        await second.dispose()
        // Idempotent second dispose must not double-count.
        await first.dispose()

        expect(mod.__getProductionRuntimeCountersForTests()).toEqual({
            create: 2,
            dispose: 2,
        })
    })

    it('createRuntimeLease serializes create1-dispose1-before-create2', async () => {
        const mod = await import('./providers')
        const events: string[] = []
        let id = 0
        const lease = mod.createRuntimeLease(() => {
            const n = ++id
            events.push(`create${n}`)
            return {
                resource: { id: n },
                dispose: async () => {
                    events.push(`dispose${n}`)
                },
            }
        })

        const a = await lease.acquire()
        expect(a.resource.id).toBe(1)

        // Start dispose without awaiting fully before next acquire is queued.
        const disposeA = a.dispose()
        const bPromise = lease.acquire()

        await disposeA
        const b = await bPromise
        expect(b.resource.id).toBe(2)
        await b.dispose()

        expect(events).toEqual(['create1', 'dispose1', 'create2', 'dispose2'])
        // Exactly one dispose per create.
        expect(events.filter((e) => e.startsWith('create'))).toHaveLength(2)
        expect(events.filter((e) => e.startsWith('dispose'))).toHaveLength(2)
    })

    it('createRuntimeLease dispose is idempotent and flush observes chain', async () => {
        const mod = await import('./providers')
        let disposeCount = 0
        const lease = mod.createRuntimeLease(() => ({
            resource: { ok: true },
            dispose: async () => {
                disposeCount += 1
            },
        }))
        const a = await lease.acquire()
        await a.dispose()
        await a.dispose()
        await lease.flush()
        expect(disposeCount).toBe(1)
    })

    it('createRuntimeLease cancels mid-acquire when isCancelled is true', async () => {
        const mod = await import('./providers')
        const events: string[] = []
        let id = 0
        const lease = mod.createRuntimeLease(() => {
            const n = ++id
            events.push(`create${n}`)
            return {
                resource: { id: n },
                dispose: async () => {
                    events.push(`dispose${n}`)
                },
            }
        })

        await expect(lease.acquire(() => true)).rejects.toMatchObject({
            name: 'AbortError',
        })
        expect(events).toEqual(['create1', 'dispose1'])

        const live = await lease.acquire(() => false)
        expect(live.resource.id).toBe(2)
        await live.dispose()
        expect(events).toEqual(['create1', 'dispose1', 'create2', 'dispose2'])
    })
})
