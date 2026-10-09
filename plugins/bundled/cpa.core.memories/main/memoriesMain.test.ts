import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcDescriptor, RpcInvocationContext, ServiceDescriptor } from '@cpa/plugin-api'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import memoriesDefaultEntry, { entry, memoriesMainEntry } from './index.js'
import { MemoriesDatabaseService } from './memoriesDatabaseService.js'
import manifest from '../manifest.json' with { type: 'json' }

const rpcContext: RpcInvocationContext = {
    pluginId: manifest.id,
    senderId: 1,
    frameUrl: 'https://cpa.test',
    transport: 'electron',
}

async function activateMemories() {
    const harness = createPluginTestHarness(memoriesMainEntry, { manifest })
    await harness.activate()
    const descriptor = harness.getRegistered<ServiceDescriptor<MemoriesDatabaseService>>('service')[0]!.value
    const service = await descriptor.create({
        get: vi.fn(),
        capabilities: harness.context.capabilities,
        getCapability: vi.fn(),
    })
    const rpcs = new Map(harness.getRegistered<RpcDescriptor>('rpc').map((rpc) => [rpc.id, rpc.value]))
    return { harness, descriptor, service, rpcs }
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe('cpa.core.memories main entry', () => {
    it('registers the declared service and four RPCs with scoped capabilities and no aliases', async () => {
        const { harness, descriptor, service, rpcs } = await activateMemories()
        try {
            expect(memoriesMainEntry.runtime).toBe('main')
            expect(entry).toBe(memoriesMainEntry)
            expect(memoriesDefaultEntry).toBe(memoriesMainEntry)
            expect(harness.getRegistered('service').map((s) => s.id)).toEqual(['memoriesDatabaseService'])
            expect(descriptor.id).toBe('memoriesDatabaseService')
            expect(descriptor.dependencies).toEqual([])
            expect([...rpcs.keys()].sort()).toEqual([
                'memories:add', 'memories:clear', 'memories:read', 'memories:search',
            ])
            for (const [method, rpc] of rpcs) {
                expect(rpc.method).toBe(method)
                expect(rpc.ipcChannel).toBe(method)
                expect(rpc.capability).toBe(
                    method === 'memories:search' || method === 'memories:read' ? 'memories.read' : 'memories.write',
                )
                expect(rpc).not.toHaveProperty('aliases')
            }
            expect(manifest.entries.main).toBe('./main/index.ts')
            expect(manifest.capabilities).toEqual(['memories.*'])
            expect(manifest.contributes.service).toEqual(['memoriesDatabaseService'])
            expect([...manifest.contributes.rpc].sort()).toEqual([...rpcs.keys()].sort())
        } finally {
            await descriptor.dispose!(service)
        }
    })

    it.each(['search', 'read', 'add'] as const)('passes args[0] unchanged to service.%s without duplicate validation', async (method) => {
        const { descriptor, service, rpcs } = await activateMemories()
        try {
            const request = { deliberatelyInvalid: true }
            const result = { forwarded: true }
            const spy = vi.spyOn(service, method).mockReturnValue(result as never)
            expect(await rpcs.get(`memories:${method}`)!.invoke(rpcContext, [request, 'ignored'])).toBe(result)
            expect(spy).toHaveBeenCalledExactlyOnceWith(request)
        } finally {
            await descriptor.dispose!(service)
        }
    })

    it.each(['search', 'read', 'add'] as const)('reports a readable error for memories:%s without args[0]', async (method) => {
        const { descriptor, service, rpcs } = await activateMemories()
        try {
            await expect(rpcs.get(`memories:${method}`)!.invoke(rpcContext, [])).rejects.toThrow('request must be an object')
        } finally {
            await descriptor.dispose!(service)
        }
    })

    it('calls service.clear without arguments', async () => {
        const { descriptor, service, rpcs } = await activateMemories()
        try {
            const spy = vi.spyOn(service, 'clear').mockReturnValue(undefined)
            expect(await rpcs.get('memories:clear')!.invoke(rpcContext, ['ignored'])).toBeUndefined()
            expect(spy).toHaveBeenCalledExactlyOnceWith()
        } finally {
            await descriptor.dispose!(service)
        }
    })

    it('closes the database service when the service descriptor is disposed', async () => {
        const { descriptor, service } = await activateMemories()
        const spy = vi.spyOn(service, 'close')
        await descriptor.dispose!(service)
        expect(spy).toHaveBeenCalledExactlyOnceWith()
    })

    it('routes add, search, read and clear to the same real database service', async () => {
        const { descriptor, service, rpcs } = await activateMemories()
        try {
            const added = await rpcs.get('memories:add')!.invoke(rpcContext, [{ title: 'RPC memory', note: 'sqlite wiring' }])
            expect(added).toEqual({ success: true, id: 1 })
            expect(service.read({ ids: [1] }).memories[0]?.title).toBe('RPC memory')
            expect(await rpcs.get('memories:search')!.invoke(rpcContext, [{ queries: ['sqlite'] }])).toEqual({
                matches: [{ id: 1, title: 'RPC memory', matchedQueries: ['sqlite'], snippet: 'sqlite wiring' }],
                truncated: false,
            })
            expect(await rpcs.get('memories:read')!.invoke(rpcContext, [{ ids: [1] }])).toEqual({
                memories: [{ id: 1, title: 'RPC memory', content: 'sqlite wiring', truncated: false }],
                missingIds: [],
            })
            await rpcs.get('memories:clear')!.invoke(rpcContext, [])
            expect(service.search({ queries: ['sqlite'] }).matches).toEqual([])
        } finally {
            await descriptor.dispose!(service)
        }
    })

    it('propagates service errors to the RPC caller', async () => {
        const { descriptor, service, rpcs } = await activateMemories()
        try {
            const error = new Error('database unavailable')
            vi.spyOn(service, 'search').mockImplementation(() => { throw error })
            await expect(rpcs.get('memories:search')!.invoke(rpcContext, [{ queries: ['sqlite'] }])).rejects.toBe(error)
        } finally {
            await descriptor.dispose!(service)
        }
    })
})
