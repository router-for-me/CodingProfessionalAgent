import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { bootstrapPluginGraph } from '../src/main/plugins/catalog/bootstrapPluginGraph.js'
import { MainPluginRuntimeHost } from '../src/main/plugins/runtime/MainPluginRuntimeHost.js'
import { MainPluginActivationCoordinator } from '../src/main/plugins/runtime/MainPluginActivationCoordinator.js'
import { createServices, attachMainWindowListeners, type AppServices } from '../src/main/ipc/registerIpcHandlers.js'
import { RENDERER_CAPABILITY_DESCRIPTORS } from '../src/shared/capabilityDescriptors.js'
import { matchesCapability } from '@cpa/plugin-api'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

describe('Session Plugin Lifecycle and Dynamic Service/RPC Resolution', () => {
    let tempDir: string
    let host: MainPluginRuntimeHost
    let coordinator: MainPluginActivationCoordinator
    let services: AppServices

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-session-lifecycle-test-'))
        const bootstrapResult = await bootstrapPluginGraph({
            cpaVersion: '1.0.0',
            homeDir: tempDir,
        })

        host = new MainPluginRuntimeHost({
            cpaVersion: '1.0.0',
            catalog: bootstrapResult.catalog,
            graphDTO: bootstrapResult.graph,
        })
        coordinator = new MainPluginActivationCoordinator({
            host,
            graph: bootstrapResult.graph,
        })

        // Stage before creating services (as in app startup)
        await coordinator.stage()

        services = createServices(() => null, {
            isDebug: true,
            homeDir: tempDir,
            cpaVersion: '1.0.0',
            pluginRuntimeHost: host,
            pluginActivationCoordinator: coordinator,
            pluginResourceService: bootstrapResult.resourceService,
            sessionsDir: path.join(tempDir, 'sessions'),
        })
    })

    afterEach(async () => {
        if (services) {
            await services.disposeAll()
        }
        await fs.rm(tempDir, { recursive: true, force: true })
    })

    it('dynamically resolves sessionService and sessionRunRegistry after coordinator commit', async () => {
        // Before commit: session plugin is staged but not committed
        expect(coordinator.getPendingGeneration()).not.toBeNull()

        const pending = coordinator.getPendingGeneration()!
        await coordinator.commitPrepared(pending.revision, pending.generation)

        // After commit: services dynamically resolved from registry
        expect(services.sessionService).toBeDefined()
        expect(typeof services.sessionService.listSessions).toBe('function')
        expect(services.sessionRunRegistry).toBeDefined()
        expect(typeof services.sessionRunRegistry.cleanupClientRuns).toBe('function')
    })

    it('allows safe window cleanup without throwing before or after commit', async () => {
        const mockWebContents = {
            id: 42,
            isDestroyed: () => false,
            once: (_evt: string, cb: () => void) => cb(),
            on: () => {},
            send: () => {},
        }
        const mockWin = {
            isDestroyed: () => false,
            webContents: mockWebContents,
        } as any

        // Window listener cleanup before commit should not throw
        expect(() => {
            attachMainWindowListeners(mockWin, services)
        }).not.toThrow()

        // Commit generation
        const pending = coordinator.getPendingGeneration()!
        await coordinator.commitPrepared(pending.revision, pending.generation)

        // Window listener cleanup after commit should safely execute
        expect(() => {
            attachMainWindowListeners(mockWin, services)
        }).not.toThrow()
    })

    it('dynamically dispatches session RPC methods after plugin generation is committed', async () => {
        const pending = coordinator.getPendingGeneration()!
        await coordinator.commitPrepared(pending.revision, pending.generation)

        // Create a new session via dynamic RPC dispatch
        const sessionItem = {
            id: 'test-sess-1',
            title: 'Dynamic RPC Test Session',
            pinned: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }

        await services.handleMethod('session:setMeta', [sessionItem])

        // Verify session was retrieved in list
        const sessionList = (await services.handleMethod('session:listSessions', [])) as any[]
        expect(sessionList).toBeDefined()
        expect(sessionList.some((s) => s.id === 'test-sess-1')).toBe(true)

        // Set and get session entries
        await services.handleMethod('session:set', [
            'test-sess-1',
            {
                id: 'test-sess-1',
                version: 1,
                entries: [{ id: 'entry-1', kind: 'message', text: 'Hello' }],
            },
        ])

        const session = (await services.handleMethod('session:get', ['test-sess-1'])) as any
        expect(session).toBeDefined()
        expect(session.id).toBe('test-sess-1')
        expect(session.entries).toHaveLength(1)
        expect(session.entries[0].text).toBe('Hello')
    })

    it('enforces plural sessions.* and projects.read capability mappings', async () => {
        // Check descriptor definitions in RENDERER_CAPABILITY_DESCRIPTORS
        const sessionDescriptors = RENDERER_CAPABILITY_DESCRIPTORS.filter((d) =>
            d.method.startsWith('session:'),
        )

        for (const desc of sessionDescriptors) {
            expect(desc.capability).toMatch(/^sessions\.(read|write|manage)$/)
        }

        // Check manifest capabilities match
        const manifest = host.catalog.getPackage('cpa.core.session-manager')?.manifest
        expect(manifest).toBeDefined()
        expect(manifest?.capabilities).toContain('sessions.*')
        expect(manifest?.capabilities).toContain('projects.*')

        for (const desc of sessionDescriptors) {
            const hasCap = (manifest?.capabilities ?? []).some((pattern) =>
                matchesCapability(pattern, desc.capability as any),
            )
            expect(hasCap).toBe(true)
        }
    })

    it('dispatches plugins:prepareDisable via registered pluginGraphManagementService and completes 2PC', async () => {
        const pending = coordinator.getPendingGeneration()!
        await coordinator.commitPrepared(pending.revision, pending.generation)

        // Create an external plugin in tempDir/.coding-professional-agent/plugins/test-opt
        const extPluginDir = path.join(tempDir, '.coding-professional-agent', 'plugins', 'test-opt')
        await fs.mkdir(extPluginDir, { recursive: true })
        await fs.writeFile(
            path.join(extPluginDir, 'manifest.json'),
            JSON.stringify({
                id: 'test-opt',
                name: 'Test Optional Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '^1.0.0' },
                capabilities: [],
                contributes: {},
            }),
            'utf8',
        )

        expect(services.registry.hasService('pluginGraphManagementService')).toBe(true)
        const mgmtService = services.registry.getService<any>('pluginGraphManagementService')
        expect(mgmtService).toBeDefined()

        const listBefore = await mgmtService.list()
        expect(listBefore.plugins.some((p: any) => p.manifest.id === 'test-opt')).toBe(true)

        const res = (await services.handleMethod('plugins:prepareDisable', ['test-opt'])) as any
        expect(res).toBeDefined()
        expect(res.candidateRevision).toBeDefined()

        // Test complete 2PC flow
        const prepConfigRes = await services.handleMethod('plugins:prepareConfig', [res.candidateRevision])
        expect(prepConfigRes).toEqual({ ok: true })

        const commitRes = await services.handleMethod('plugins:commit', [res.candidateRevision, res.generation])
        expect(commitRes).toEqual({ ok: true })

        const finalizeRes = await services.handleMethod('plugins:finalize', [res.candidateRevision])
        expect(finalizeRes).toEqual({ ok: true })

        const listAfter = await mgmtService.list()
        const pluginAfter = listAfter.plugins.find((p: any) => p.manifest.id === 'test-opt')
        expect(pluginAfter).toBeDefined()
        expect(pluginAfter.status).toBe('inactive')

        // Verify core plugins are active, not resolved/registered
        const settingsPlugin = listAfter.plugins.find((p: any) => p.manifest.id === 'cpa.core.settings')
        expect(settingsPlugin).toBeDefined()
        expect(settingsPlugin.status).toBe('active')

        // Test enable flow: from inactive to active
        const enableRes = (await services.handleMethod('plugins:prepareEnable', ['test-opt'])) as any
        expect(enableRes).toBeDefined()
        expect(enableRes.candidateRevision).toBeDefined()

        await services.handleMethod('plugins:prepareConfig', [enableRes.candidateRevision])
        await services.handleMethod('plugins:commit', [enableRes.candidateRevision, enableRes.generation])
        await services.handleMethod('plugins:finalize', [enableRes.candidateRevision])

        const listReEnabled = await mgmtService.list()
        const pluginReEnabled = listReEnabled.plugins.find((p: any) => p.manifest.id === 'test-opt')
        expect(pluginReEnabled).toBeDefined()
        expect(pluginReEnabled.status).toBe('active')
    })
})
