import { describe, it, expect, vi } from 'vitest'
import {
    MainContributionRegistry,
    type ServiceDescriptor,
    type RpcDescriptor,
    type ServiceCreateContext,
} from '../src/main/plugins/contributions/MainContributionRegistry.js'
import { rpcDescriptors } from '../src/main/plugins/contributions/rpcDescriptors.js'
import {
    MainPluginRuntimeHost,
    getDefaultBundledPackages,
} from '../src/main/plugins/runtime/MainPluginRuntimeHost.js'

export const existingIpcChannelSnapshot = [
    'native:runtimeInfo',
    'native:readFile',
    'native:readFileIfExists',
    'native:fileExists',
    'native:getProjectEnvironment',
    'native:watchProjectEnvironments',
    'native:invalidateEnvironmentCache',
    'native:writeFile',
    'native:mkdirAll',
    'native:removeFile',
    'native:removeDir',
    'native:stat',
    'native:readDir',
    'native:realPath',
    'native:lookPath',
    'native:selectProjectDirectory',
    'native:selectFilesAndFolders',
    'native:revealInFileManager',
    'native:clipboardSetText',
    'native:clipboardGetText',
    'dialog:saveFile',
    'profiling:start',
    'profiling:stop',
    'profiling:getStatus',
    'profiling:getReport',
    'native:startProcess',
    'native:runProcess',
    'native:startPty',
    'native:writePty',
    'native:resizePty',
    'native:closePty',
    'native:openWebSocket',
    'native:sendWebSocket',
    'native:cancelOperation',
    'http:request',
    'tray:setEnabled',
    'tray:setLocale',
    'webserver:start',
    'webserver:stop',
    'webserver:getStatus',
    'plugins:list',
    'plugins:getGraph',
    'plugins:getPreparedState',
    'plugins:prepareEnable',
    'plugins:prepareDisable',
    'plugins:prepareReload',
    'plugins:prepareInstall',
    'plugins:prepareUninstall',
    'plugins:prepareConfig',
    'plugins:commit',
    'plugins:finalize',
    'plugins:rollback',
    'plugins:commitGeneration',
    'plugins:rollbackGeneration',
]

export const existingRpcMethodSnapshot = [
    'native:runtimeInfo',
    'RuntimeInfo',
    'native:readFile',
    'ReadFile',
    'native:readFileIfExists',
    'ReadFileIfExists',
    'native:fileExists',
    'FileExists',
    'native:getProjectEnvironment',
    'GetProjectEnvironment',
    'native:watchProjectEnvironments',
    'WatchProjectEnvironments',
    'native:invalidateEnvironmentCache',
    'InvalidateEnvironmentCache',
    'native:writeFile',
    'WriteFile',
    'native:mkdirAll',
    'MkdirAll',
    'native:removeFile',
    'RemoveFile',
    'native:removeDir',
    'RemoveDir',
    'native:stat',
    'Stat',
    'native:readDir',
    'ReadDir',
    'native:realPath',
    'RealPath',
    'native:lookPath',
    'LookPath',
    'native:selectProjectDirectory',
    'SelectProjectDirectory',
    'native:selectFilesAndFolders',
    'SelectFilesAndFolders',
    'native:revealInFileManager',
    'RevealInFileManager',
    'native:clipboardSetText',
    'ClipboardSetText',
    'native:clipboardGetText',
    'ClipboardGetText',
    'dialog:saveFile',
    'DialogSaveFile',
    'SaveFile',
    'profiling:start',
    'ProfilingStart',
    'profiling:stop',
    'ProfilingStop',
    'profiling:getStatus',
    'ProfilingGetStatus',
    'profiling:getReport',
    'ProfilingGetReport',
    'native:startProcess',
    'StartProcess',
    'native:runProcess',
    'RunProcess',
    'native:startPty',
    'StartPty',
    'native:writePty',
    'WritePty',
    'native:resizePty',
    'ResizePty',
    'native:closePty',
    'ClosePty',
    'native:openWebSocket',
    'OpenWebSocket',
    'native:sendWebSocket',
    'SendWebSocket',
    'native:cancelOperation',
    'CancelOperation',
    'http:request',
    'HttpRequest',
    'tray:setEnabled',
    'SetTrayEnabled',
    'tray:setLocale',
    'SetTrayLocale',
    'webserver:start',
    'WebServerStart',
    'webserver:stop',
    'WebServerStop',
    'webserver:getStatus',
    'WebServerGetStatus',
    'plugins:list',
    'PluginsList',
    'plugins:getGraph',
    'PluginsGetGraph',
    'plugins:getPreparedState',
    'PluginsGetPreparedState',
    'plugins:prepareEnable',
    'PluginsPrepareEnable',
    'plugins:prepareDisable',
    'PluginsPrepareDisable',
    'plugins:prepareReload',
    'PluginsPrepareReload',
    'plugins:prepareInstall',
    'PluginsPrepareInstall',
    'plugins:prepareUninstall',
    'PluginsPrepareUninstall',
    'plugins:prepareConfig',
    'PluginsPrepareConfig',
    'plugins:commit',
    'PluginsCommit',
    'plugins:finalize',
    'PluginsFinalize',
    'plugins:rollback',
    'PluginsRollback',
    'plugins:commitGeneration',
    'PluginsCommitGeneration',
    'plugins:rollbackGeneration',
    'PluginsRollbackGeneration',
]

