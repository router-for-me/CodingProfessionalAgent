import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PluginEntryDefinition, ResolvedPluginPackage } from '@cpa/plugin-api'
import {
    RendererPluginRuntimeHost,
    createRendererRuntimeHost,
} from './RendererPluginRuntimeHost'
import { rendererRegistry } from './rendererRegistry'

describe('RendererPluginRuntimeHost', () => {
    beforeEach(() => {
        rendererRegistry.clear()
    })

    it('activates renderer entries in resolved dependency order', async () => {
        const activationOrder: string[] = []

        const corePackage: ResolvedPluginPackage = {
            manifest: {
                id: 'cpa.test.core',
                name: 'Core Test Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                activationPriority: 10,
                dependencies: {},
                capabilities: [],
                contributes: {},
                entries: { renderer: './index.ts' },
            },
            entries: { renderer: './index.ts' },
            sourceRoot: 'plugins/test/core',
            source: { kind: 'bundled', spec: 'bundled:cpa.test.core' },
        }

        const chatPackage: ResolvedPluginPackage = {
            manifest: {
                id: 'cpa.test.chat',
                name: 'Chat Test Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                dependencies: { 'cpa.test.core': '>=1.0.0' },
                activationPriority: 20,
                capabilities: [],
                contributes: {},
                entries: { renderer: './index.ts' },
            },
            entries: { renderer: './index.ts' },
            sourceRoot: 'plugins/test/chat',
            source: { kind: 'bundled', spec: 'bundled:cpa.test.chat' },
        }

        const definitions: Record<string, PluginEntryDefinition> = {
            'cpa.test.core': {
                runtime: 'renderer',
                activate: () => {
                    activationOrder.push('core')
                },
            },
            'cpa.test.chat': {
                runtime: 'renderer',
                activate: () => {
                    activationOrder.push('chat')
                },
            },
        }

        const host = createRendererRuntimeHost({
            bundledPackages: [chatPackage, corePackage],
            defaultDefinitions: definitions,
        })

        await host.activateAll()

        expect(activationOrder).toEqual(['core', 'chat'])
        expect(host.isPluginActive('cpa.test.core')).toBe(true)
        expect(host.isPluginActive('cpa.test.chat')).toBe(true)
    })

    it('does not expose staged contributions from a failing plugin', async () => {
        const faultyPackage: ResolvedPluginPackage = {
            manifest: {
                id: 'cpa.test.faulty',
                name: 'Faulty Test Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                criticality: 'optional',
                activationPriority: 10,
                dependencies: {},
                capabilities: [],
                contributes: {
                    slot: ['faulty-slot'],
                },
                entries: { renderer: './index.ts' },
            },
            entries: { renderer: './index.ts' },
            sourceRoot: 'plugins/test/faulty',
            source: { kind: 'bundled', spec: 'bundled:cpa.test.faulty' },
        }

        const definitions: Record<string, PluginEntryDefinition> = {
            'cpa.test.faulty': {
                runtime: 'renderer',
                activate: (context) => {
                    context.register({
                        kind: 'slot',
                        id: 'faulty-slot',
                        target: 'test.slot',
                        value: { component: () => null },
                    })
                    throw new Error('Explosion during activation')
                },
            },
        }

        const host = createRendererRuntimeHost({
            bundledPackages: [faultyPackage],
            defaultDefinitions: definitions,
        })

        await host.activateAll()

        expect(host.isPluginActive('cpa.test.faulty')).toBe(false)
        expect(host.registry.getSlotContributions('test.slot')).toEqual([])
        const summary = host.getPluginSummary('cpa.test.faulty')
        expect(summary.status).toBe('error')
        expect(summary.error).toContain('Explosion during activation')
    })

    it('isolates single plugin failure and activates subsequent healthy plugins', async () => {
        const faultyPackage: ResolvedPluginPackage = {
            manifest: {
                id: 'cpa.test.faulty',
                name: 'Faulty Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                criticality: 'optional',
                activationPriority: 10,
                dependencies: {},
                capabilities: [],
                contributes: {},
                entries: { renderer: './index.ts' },
            },
            entries: { renderer: './index.ts' },
            sourceRoot: 'plugins/test/faulty',
            source: { kind: 'bundled', spec: 'bundled:cpa.test.faulty' },
        }

        const healthyPackage: ResolvedPluginPackage = {
            manifest: {
                id: 'cpa.test.healthy',
                name: 'Healthy Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                activationPriority: 20,
                dependencies: {},
                capabilities: [],
                contributes: {
                    slot: ['healthy-slot'],
                },
                entries: { renderer: './index.ts' },
            },
            entries: { renderer: './index.ts' },
            sourceRoot: 'plugins/test/healthy',
            source: { kind: 'bundled', spec: 'bundled:cpa.test.healthy' },
        }

        const HealthyComponent = () => null

        const definitions: Record<string, PluginEntryDefinition> = {
            'cpa.test.faulty': {
                runtime: 'renderer',
                activate: () => {
                    throw new Error('Failed activation')
                },
            },
            'cpa.test.healthy': {
                runtime: 'renderer',
                activate: (context) => {
                    context.register({
                        kind: 'slot',
                        id: 'healthy-slot',
                        target: 'test.slot',
                        value: { component: HealthyComponent, order: 10 },
                    })
                },
            },
        }

        const host = createRendererRuntimeHost({
            bundledPackages: [faultyPackage, healthyPackage],
            defaultDefinitions: definitions,
        })

        await host.activateAll()

        expect(host.isPluginActive('cpa.test.faulty')).toBe(false)
        expect(host.isPluginActive('cpa.test.healthy')).toBe(true)

        const contributions = host.registry.getSlotContributions('test.slot')
        expect(contributions).toHaveLength(1)
        expect(contributions[0].id).toBe('healthy-slot')
    })

    it('deactivates plugin and revokes contributions in reverse dependency order', async () => {
        const deactivations: string[] = []

        const parentPkg: ResolvedPluginPackage = {
            manifest: {
                id: 'cpa.test.parent',
                name: 'Parent Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                activationPriority: 10,
                dependencies: {},
                capabilities: [],
                contributes: {
                    slot: ['parent-slot'],
                },
                entries: { renderer: './index.ts' },
            },
            entries: { renderer: './index.ts' },
            sourceRoot: 'plugins/test/parent',
            source: { kind: 'bundled', spec: 'bundled:cpa.test.parent' },
        }

        const childPkg: ResolvedPluginPackage = {
            manifest: {
                id: 'cpa.test.child',
                name: 'Child Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                dependencies: { 'cpa.test.parent': '>=1.0.0' },
                activationPriority: 20,
                capabilities: [],
                contributes: {
                    slot: ['child-slot'],
                },
                entries: { renderer: './index.ts' },
            },
            entries: { renderer: './index.ts' },
            sourceRoot: 'plugins/test/child',
            source: { kind: 'bundled', spec: 'bundled:cpa.test.child' },
        }

        const definitions: Record<string, PluginEntryDefinition> = {
            'cpa.test.parent': {
                runtime: 'renderer',
                activate: (context) => {
                    context.register({
                        kind: 'slot',
                        id: 'parent-slot',
                        target: 'parent.target',
                        value: { component: () => null },
                    })
                },
                deactivate: () => {
                    deactivations.push('parent')
                },
            },
            'cpa.test.child': {
                runtime: 'renderer',
                activate: (context) => {
                    context.register({
                        kind: 'slot',
                        id: 'child-slot',
                        target: 'child.target',
                        value: { component: () => null },
                    })
                },
                deactivate: () => {
                    deactivations.push('child')
                },
            },
        }

        const host = createRendererRuntimeHost({
            bundledPackages: [parentPkg, childPkg],
            defaultDefinitions: definitions,
        })

        await host.activateAll()
        expect(host.isPluginActive('cpa.test.parent')).toBe(true)
        expect(host.isPluginActive('cpa.test.child')).toBe(true)

        // Deactivating parent should cascade and deactivate child first
        await host.deactivatePlugin('cpa.test.parent')

        expect(deactivations).toEqual(['child', 'parent'])
        expect(host.isPluginActive('cpa.test.parent')).toBe(false)
        expect(host.isPluginActive('cpa.test.child')).toBe(false)
        expect(host.registry.getSlotContributions('parent.target')).toHaveLength(0)
        expect(host.registry.getSlotContributions('child.target')).toHaveLength(0)
    })

    it('records plugin runtime error and updates summary', () => {
        const pkg: ResolvedPluginPackage = {
            manifest: {
                id: 'cpa.test.surface',
                name: 'Surface Test Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                activationPriority: 10,
                dependencies: {},
                capabilities: [],
                contributes: {},
                entries: { renderer: './index.ts' },
            },
            entries: { renderer: './index.ts' },
            sourceRoot: 'plugins/test/surface',
            source: { kind: 'bundled', spec: 'bundled:cpa.test.surface' },
        }

        const host = createRendererRuntimeHost({
            bundledPackages: [pkg],
            defaultDefinitions: {
                'cpa.test.surface': {
                    runtime: 'renderer',
                    activate: () => {},
                },
            },
        })

        const listener = vi.fn()
        host.subscribe(listener)

        host.recordPluginError('cpa.test.surface', new Error('Visible check threw'))

        const summary = host.getPluginSummary('cpa.test.surface')
        expect(summary.error).toBe('Visible check threw')
        expect(listener).toHaveBeenCalled()
    })

    it('manages generation leases correctly', async () => {
        const pkg: ResolvedPluginPackage = {
            manifest: {
                id: 'cpa.test.lease',
                name: 'Lease Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                activationPriority: 10,
                dependencies: {},
                capabilities: [],
                contributes: {},
                entries: { renderer: './index.ts' },
            },
            entries: { renderer: './index.ts' },
            sourceRoot: 'plugins/test/lease',
            source: { kind: 'bundled', spec: 'bundled:cpa.test.lease' },
        }

        const host = createRendererRuntimeHost({
            bundledPackages: [pkg],
            defaultDefinitions: {
                'cpa.test.lease': {
                    runtime: 'renderer',
                    activate: () => {},
                },
            },
        })

        await host.activateAll()
        const lease = host.acquireGeneration(['cpa.test.lease'])
        expect(lease).toBeDefined()
        expect(typeof lease.release).toBe('function')

        let deactivationFinished = false
        const deactPromise = host.deactivatePlugin('cpa.test.lease').then(() => {
            deactivationFinished = true
        })

        // Give microtasks a tick; deactivation should block on active lease
        await new Promise((r) => setTimeout(r, 10))
        expect(deactivationFinished).toBe(false)

        lease.release()
        await deactPromise
        expect(deactivationFinished).toBe(true)
        expect(host.isPluginActive('cpa.test.lease')).toBe(false)
    })

    it('triggers slot and component-wrapper reactive subscriptions on dynamic activation and deactivation', async () => {
        const extPackage: ResolvedPluginPackage = {
            manifest: {
                id: 'cpa.test.ext',
                name: 'Extension Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                activationPriority: 10,
                dependencies: {},
                capabilities: [],
                contributes: {
                    slot: ['ext-btn'],
                    'component-wrapper': ['ext-wrap'],
                },
                entries: { renderer: './index.ts' },
            },
            entries: { renderer: './index.ts' },
            sourceRoot: 'plugins/test/ext',
            source: { kind: 'bundled', spec: 'bundled:cpa.test.ext' },
        }

        const definitions: Record<string, PluginEntryDefinition> = {
            'cpa.test.ext': {
                runtime: 'renderer',
                activate: (context: any) => {
                    context.registerSlotComponent('chat.composer.actions', {
                        id: 'ext-btn',
                        component: () => null,
                    })
                    context.registerComponentWrapper({
                        id: 'ext-wrap',
                        targetComponent: 'chat.message',
                        wrapper: (Comp: any) => Comp,
                    })
                },
            },
        }

        const host = createRendererRuntimeHost({
            bundledPackages: [extPackage],
            defaultDefinitions: definitions,
        })

        const slotListener = vi.fn()
        const slotPrefixedListener = vi.fn()
        const wrapperListener = vi.fn()
        const wrapperPrefixedListener = vi.fn()

        host.registry.subscribe('chat.composer.actions', slotListener)
        host.registry.subscribe('slot:chat.composer.actions', slotPrefixedListener)
        host.registry.subscribe('componentWrapper:chat.message', wrapperListener)
        host.registry.subscribe('component-wrapper:chat.message', wrapperPrefixedListener)

        expect(slotListener).not.toHaveBeenCalled()
        expect(slotPrefixedListener).not.toHaveBeenCalled()
        expect(wrapperListener).not.toHaveBeenCalled()
        expect(wrapperPrefixedListener).not.toHaveBeenCalled()

        // 1. Dynamic activation
        await host.activatePlugin('cpa.test.ext')

        expect(slotListener).toHaveBeenCalledTimes(1)
        expect(slotPrefixedListener).toHaveBeenCalledTimes(1)
        expect(wrapperListener).toHaveBeenCalledTimes(1)
        expect(wrapperPrefixedListener).toHaveBeenCalledTimes(1)

        expect(host.registry.getSlotContributions('chat.composer.actions')).toHaveLength(1)
        expect(host.registry.getComponentWrappers('chat.message')).toHaveLength(1)

        // 2. Dynamic deactivation
        await host.deactivatePlugin('cpa.test.ext')

        expect(slotListener).toHaveBeenCalledTimes(2)
        expect(slotPrefixedListener).toHaveBeenCalledTimes(2)
        expect(wrapperListener).toHaveBeenCalledTimes(2)
        expect(wrapperPrefixedListener).toHaveBeenCalledTimes(2)

        expect(host.registry.getSlotContributions('chat.composer.actions')).toHaveLength(0)
        expect(host.registry.getComponentWrappers('chat.message')).toHaveLength(0)
    })

    it('does not mutate catalog before commit, and rollback preserves original catalog state', async () => {
        const pkg1: ResolvedPluginPackage = {
            manifest: {
                id: 'cpa.test.pkg1',
                name: 'Package 1',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                dependencies: {},
                capabilities: [],
                contributes: {},
                entries: { renderer: './index.ts' },
            },
            entries: { renderer: './index.ts' },
            sourceRoot: 'plugins/test/pkg1',
            source: { kind: 'bundled', spec: 'bundled:cpa.test.pkg1' },
        }

        const pkg2: ResolvedPluginPackage = {
            manifest: {
                id: 'cpa.test.pkg2',
                name: 'Package 2',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                dependencies: {},
                capabilities: [],
                contributes: {},
                entries: { renderer: './index.ts' },
            },
            entries: { renderer: './index.ts' },
            sourceRoot: 'plugins/test/pkg2',
            source: { kind: 'bundled', spec: 'bundled:cpa.test.pkg2' },
        }

        const host = createRendererRuntimeHost({
            bundledPackages: [pkg1],
            defaultDefinitions: {
                'cpa.test.pkg1': {
                    runtime: 'renderer',
                    activate: () => {},
                },
                'cpa.test.pkg2': {
                    runtime: 'renderer',
                    activate: () => {},
                },
            },
        })

        await host.activateAll()
        expect(host.catalog.hasPackage('cpa.test.pkg1')).toBe(true)
        expect(host.catalog.hasPackage('cpa.test.pkg2')).toBe(false)

        // Prepare Generation with pkg2 included
        const prepared = await host.prepareGeneration([pkg1, pkg2], 2)

        // Before commit: catalog must NOT contain pkg2
        expect(host.catalog.hasPackage('cpa.test.pkg2')).toBe(false)
        expect(host.isPluginActive('cpa.test.pkg2')).toBe(false)

        // Rollback
        await prepared.rollback()
        expect(host.catalog.hasPackage('cpa.test.pkg2')).toBe(false)
        expect(host.isPluginActive('cpa.test.pkg2')).toBe(false)
        expect(host.isPluginActive('cpa.test.pkg1')).toBe(true)

        // Now prepare and commit
        const prepared2 = await host.prepareGeneration([pkg1, pkg2], 2)
        expect(host.catalog.hasPackage('cpa.test.pkg2')).toBe(false)

        await prepared2.commit()
        expect(host.catalog.hasPackage('cpa.test.pkg2')).toBe(true)
        expect(host.isPluginActive('cpa.test.pkg2')).toBe(true)
    })

    it('exposes external plugin summaries from committed ResolvedPluginGraphDTO without polluting Catalog or faking sourceRoot', async () => {
        const bundledPkg: ResolvedPluginPackage = {
            manifest: {
                id: 'cpa.test.bundled',
                name: 'Bundled Package',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                dependencies: {},
                capabilities: [],
                contributes: {},
                entries: { renderer: './index.ts' },
            },
            entries: { renderer: './index.ts' },
            sourceRoot: 'plugins/bundled/cpa.test.bundled',
            source: { kind: 'bundled', spec: 'bundled:cpa.test.bundled' },
        }

        const host = createRendererRuntimeHost({
            bundledPackages: [bundledPkg],
            defaultDefinitions: {
                'cpa.test.bundled': {
                    runtime: 'renderer',
                    activate: () => {},
                },
            },
        })

        const graphDTO = {
            revision: 'rev-external-test-1',
            createdAt: Date.now(),
            plugins: [
                {
                    id: 'cpa.test.bundled',
                    name: 'Bundled Package',
                    version: '1.0.0',
                    manifest: bundledPkg.manifest,
                    source: bundledPkg.source,
                    sourceKind: 'bundled' as const,
                    entries: { renderer: './index.ts' },
                    criticality: 'required' as const,
                    dependencies: {},
                },
                {
                    id: 'cpa.external.custom',
                    name: 'Custom External Plugin',
                    version: '2.1.0',
                    manifest: {
                        id: 'cpa.external.custom',
                        name: 'Custom External Plugin',
                        version: '2.1.0',
                        apiVersion: '1.0.0',
                        engines: { cpa: '>=1.0.0' },
                        entries: { main: './main.js' },
                        dependencies: {},
                        capabilities: [],
                        contributes: {},
                        description: 'External custom plugin',
                    },
                    source: {
                        kind: 'project-config' as const,
                        spec: 'cpa.external.custom@2.1.0',
                    },
                    sourceKind: 'project-config' as const,
                    entries: { main: './main.js' }, // External plugin running on Main only
                    criticality: 'optional' as const,
                    dependencies: {},
                },
            ],
            activationOrder: ['cpa.test.bundled', 'cpa.external.custom'],
        }

        const prepared = await host.prepareGeneration(graphDTO, 1)
        await prepared.commit()

        // Catalog must NOT contain external plugin or fake sourceRoot
        expect(host.catalog.hasPackage('cpa.external.custom')).toBe(false)
        expect(host.catalog.hasPackage('cpa.test.bundled')).toBe(true)

        // getPluginSummaries MUST include both bundled and external plugin
        const summaries = host.getPluginSummaries()
        const ids = summaries.map((s) => s.manifest.id)
        expect(ids).toContain('cpa.test.bundled')
        expect(ids).toContain('cpa.external.custom')

        const externalSummary = host.getPluginSummary('cpa.external.custom')
        expect(externalSummary).toBeDefined()
        expect(externalSummary.manifest.id).toBe('cpa.external.custom')
        expect(externalSummary.manifest.version).toBe('2.1.0')
        expect(externalSummary.status).toBe('inactive')
        expect(externalSummary.isCore).toBe(false)
    })

    describe('Scoped Capability Handles & Deny-By-Default Client', () => {
        it('denies capability invocations by default when no authoritative handle is injected', async () => {
            let capturedClient: any = null
            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'cpa.test.unhandled',
                    name: 'Unhandled Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { renderer: './index.ts' },
                    dependencies: {},
                    capabilities: ['filesystem.read'],
                    contributes: {},
                },
                source: { kind: 'bundled', spec: 'bundled:cpa.test.unhandled' },
                sourceRoot: '/plugins/bundled/cpa.test.unhandled',
                entries: { renderer: './index.ts' },
            }

            const host = new RendererPluginRuntimeHost({
                bundledPackages: [pkg],
                defaultDefinitions: {
                    'cpa.test.unhandled': {
                        runtime: 'renderer',
                        activate: (ctx) => {
                            capturedClient = ctx.capabilityClient
                        },
                    },
                },
            })

            await host.activatePlugin('cpa.test.unhandled')
            expect(capturedClient).toBeDefined()
            expect(capturedClient.has('filesystem.read')).toBe(false)
            await expect(capturedClient.invoke('native:readFile', ['/tmp/a'])).rejects.toThrow(
                'No capability handle granted for plugin "cpa.test.unhandled"',
            )
            expect(() => capturedClient.subscribe('some:event', () => {})).toThrow(
                'No capability handle granted for plugin "cpa.test.unhandled"',
            )
        })

        it('allows capability invocations when an authoritative handle is set', async () => {
            let capturedClient: any = null
            const pkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'cpa.test.handled',
                    name: 'Handled Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { renderer: './index.ts' },
                    dependencies: {},
                    capabilities: ['filesystem.read'],
                    contributes: {},
                },
                source: { kind: 'bundled', spec: 'bundled:cpa.test.handled' },
                sourceRoot: '/plugins/bundled/cpa.test.handled',
                entries: { renderer: './index.ts' },
            }

            const host = new RendererPluginRuntimeHost({
                bundledPackages: [pkg],
                defaultDefinitions: {
                    'cpa.test.handled': {
                        runtime: 'renderer',
                        activate: (ctx) => {
                            capturedClient = ctx.capabilityClient
                        },
                    },
                },
            })

            const mockTransport = vi.fn().mockResolvedValue({ ok: true, value: 'content' })
            host.setPluginHandle('cpa.test.handled', 'cap_valid_123' as any)
            host.setCapabilityTransport(mockTransport)

            await host.activatePlugin('cpa.test.handled')
            expect(capturedClient).toBeDefined()
            expect(capturedClient.has('filesystem.read')).toBe(true)

            const result = await capturedClient.invoke('native:readFile', ['/tmp/file.txt'])
            expect(result).toBe('content')
            expect(mockTransport).toHaveBeenCalledWith('cap_valid_123', 'native:readFile', ['/tmp/file.txt'])
        })
    })
})
