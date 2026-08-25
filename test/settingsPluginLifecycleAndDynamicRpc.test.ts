import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { bootstrapPluginGraph } from '../src/main/plugins/catalog/bootstrapPluginGraph.js'
import { MainPluginRuntimeHost } from '../src/main/plugins/runtime/MainPluginRuntimeHost.js'
import { MainPluginActivationCoordinator } from '../src/main/plugins/runtime/MainPluginActivationCoordinator.js'
import { createServices, type AppServices } from '../src/main/ipc/registerIpcHandlers.js'
import { KVStoreService } from '../plugins/bundled/cpa.core.settings/main/kvStoreService.js'
import { FileService } from '../src/main/services/fileService.js'
import { resolveWebServerStartupPlan } from '../src/main/utils/webServerStartup.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

describe('Settings Plugin Lifecycle, Dynamic Service/RPC Resolution, and Atomic Persistence', () => {
    let tempDir: string
    let appDir: string
    let host: MainPluginRuntimeHost
    let coordinator: MainPluginActivationCoordinator
    let services: AppServices
    const originalCpaHome = process.env.CPA_HOME

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-settings-lifecycle-test-'))
        appDir = path.join(tempDir, '.coding-professional-agent')
        await fs.mkdir(appDir, { recursive: true })
        process.env.CPA_HOME = appDir

        // Prepopulate settings.json with known app-state and webServer settings
        const initialSettings = {
            'app-state': {
                settings: {
                    language: 'zh-CN',
                    webServer: {
                        enabled: true,
                        port: 19999,
                        host: '127.0.0.1',
                    },
                },
            },
        }
        await fs.writeFile(
            path.join(appDir, 'settings.json'),
            JSON.stringify(initialSettings, null, 2),
            'utf8',
        )

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

        // Stage before creating services (as during Electron main app startup)
        await coordinator.stage()

        services = createServices(() => null, {
            isDebug: false,
            pluginRuntimeHost: host,
            pluginActivationCoordinator: coordinator,
            pluginResourceService: bootstrapResult.resourceService,
        })
    })

    afterEach(async () => {
        if (originalCpaHome !== undefined) {
            process.env.CPA_HOME = originalCpaHome
        } else {
            delete process.env.CPA_HOME
        }
        if (services) {
            await services.disposeAll()
        }
        try {
            await fs.rm(tempDir, { recursive: true, force: true })
        } catch {
            // Ignore cleanup errors
        }
    })

    it('1. Staged startup does not crash and reads app-state when Main generation is committed', async () => {
        // While staged: kvStoreService should not crash callers
        expect(coordinator.getPendingGeneration()).not.toBeNull()

        let webServerStartedWithPort = 0
        const configureSpy = vi.spyOn(services.webServerService, 'configure')

        // Simulate safe startup webserver initialization listener
        let configured = false
        const initWebServer = async () => {
            const kv = services.kvStoreService
            if (!kv) return
            const appState = await kv.get('app-state')
            const plan = resolveWebServerStartupPlan(appState, false)
            if (plan.configureConfig) {
                services.webServerService.configure(plan.configureConfig)
                webServerStartedWithPort = plan.configureConfig.port ?? 0
                configured = true
            }
        }

        // Register onCommit listener if pending, otherwise run immediately
        if (coordinator.getGeneration() > 0 && !coordinator.getPendingGeneration()) {
            await initWebServer()
        } else {
            coordinator.onCommit(() => {
                void initWebServer()
            })
        }

        // Before commit: webserver is not configured yet with custom port
        expect(configured).toBe(false)

        // Commit generation (as done when 3 runtimes coordinate commit)
        const pending = coordinator.getPendingGeneration()!
        await coordinator.commitPrepared(pending.revision, pending.generation)

        // Wait a microtask tick for onCommit async handlers
        await new Promise((r) => setTimeout(r, 50))

        // After commit: kvStoreService is available and webserver is configured with persisted port
        expect(services.kvStoreService).toBeDefined()
        expect(configured).toBe(true)
        expect(webServerStartedWithPort).toBe(19999)
        expect(configureSpy).toHaveBeenCalled()
    })

    it('2. Dynamically dispatches KV RPC methods and legacy aliases after commit', async () => {
        const pending = coordinator.getPendingGeneration()!
        await coordinator.commitPrepared(pending.revision, pending.generation)

        // Standard RPC dispatch
        await services.handleMethod('kvstore:set', ['themeColor', 'nord'])
        const directValue = await services.handleMethod('kvstore:get', ['themeColor'])
        expect(directValue).toBe('nord')

        // Legacy channel alias dispatch
        await services.handleMethod('KVStoreSet', ['customSetting', 42])
        const legacyValue = await services.handleMethod('KVStoreGet', ['customSetting'])
        expect(legacyValue).toBe(42)

        // Trigger explicit save RPC
        await services.handleMethod('kvstore:save', [])
        const fileContent = JSON.parse(
            fsSync.readFileSync(path.join(appDir, 'settings.json'), 'utf8'),
        )
        expect(fileContent.themeColor).toBe('nord')
        expect(fileContent.customSetting).toBe(42)
    })

    it('3. Atomic write failure does not corrupt or overwrite existing files', async () => {
        const subDir = path.join(tempDir, 'atomic-test')
        await fs.mkdir(subDir, { recursive: true })
        const testFile = path.join(subDir, 'settings.json')

        // Write initial valid content
        await fs.writeFile(testFile, JSON.stringify({ initialKey: 'initialValue' }, null, 2), 'utf8')

        const kv = new KVStoreService({ customPath: testFile })
        await kv.set('testKey', 'valid-value')
        await kv.save()

        const validSavedContent = fsSync.readFileSync(testFile, 'utf8')
        expect(JSON.parse(validSavedContent).testKey).toBe('valid-value')

        // Make the directory read-only (mode 0o555) so creating new temp files fails
        await fs.chmod(subDir, 0o555)

        try {
            await expect(kv.set('testKey', 'corrupted-value')).rejects.toThrow()

            // Assert original file was not corrupted
            const afterFailedSaveContent = fsSync.readFileSync(testFile, 'utf8')
            expect(JSON.parse(afterFailedSaveContent).testKey).toBe('valid-value')
        } finally {
            // Restore permissions for cleanup
            await fs.chmod(subDir, 0o755)
            kv.dispose()
        }

        // Also test FileService.writeFile atomic behavior
        const fileServiceSubDir = path.join(tempDir, 'file-service-atomic')
        await fs.mkdir(fileServiceSubDir, { recursive: true })
        const targetDocPath = path.join(fileServiceSubDir, 'AGENTS.md')
        await fs.writeFile(targetDocPath, '# Initial Content', 'utf8')

        await fs.chmod(fileServiceSubDir, 0o555)
        try {
            const fileService = new FileService()
            const base64Data = Buffer.from('# New Broken Content').toString('base64')
            await expect(fileService.writeFile(targetDocPath, base64Data)).rejects.toThrow()

            // Verify original file content was untouched
            expect(fsSync.readFileSync(targetDocPath, 'utf8')).toBe('# Initial Content')
        } finally {
            await fs.chmod(fileServiceSubDir, 0o755)
        }
    })

    it('4. Correctly handles generation replacement and deactivate cleanup', async () => {
        // Stage and commit Gen 1
        const pending1 = coordinator.getPendingGeneration()!
        await coordinator.commitPrepared(pending1.revision, pending1.generation)
        expect(coordinator.getGeneration()).toBe(1)

        const kv1 = services.kvStoreService
        expect(kv1).toBeDefined()
        await kv1.set('gen1Key', 'val1')
        await kv1.save()

        // Stage Gen 2
        const bootstrapResult2 = await bootstrapPluginGraph({
            cpaVersion: '1.0.0',
            homeDir: tempDir,
        })
        const pending2 = await coordinator.stage(bootstrapResult2.graph, { generation: 2 })
        expect(pending2.generation).toBe(2)

        // Commit Gen 2
        await coordinator.commitPrepared(pending2.revision, pending2.generation)
        expect(coordinator.getGeneration()).toBe(2)

        // Service resolves to new generation instance
        const kv2 = services.kvStoreService
        expect(kv2).toBeDefined()
        expect(await kv2.get('gen1Key')).toBe('val1')
        await kv2.set('gen2Key', 'val2')
        await kv2.save()

        const updatedFile = JSON.parse(
            fsSync.readFileSync(path.join(appDir, 'settings.json'), 'utf8'),
        )
        expect(updatedFile.gen1Key).toBe('val1')
        expect(updatedFile.gen2Key).toBe('val2')
    })
})