describe('MainContributionRegistry & Descriptors', () => {
    it('keeps every existing IPC channel and RPC alias', () => {
        expect(rpcDescriptors.map((item) => item.ipcChannel)).toEqual(existingIpcChannelSnapshot)
        expect(rpcDescriptors.flatMap((item) => [item.method, ...(item.aliases ?? [])])).toEqual(
            existingRpcMethodSnapshot,
        )
    })

    it('creates services in topological dependency order', async () => {
        const registry = new MainContributionRegistry()
        const order: string[] = []

        const serviceADescriptor: ServiceDescriptor<{ name: string }> = {
            id: 'serviceA',
            dependencies: [],
            create: () => {
                order.push('serviceA')
                return { name: 'A' }
            },
        }

        const serviceBDescriptor: ServiceDescriptor<{ name: string }> = {
            id: 'serviceB',
            dependencies: ['serviceA'],
            create: (ctx: ServiceCreateContext) => {
                const a = ctx.get<{ name: string }>('serviceA')
                expect(a.name).toBe('A')
                order.push('serviceB')
                return { name: 'B' }
            },
        }

        registry.registerService(serviceBDescriptor)
        registry.registerService(serviceADescriptor)

        await registry.createServices()
        expect(order).toEqual(['serviceA', 'serviceB'])
        expect(registry.getService<{ name: string }>('serviceA').name).toBe('A')
        expect(registry.getService<{ name: string }>('serviceB').name).toBe('B')
    })

    it('detects circular dependencies when creating services', async () => {
        const registry = new MainContributionRegistry()

        registry.registerService({
            id: 'serviceX',
            dependencies: ['serviceY'],
            create: () => ({}),
        })
        registry.registerService({
            id: 'serviceY',
            dependencies: ['serviceX'],
            create: () => ({}),
        })

        await expect(registry.createServices()).rejects.toThrow(/circular/i)
    })

    it('disposes services in reverse dependency order exactly once', async () => {
        const disposeOrder: string[] = []
        const registry = new MainContributionRegistry()

        const dependencyDesc: ServiceDescriptor<{ name: string }> = {
            id: 'dependency',
            dependencies: [],
            create: () => ({ name: 'dep' }),
            dispose: () => {
                disposeOrder.push('dependency')
            },
        }

        const dependentDesc: ServiceDescriptor<{ name: string }> = {
            id: 'dependent',
            dependencies: ['dependency'],
            create: () => ({ name: 'dependent' }),
            dispose: () => {
                disposeOrder.push('dependent')
            },
        }

        registry.registerService(dependentDesc)
        registry.registerService(dependencyDesc)

        await registry.createServices()
        await registry.disposeAll()
        await registry.disposeAll()

        expect(disposeOrder).toEqual(['dependent', 'dependency'])
    })

    it('dispatches RPC calls through canonical names, aliases, and IPC channels', async () => {
        const registry = new MainContributionRegistry()
        const invokeSpy = vi.fn(async (_ctx, args) => `result:${args[0]}`)

        const rpcDesc: RpcDescriptor = {
            method: 'test:action',
            aliases: ['TestAction', 'actionAlias'],
            ipcChannel: 'test:action',
            capability: 'test.capability',
            invoke: invokeSpy,
        }

        registry.registerRpc(rpcDesc)

        const res1 = await registry.dispatchRpc('test:action', ['one'], {
            pluginId: 'desktop-main',
            senderId: 0,
            frameUrl: '',
            transport: 'electron',
            clientId: 'client-1',
        })
        expect(res1).toBe('result:one')

        const res2 = await registry.dispatchRpc('TestAction', ['two'], {
            pluginId: 'desktop-main',
            senderId: 0,
            frameUrl: '',
            transport: 'electron',
        })
        expect(res2).toBe('result:two')

        const res3 = await registry.dispatchRpc('actionAlias', ['three'], {
            pluginId: 'desktop-main',
            senderId: 0,
            frameUrl: '',
            transport: 'electron',
        })
        expect(res3).toBe('result:three')
    })

    it('throws for unknown RPC methods', async () => {
        const registry = new MainContributionRegistry()
        await expect(
            registry.dispatchRpc('unknown:method', [], {
                pluginId: 'desktop-main',
                senderId: 0,
                frameUrl: '',
                transport: 'electron',
            }),
        ).rejects.toThrow('Unknown RPC method "unknown:method"')
    })

    it('throws when required dependency is missing during topological creation', async () => {
        const registry = new MainContributionRegistry()
        registry.registerService({
            id: 'orphan',
            dependencies: ['non-existent'],
            create: () => ({}),
        })

        await expect(registry.createServices()).rejects.toThrow(/missing dependency "non-existent"/i)
    })

    it('supports synchronous service creation via createServicesSync()', () => {
        const registry = new MainContributionRegistry()
        registry.registerService({
            id: 'syncDep',
            dependencies: [],
            create: () => ({ value: 42 }),
        })
        registry.registerService({
            id: 'syncConsumer',
            dependencies: ['syncDep'],
            create: (ctx) => ({ depValue: ctx.get<{ value: number }>('syncDep').value }),
        })

        registry.createServicesSync()
        expect(registry.getService<{ depValue: number }>('syncConsumer').depValue).toBe(42)
    })

    it('initializes MainPluginRuntimeHost with bundled packages and manages generation lease', async () => {
        const bundled = getDefaultBundledPackages()
        expect(bundled.map((b) => b.manifest.id)).toEqual(
            expect.arrayContaining([
                'cpa.core.session-manager',
                'cpa.core.settings',
                'cpa.core.scheduler',
                'cpa.core.worktree',
            ]),
        )

        const host = new MainPluginRuntimeHost()
        await host.activateAll()

        expect(host.isPluginActive('cpa.core.session-manager')).toBe(true)
        expect(host.isPluginActive('cpa.core.settings')).toBe(true)
        expect(host.isPluginActive('cpa.core.scheduler')).toBe(true)
        expect(host.isPluginActive('cpa.core.worktree')).toBe(true)

        // Generation lease
        const lease = host.acquireGeneration(['cpa.core.session-manager'])
        expect(lease.generation).toBeGreaterThanOrEqual(1)
        expect(lease.pluginIds).toContain('cpa.core.session-manager')
        lease.release()

        await host.dispose()
        expect(host.getActivePluginIds()).toHaveLength(0)
    })

    it('routes bundled plugin loading through generated loaders and real entries by default', async () => {
        const host = new MainPluginRuntimeHost()
        const bundledPackages = getDefaultBundledPackages()
        const schedulerPkg = bundledPackages.find((p) => p.manifest.id === 'cpa.core.scheduler')!

        const loaded = await host.moduleLoader.load(schedulerPkg, 'main')
        expect(loaded).toBeDefined()
        expect(loaded.runtime).toBe('main')
        expect((loaded as any).isLegacy).toBeUndefined()

        const worktreePkg = bundledPackages.find((p) => p.manifest.id === 'cpa.core.worktree')!
        const worktreeLoaded = await host.moduleLoader.load(worktreePkg, 'main')
        expect(worktreeLoaded).toBeDefined()
        expect(worktreeLoaded.runtime).toBe('main')
        expect((worktreeLoaded as any).isLegacy).toBeUndefined()

        const settingsPkg = bundledPackages.find((p) => p.manifest.id === 'cpa.core.settings')!
        const settingsLoaded = await host.moduleLoader.load(settingsPkg, 'main')
        expect(settingsLoaded).toBeDefined()
        expect(settingsLoaded.runtime).toBe('main')
        expect((settingsLoaded as any).isLegacy).toBeUndefined()

        const sessionManagerPkg = bundledPackages.find((p) => p.manifest.id === 'cpa.core.session-manager')!
        const sessionLoaded = await host.moduleLoader.load(sessionManagerPkg, 'main')
        expect(sessionLoaded).toBeDefined()
        expect(sessionLoaded.runtime).toBe('main')
        expect((sessionLoaded as any).isLegacy).toBeUndefined()
    })

    it('allows entryLoaders option to take precedence over bundled entry loaders without being blocked by static definitions', async () => {
        let customLoaderCalled = false
        const customEntry = {
            runtime: 'main' as const,
            manifest: {
                id: 'cpa.core.session-manager',
                name: 'Custom Session Manager',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                entries: { main: './main.ts' },
            },
            activate: async () => {
                customLoaderCalled = true
            },
        }

        const host = new MainPluginRuntimeHost({
            entryLoaders: {
                'cpa.core.session-manager': async () => {
                    return customEntry
                },
            },
        })

        await host.activatePlugin('cpa.core.session-manager')
        expect(customLoaderCalled).toBe(true)
        expect(host.isPluginActive('cpa.core.session-manager')).toBe(true)
        await host.dispose()
    })

    it('allows options.defaultDefinitions to explicitly override when provided for testing', async () => {
        let explicitActivated = false
        const explicitDef = {
            manifest: {
                id: 'cpa.core.session-manager',
                name: 'Explicit Test Definition',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                entries: { main: './main.ts' },
            },
            activate: async () => {
                explicitActivated = true
            },
        }

        const host = new MainPluginRuntimeHost({
            defaultDefinitions: {
                'cpa.core.session-manager': explicitDef,
            },
        })

        await host.activatePlugin('cpa.core.session-manager')
        expect(explicitActivated).toBe(true)
        expect(host.isPluginActive('cpa.core.session-manager')).toBe(true)
        await host.dispose()
    })
})
