import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContributionRegistry, PluginEventBus } from '@cpa/plugin-kernel'
import type { ResolvedPluginPackage, RpcDescriptor, UtilityExecutorHandle } from '@cpa/plugin-api'
import { MainCapabilityBroker } from '../src/main/plugins/capabilities/MainCapabilityBroker.js'
import { bindCapabilityContributions } from '../src/main/plugins/capabilities/bindCapabilityContributions.js'
import { bindUtilityExecutors } from '../src/main/plugins/capabilities/utilityExecutors.js'

const fork = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ utilityProcess: { fork } }))
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); fork.mockReset() })
const context = { pluginId: 'test-owner', senderId: 0, frameUrl: '', transport: 'electron' as const, runtime: 'main' as const, generation: 1 }

it('binds committed RPCs and scoped event contributions equally for Electron and Web handles', async () => {
    const registry = new ContributionRegistry()
    const events = new PluginEventBus()
    const broker = new MainCapabilityBroker()
    const dispose = bindCapabilityContributions(registry, events, broker)
    const transaction = registry.beginActivation({ id: 'test-owner', version: '1.0.0' })
    transaction.register<RpcDescriptor>('rpc', 'custom:invoke', { method: 'custom:invoke', capability: 'custom.execute', invoke: async (ctx, args) => ({ generation: ctx.generation, value: args[0] }) })
    transaction.register('native-event', 'custom:event', { event: 'custom:event', capability: 'custom.execute' })
    transaction.commit()
    try {
        for (const transport of ['electron', 'web'] as const) {
            const sender = { ...context, transport, runtime: 'agent' as const }
            const handle = broker.grant(sender, ['custom.execute'], 1)
            expect(await broker.invoke(handle, 'custom:invoke', [42], sender)).toEqual({ generation: 1, value: 42 })
            const received: unknown[] = []
            const unsubscribe = broker.subscribe(handle, 'custom:event', (payload) => received.push(payload), sender)
            await events.emit('custom:event', { value: 'stream' })
            expect(received).toEqual([{ value: 'stream' }])
            unsubscribe()
        }
        registry.revokeOwner(transaction.ownerToken)
        const handle = broker.grant(context, ['custom.execute'], 1)
        await expect(broker.invoke(handle, 'custom:invoke', [], context)).rejects.toThrow('Unknown capability method')
    } finally { dispose() }
})

describe('main-only whitelist utility capability', () => {
    it('rejects unregistered modules and renderer callers; revocation terminates the fork', async () => {
        const root = mkdtempSync(join(tmpdir(), 'cpa-utility-whitelist-'))
        directories.push(root)
        const modulePath = join(root, 'executor.js')
        writeFileSync(modulePath, '// Test executor module.\n')
        const registry = new ContributionRegistry()
        const broker = new MainCapabilityBroker()
        const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), postMessage: vi.fn(), kill: vi.fn() })
        fork.mockReturnValue(child)
        const pkg = { sourceRoot: root, source: { kind: 'bundled', spec: 'bundled:test-owner' }, manifest: { id: 'test-owner' } } as ResolvedPluginPackage
        const dispose = bindUtilityExecutors(broker, registry, () => pkg, root)
        const mainHandle = broker.grant(context, ['process.utility'], 1)
        try {
            await expect(broker.invoke(mainHandle, 'runtime.utility.fork', ['missing'], context)).rejects.toThrow('whitelist')
            const transaction = registry.beginActivation({ id: 'test-owner', version: '1.0.0' })
            transaction.register('background-job', 'executor', { moduleUrl: pathToFileURL(modulePath).href })
            transaction.commit()
            const renderer = { ...context, runtime: 'renderer' as const }
            const rendererHandle = broker.grant(renderer, ['process.utility'], 1)
            await expect(broker.invoke(rendererHandle, 'runtime.utility.fork', ['executor'], renderer)).rejects.toThrow('main-runtime only')
            const handle = await broker.invoke(mainHandle, 'runtime.utility.fork', ['executor'], context) as UtilityExecutorHandle
            handle.postMessage({ type: 'ping' })
            expect(child.postMessage).toHaveBeenCalledWith({ type: 'ping' })
            expect(fork).toHaveBeenCalledTimes(1)
            registry.revokeOwner(transaction.ownerToken)
            expect(child.kill).toHaveBeenCalledTimes(1)
        } finally { dispose() }
    })
    it('rejects an executor outside its package root', async () => {
        const root = mkdtempSync(join(tmpdir(), 'cpa-utility-root-'))
        const outside = mkdtempSync(join(tmpdir(), 'cpa-utility-outside-'))
        directories.push(root, outside)
        const modulePath = join(outside, 'executor.js')
        writeFileSync(modulePath, '// Outside module.\n')
        const registry = new ContributionRegistry()
        const broker = new MainCapabilityBroker()
        const transaction = registry.beginActivation({ id: 'test-owner', version: '1.0.0' })
        transaction.register('background-job', 'executor', { moduleUrl: pathToFileURL(modulePath).href })
        transaction.commit()
        const pkg = { sourceRoot: root, source: { kind: 'bundled' }, manifest: { id: 'test-owner' } } as ResolvedPluginPackage
        const dispose = bindUtilityExecutors(broker, registry, () => pkg, root)
        try {
            const handle = broker.grant(context, ['process.utility'], 1)
            await expect(broker.invoke(handle, 'runtime.utility.fork', ['executor'], context)).rejects.toThrow('within its plugin package')
            expect(fork).not.toHaveBeenCalled()
        } finally { dispose() }
    })
})
