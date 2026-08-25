import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
    type PluginManifest,
    type ResolvedPluginPackage,
    PluginConflictError,
    PluginDependencyError,
    PluginError,
} from '@cpa/plugin-api'
import { MainPluginRuntimeHost } from '../src/main/plugins/runtime/MainPluginRuntimeHost.js'
import { MainPluginActivationCoordinator } from '../src/main/plugins/runtime/MainPluginActivationCoordinator.js'
import { PluginResourceService } from '../src/main/plugins/resources/PluginResourceService.js'
import { ManagedNpmInstaller } from '../src/main/plugins/packages/ManagedNpmInstaller.js'
import {
    PluginGraphManagementService,
    type PluginGraphManagementOptions,
} from '../src/main/plugins/management/PluginGraphManagementService.js'
import { bootstrapPluginGraph } from '../src/main/plugins/catalog/bootstrapPluginGraph.js'

describe('PluginGraphManagementService & Graph Transactions', () => {
    let tempRoot: string
    let homeDir: string
    let projectDir: string
    let globalPluginsDir: string
    let projectPluginsDir: string
    let npmPluginsDir: string
    let resourceService: PluginResourceService
    let host: MainPluginRuntimeHost
    let coordinator: MainPluginActivationCoordinator
    let npmInstaller: ManagedNpmInstaller

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-mgmt-test-'))
        homeDir = path.join(tempRoot, 'home')
        projectDir = path.join(tempRoot, 'project')
        globalPluginsDir = path.join(homeDir, '.coding-professional-agent', 'plugins')
        projectPluginsDir = path.join(projectDir, '.cpa', 'plugins')
        npmPluginsDir = path.join(globalPluginsDir, 'npm')

        await fs.mkdir(globalPluginsDir, { recursive: true })
        await fs.mkdir(projectPluginsDir, { recursive: true })
        await fs.mkdir(npmPluginsDir, { recursive: true })

        resourceService = new PluginResourceService()
        host = new MainPluginRuntimeHost()
        coordinator = new MainPluginActivationCoordinator({ host })
        npmInstaller = new ManagedNpmInstaller({ pluginsDir: globalPluginsDir })
    })

    afterEach(async () => {
        try {
            await fs.rm(tempRoot, { recursive: true, force: true })
        } catch {
            // Ignore cleanup error
        }
    })

    async function createTestPlugin(
        dir: string,
        id: string,
        version = '1.0.0',
        overrides: Partial<PluginManifest> = {},
    ): Promise<string> {
        await fs.mkdir(dir, { recursive: true })
        const manifest: PluginManifest = {
            id,
            name: id,
            version,
            apiVersion: '1.0.0',
            engines: { cpa: '>=1.0.0' },
            entries: { main: './main.js', renderer: './renderer.js', agent: './agent.js' },
            dependencies: {},
            capabilities: ['filesystem.read'],
            contributes: {},
            ...overrides,
        }

        await fs.writeFile(
            path.join(dir, 'manifest.json'),
            JSON.stringify(manifest, null, 2),
            'utf-8',
        )
        await fs.writeFile(
            path.join(dir, 'main.js'),
            'export default { runtime: "main", activate() {} };',
            'utf-8',
        )
        await fs.writeFile(
            path.join(dir, 'renderer.js'),
            'export default { runtime: "renderer", activate() {} };',
            'utf-8',
        )
        await fs.writeFile(
            path.join(dir, 'agent.js'),
            'export default { runtime: "agent", activate() {} };',
            'utf-8',
        )

        return dir
    }

    it('lists plugins across all source tiers and reflects initial bootstrap state', async () => {
        const bundledDir = path.join(tempRoot, 'bundled')
        await createTestPlugin(path.join(bundledDir, 'cpa.core.bundled'), 'cpa.core.bundled', '1.0.0', {
            criticality: 'required',
        })
        await createTestPlugin(path.join(projectPluginsDir, 'proj-plugin'), 'proj-plugin', '1.0.0')
        await createTestPlugin(path.join(globalPluginsDir, 'global-plugin'), 'global-plugin', '1.0.0')

        const initResult = await bootstrapPluginGraph({
            homeDir,
            projectPath: projectDir,
            bundledDir,
            resourceService,
            npmInstaller,
        })
        coordinator.setGraphDTO(initResult.graph)
        await coordinator.prepareGeneration(initResult.catalog, {
            generation: 1,
            revision: initResult.graph.revision,
        })
        await coordinator.commitPrepared(initResult.graph.revision, 1)

        const service = new PluginGraphManagementService({
            homeDir,
            projectPath: projectDir,
            bundledDir,
            resourceService,
            coordinator,
            npmInstaller,
        })

        const list = await service.list()
        expect(list.plugins.length).toBe(3)
        const ids = list.plugins.map((p) => p.manifest.id)
        expect(ids).toContain('cpa.core.bundled')
        expect(ids).toContain('proj-plugin')
        expect(ids).toContain('global-plugin')
        expect(list.activeRevision).toBe(initResult.graph.revision)
    })

    it('prepares enable/disable candidate transaction and rejects concurrency conflict with expectedRevision', async () => {
        const bundledDir = path.join(tempRoot, 'bundled')
        await createTestPlugin(path.join(bundledDir, 'cpa.core.bundled'), 'cpa.core.bundled')
        await createTestPlugin(path.join(globalPluginsDir, 'ext-plugin'), 'ext-plugin')

        const initResult = await bootstrapPluginGraph({
            homeDir,
            projectPath: projectDir,
            bundledDir,
            resourceService,
            npmInstaller,
        })
        coordinator.setGraphDTO(initResult.graph)
        await coordinator.prepareGeneration(initResult.catalog, {
            generation: 1,
            revision: initResult.graph.revision,
        })
        await coordinator.commitPrepared(initResult.graph.revision, 1)

        const service = new PluginGraphManagementService({
            homeDir,
            projectPath: projectDir,
            bundledDir,
            resourceService,
            coordinator,
            npmInstaller,
        })

        // Concurrency guard: passing outdated expectedRevision must reject
        await expect(
            service.prepareDisable('ext-plugin', { expectedRevision: 'outdated-rev' }),
        ).rejects.toThrow(PluginConflictError)

        // Valid candidate prepare
        const candidate = await service.prepareDisable('ext-plugin', {
            expectedRevision: initResult.graph.revision,
        })
        expect(candidate.candidateRevision).toBeTruthy()
        expect(candidate.candidateRevision).not.toBe(initResult.graph.revision)
        expect(candidate.generation).toBe(2)

        // Active state must NOT be modified before commit
        const listBeforeCommit = await service.list()
        const extBefore = listBeforeCommit.plugins.find((p) => p.manifest.id === 'ext-plugin')
        expect(extBefore?.status).toBe('active')

        // Commit transaction
        await service.commitTransaction(candidate.candidateRevision)

        // Now active state reflects disabled
        const listAfterCommit = await service.list()
        const extAfter = listAfterCommit.plugins.find((p) => p.manifest.id === 'ext-plugin')
        expect(extAfter?.status).toBe('inactive')
        expect(listAfterCommit.activeRevision).toBe(candidate.candidateRevision)
    })

    it('rollback candidate transaction leaves previous active generation completely unchanged', async () => {
        const bundledDir = path.join(tempRoot, 'bundled')
        await createTestPlugin(path.join(bundledDir, 'cpa.core.bundled'), 'cpa.core.bundled')
        await createTestPlugin(path.join(globalPluginsDir, 'ext-plugin'), 'ext-plugin')

        const initResult = await bootstrapPluginGraph({
            homeDir,
            projectPath: projectDir,
            bundledDir,
            resourceService,
            npmInstaller,
        })
        coordinator.setGraphDTO(initResult.graph)
        await coordinator.prepareGeneration(initResult.catalog, {
            generation: 1,
            revision: initResult.graph.revision,
        })
        await coordinator.commitPrepared(initResult.graph.revision, 1)

        const service = new PluginGraphManagementService({
            homeDir,
            projectPath: projectDir,
            bundledDir,
            resourceService,
            coordinator,
            npmInstaller,
        })

        const initialRevision = service.getActiveRevision()

        const candidate = await service.prepareDisable('ext-plugin', {
            expectedRevision: initialRevision,
        })

        await service.rollbackTransaction(candidate.candidateRevision)

        // Active state must remain unchanged
        expect(service.getActiveRevision()).toBe(initialRevision)
        const list = await service.list()
        const ext = list.plugins.find((p) => p.manifest.id === 'ext-plugin')
        expect(ext?.status).toBe('active')
    })

    it('persists disabled state across application restarts and enforces tier precedence', async () => {
        // High priority project plugin disabled, low priority global plugin with same ID exists
        await createTestPlugin(path.join(projectPluginsDir, 'same-id-plugin'), 'same-id-plugin', '2.0.0')
        await createTestPlugin(path.join(globalPluginsDir, 'same-id-plugin'), 'same-id-plugin', '1.0.0')

        const service = new PluginGraphManagementService({
            homeDir,
            projectPath: projectDir,
            resourceService,
            coordinator,
            npmInstaller,
        })

        const initCandidate = await service.prepareDisable('same-id-plugin', { scope: 'project' })
        await service.commitTransaction(initCandidate.candidateRevision)

        // Simulate restart by bootstrapping fresh from disk
        const restartedResult = await bootstrapPluginGraph({
            homeDir,
            projectPath: projectDir,
            resourceService: new PluginResourceService(),
            npmInstaller,
        })

        // High priority project config disabled must NOT fall through to enable global plugin
        const activeIds = restartedResult.graph.activationOrder
        expect(activeIds).not.toContain('same-id-plugin')
        const blocked = restartedResult.rawGraph.blocked.find((b) => b.pluginId === 'same-id-plugin')
        expect(blocked?.reason).toBe('disabled')
    })

    it('prepares install and uninstall for managed npm plugins atomically', async () => {
        const fixtureManifest = {
            name: '@scope/managed-test',
            version: '1.0.0',
            dist: { integrity: 'sha512-fixtureHash==' },
        }
        const extractSpy = vi.fn(async (_spec: string, dest: string) => {
            await createTestPlugin(dest, 'managed-test', '1.0.0')
        })

        const customInstaller = new ManagedNpmInstaller({
            pluginsDir: globalPluginsDir,
            fetchManifest: async () => fixtureManifest,
            extractPackage: extractSpy,
        })

        const service = new PluginGraphManagementService({
            homeDir,
            projectPath: projectDir,
            resourceService,
            coordinator,
            npmInstaller: customInstaller,
        })

        // Prepare install
        const installCandidate = await service.prepareInstall('npm:@scope/managed-test@1.0.0', {
            scope: 'project',
        })
        expect(installCandidate.candidateRevision).toBeTruthy()
        expect(installCandidate.graph.plugins.some((p) => p.id === 'managed-test')).toBe(true)

        // Commit install
        await service.commitTransaction(installCandidate.candidateRevision)

        const listAfterInstall = await service.list()
        expect(listAfterInstall.plugins.some((p) => p.manifest.id === 'managed-test')).toBe(true)

        // Prepare uninstall
        const uninstallCandidate = await service.prepareUninstall('managed-test', {
            scope: 'project',
        })
        expect(uninstallCandidate.graph.plugins.some((p) => p.id === 'managed-test')).toBe(false)

        // Commit uninstall
        await service.commitTransaction(uninstallCandidate.candidateRevision)

        const listAfterUninstall = await service.list()
        expect(listAfterUninstall.plugins.some((p) => p.manifest.id === 'managed-test')).toBe(false)
    })

    it('does NOT commit runtime coordinator if disk prepare fails', async () => {
        const bundledDir = path.join(tempRoot, 'bundled')
        await createTestPlugin(path.join(bundledDir, 'cpa.core.bundled'), 'cpa.core.bundled')
        await createTestPlugin(path.join(globalPluginsDir, 'ext-plugin'), 'ext-plugin')

        const initResult = await bootstrapPluginGraph({
            homeDir,
            projectPath: projectDir,
            bundledDir,
            resourceService,
            npmInstaller,
        })
        coordinator.setGraphDTO(initResult.graph)
        await coordinator.prepareGeneration(initResult.catalog, {
            generation: 1,
            revision: initResult.graph.revision,
        })
        await coordinator.commitPrepared(initResult.graph.revision, 1)

        const service = new PluginGraphManagementService({
            homeDir,
            projectPath: projectDir,
            bundledDir,
            resourceService,
            coordinator,
            npmInstaller,
        })

        const candidate = await service.prepareDisable('ext-plugin')
        const commitSpy = vi.spyOn(coordinator, 'commitPrepared')

        // Mock disk prepare failure by making settings directory read-only or rejecting prepareDurableConfig
        const configModule = await import('../src/main/plugins/config/pluginSourceConfig.js')
        vi.spyOn(configModule, 'prepareDurableConfig').mockRejectedValueOnce(
            new Error('ENOSPC: no space left on device'),
        )

        await expect(service.commitTransaction(candidate.candidateRevision)).rejects.toThrow('ENOSPC')

        // Verify runtime coordinator was NEVER committed
        expect(commitSpy).not.toHaveBeenCalled()
        expect(service.getActiveRevision()).toBe(initResult.graph.revision)
    })

    it('restores previous config and cleans up journal if runtime commit fails', async () => {
        const bundledDir = path.join(tempRoot, 'bundled')
        await createTestPlugin(path.join(bundledDir, 'cpa.core.bundled'), 'cpa.core.bundled')
        await createTestPlugin(path.join(globalPluginsDir, 'ext-plugin'), 'ext-plugin')

        const initResult = await bootstrapPluginGraph({
            homeDir,
            projectPath: projectDir,
            bundledDir,
            resourceService,
            npmInstaller,
        })
        coordinator.setGraphDTO(initResult.graph)
        await coordinator.prepareGeneration(initResult.catalog, {
            generation: 1,
            revision: initResult.graph.revision,
        })
        await coordinator.commitPrepared(initResult.graph.revision, 1)

        const service = new PluginGraphManagementService({
            homeDir,
            projectPath: projectDir,
            bundledDir,
            resourceService,
            coordinator,
            npmInstaller,
        })

        const candidate = await service.prepareDisable('ext-plugin')

        // Mock runtime coordinator failure during commitPrepared
        vi.spyOn(coordinator, 'commitPrepared').mockRejectedValueOnce(
            new Error('Coordinator runtime failed to commit'),
        )

        await expect(service.commitTransaction(candidate.candidateRevision)).rejects.toThrow(
            'Coordinator runtime failed to commit',
        )

        // Verify that disk settings were not modified permanently and journal is cleaned/rolled back
        const list = await service.list()
        const ext = list.plugins.find((p) => p.manifest.id === 'ext-plugin')
        expect(ext?.status).toBe('active')
        expect(service.getActiveRevision()).toBe(initResult.graph.revision)
    })

    it('crash recovery reconciles committed journal to target config files on bootstrap', async () => {
        const { recoverFromJournal } = await import('../src/main/plugins/config/pluginSourceConfig.js')
        const journalPath = path.join(homeDir, '.coding-professional-agent', 'plugin-graph-journal.json')
        const settingsPath = path.join(homeDir, '.coding-professional-agent', 'settings.json')

        // Write initial settings.json
        await fs.writeFile(
            settingsPath,
            JSON.stringify({ plugins: { version: 1, sources: [], disabled: [] } }),
            'utf-8',
        )

        const newContent = JSON.stringify({
            plugins: { version: 1, sources: [], disabled: ['recovered-plugin'] },
        })

        // Create a simulated crash journal marked as 'committed'
        const journal = {
            transactionId: 'tx-crash-123',
            status: 'committed' as const,
            candidateRevision: 'rev-crash-recovered',
            generation: 2,
            timestamp: Date.now(),
            files: [
                {
                    targetPath: settingsPath,
                    tempPath: path.join(homeDir, '.coding-professional-agent', '.settings.tmp-crash'),
                    oldContent: JSON.stringify({ plugins: { version: 1, sources: [], disabled: [] } }),
                    oldHash: 'oldhash',
                    newContent,
                    newHash: 'newhash',
                },
            ],
        }

        await fs.writeFile(journalPath, JSON.stringify(journal, null, 2), 'utf-8')

        // Run recovery
        await recoverFromJournal(homeDir)

        // Settings file must have been updated to newContent
        const updatedSettings = await fs.readFile(settingsPath, 'utf-8')
        expect(JSON.parse(updatedSettings)).toEqual(JSON.parse(newContent))

        // Journal must have been removed
        await expect(fs.stat(journalPath)).rejects.toThrow()
    })

    it('crash recovery discards prepared uncommitted journal on bootstrap', async () => {
        const { recoverFromJournal } = await import('../src/main/plugins/config/pluginSourceConfig.js')
        const journalPath = path.join(homeDir, '.coding-professional-agent', 'plugin-graph-journal.json')
        const settingsPath = path.join(homeDir, '.coding-professional-agent', 'settings.json')
        const tempPath = path.join(homeDir, '.coding-professional-agent', '.settings.tmp-uncommitted')

        const originalContent = JSON.stringify({
            plugins: { version: 1, sources: [], disabled: [] },
        })
        await fs.writeFile(settingsPath, originalContent, 'utf-8')
        await fs.writeFile(tempPath, 'uncommitted garbage', 'utf-8')

        const journal = {
            transactionId: 'tx-crash-prepared',
            status: 'prepared' as const,
            candidateRevision: 'rev-crash-prepared',
            generation: 2,
            timestamp: Date.now(),
            files: [
                {
                    targetPath: settingsPath,
                    tempPath,
                    oldContent: originalContent,
                    oldHash: 'oldhash',
                    newContent: 'never-committed',
                    newHash: 'newhash',
                },
            ],
        }

        await fs.writeFile(journalPath, JSON.stringify(journal, null, 2), 'utf-8')

        // Run recovery
        await recoverFromJournal(homeDir)

        // Settings file must remain untouched
        const currentSettings = await fs.readFile(settingsPath, 'utf-8')
        expect(currentSettings).toBe(originalContent)

        // Temp file and journal must be cleaned
        await expect(fs.stat(tempPath)).rejects.toThrow()
        await expect(fs.stat(journalPath)).rejects.toThrow()
    })
})
