import { describe, expect, it } from 'vitest'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import { settingsMainEntry } from './index.js'
import manifest from '../manifest.json' with { type: 'json' }
import type { RpcDescriptor, ServiceDescriptor } from '@cpa/plugin-api'
import { KVStoreService } from './kvStoreService.js'

describe('settingsMainEntry', () => {
    it('registers kvStoreService and kvstore RPC descriptors on activation', async () => {
        const harness = createPluginTestHarness(settingsMainEntry, { manifest })
        await harness.activate()

        const services = harness.getRegistered('service')
        expect(services.map((s) => s.id)).toEqual(['kvStoreService'])

        const rpcs = harness.getRegistered('rpc')
        const rpcMethods = rpcs.map((r) => (r.value as RpcDescriptor).method).sort()
        expect(rpcMethods).toEqual(['kvstore:get', 'kvstore:save', 'kvstore:set'])

        const kvStoreServiceDesc = services.find((s) => s.id === 'kvStoreService')?.value as ServiceDescriptor<KVStoreService>
        expect(kvStoreServiceDesc).toBeDefined()
        const instance = kvStoreServiceDesc.create({} as any)
        expect(instance).toBeInstanceOf(KVStoreService)
    })
})
