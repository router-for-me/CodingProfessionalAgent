import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    createHostServices,
    getHostAgentController,
    getHostRouter,
    getHostServices,
    registerHostAgentController,
    setHostRouter,
    setHostServices,
} from './createHostServices'
import { setHostBridge } from './hostTransport'
import { useSessionStore } from '@/stores/sessionStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionRunStore } from '@/stores/sessionRunStore'
import { useMessageStore } from '@/stores/messageStore'
import { useUiStore } from '@/stores/uiStore'
import { useSkillUsageStore } from '@/stores/skillUsageStore'
import {
    type HookConfiguration,
    PluginManagementUnavailableError,
    GatewayDiscoveryServiceToken,
    type DiscoveredGateway,
} from '@cpa/plugin-api'
import { useHostService } from '@cpa/plugin-ui'
import { renderHook } from '@testing-library/react'
import * as fs from 'node:fs'
import * as path from 'node:path'

describe('createHostServices', () => {
    it('routes memory filesystem operations to registered native RPCs and normalizes entries', async () => {
        const capabilityClient = { invoke: vi.fn().mockResolvedValue(undefined) }
        const fileSystem = createHostServices({ capabilityClient }).fileSystem!
        capabilityClient.invoke.mockResolvedValueOnce([{ name: 'link', isDir: false, isSymbolicLink: true }])
        expect(await fileSystem.readDir!('/memories')).toEqual([
            { name: 'link', isDirectory: false, isFile: false, isSymbolicLink: true, path: '/memories/link' },
        ])
        expect(capabilityClient.invoke).toHaveBeenLastCalledWith('native:readDir', ['/memories'])
        await fileSystem.stat!('/memories')
        expect(capabilityClient.invoke).toHaveBeenLastCalledWith('native:stat', ['/memories'])
        await fileSystem.removeFile!('/memories/note.md')
        expect(capabilityClient.invoke).toHaveBeenLastCalledWith('native:removeFile', ['/memories/note.md'])
        await fileSystem.mkdirAll!('/memories')
        expect(capabilityClient.invoke).toHaveBeenLastCalledWith('native:mkdirAll', ['/memories'])
        capabilityClient.invoke.mockResolvedValueOnce({ homeDir: '/home/test' })
        await fileSystem.getRuntimeInfo!()
        expect(capabilityClient.invoke).toHaveBeenLastCalledWith('native:runtimeInfo')
    })

    it('propagates filesystem transport failures', async () => {
        const capabilityClient = { invoke: vi.fn().mockRejectedValue(new Error('denied')) }
        const fileSystem = createHostServices({ capabilityClient }).fileSystem!
        await expect(fileSystem.removeFile!('/memories/note.md')).rejects.toThrow('denied')
        await expect(fileSystem.readDir!('/memories')).rejects.toThrow('denied')
        await expect(fileSystem.stat!('/memories')).rejects.toThrow('denied')
    })

    it('creates hook io through the injected HookService', async () => {
        const capabilityClient = {
            invoke: vi.fn().mockResolvedValue(undefined),
        }
        const services = createHostServices({ capabilityClient })
        const projectPath = '/path/to/project'
        const config: HookConfiguration = {
            userHooks: [],
            projectHooks: [],
        }

        await services.hooks.save(projectPath, config)
        expect(capabilityClient.invoke).toHaveBeenCalledWith('hooks.write', [projectPath, config])
    })

    it('loads hook io through the injected HookService', async () => {
        const expectedConfig: HookConfiguration = {
            userHooks: [],
            projectHooks: [],
        }
        const capabilityClient = {
            invoke: vi.fn().mockResolvedValue(expectedConfig),
        }
        const services = createHostServices({ capabilityClient })
        const projectPath = '/path/to/project'

        const result = await services.hooks.load(projectPath)
        expect(capabilityClient.invoke).toHaveBeenCalledWith('hooks.read', [projectPath])
        expect(result).toEqual(expectedConfig)
    })

    it('delegates session operations through SessionService', async () => {
        const capabilityClient = {
            invoke: vi.fn().mockImplementation((method: string, args: unknown[]) => {
                if (method === 'sessions.list') return Promise.resolve([{ id: 'sess-1', title: 'Test' }])
                if (method === 'sessions.get') return Promise.resolve({ id: args[0], title: 'Test' })
                if (method === 'sessions.update') return Promise.resolve()
                if (method === 'sessions.broadcastRunStatus') return Promise.resolve()
                return Promise.resolve()
            }),
        }
        const services = createHostServices({ capabilityClient })

        const list = await services.sessions.list()
        expect(list).toHaveLength(1)
        expect(list[0].id).toBe('sess-1')

        const session = await services.sessions.get('sess-1')
        expect(session?.id).toBe('sess-1')

        await services.sessions.update('sess-1', { title: 'Updated' })
        expect(capabilityClient.invoke).toHaveBeenCalledWith('sessions.update', ['sess-1', { title: 'Updated' }])

        await services.sessions.broadcastRunStatus('sess-1', 'running')
        expect(capabilityClient.invoke).toHaveBeenCalledWith('sessions.broadcastRunStatus', ['sess-1', 'running'])
    })

    it('delegates project operations through ProjectService', async () => {
        const capabilityClient = {
            invoke: vi.fn().mockImplementation((method: string) => {
                if (method === 'projects.list') return Promise.resolve([{ id: 'proj-1', name: 'Project 1' }])
                return Promise.resolve()
            }),
        }
        const services = createHostServices({ capabilityClient })

        const projects = await services.projects.list()
        expect(projects).toHaveLength(1)
        expect(projects[0].name).toBe('Project 1')

        await services.projects.save({ id: 'proj-1', name: 'Project 1', pinned: false, createdAt: 0, updatedAt: 0 })
        expect(capabilityClient.invoke).toHaveBeenCalledWith('projects.save', [{ id: 'proj-1', name: 'Project 1', pinned: false, createdAt: 0, updatedAt: 0 }])

        await services.projects.remove('/path/to/project')
        expect(capabilityClient.invoke).toHaveBeenCalledWith('projects.remove', ['/path/to/project'])
    })

    it('delegates settings operations through SettingsService', async () => {
        const capabilityClient = {
            invoke: vi.fn().mockImplementation((method: string) => {
                if (method === 'settings.get') return Promise.resolve({ theme: 'dark' })
                return Promise.resolve()
            }),
        }
        const services = createHostServices({ capabilityClient })

        const settings = await services.settings.get()
        expect(settings.theme).toBe('dark')

        await services.settings.update({ theme: 'light' })
        expect(capabilityClient.invoke).toHaveBeenCalledWith('settings.update', [{ theme: 'light' }])
    })

    it('delegates worktree operations through WorktreeService', async () => {
        const capabilityClient = {
            invoke: vi.fn().mockResolvedValue({ ok: true, worktreePath: '/tmp/wt', branch: 'feat/test' }),
        }
        const services = createHostServices({ capabilityClient })

        const result = await services.worktrees.setup({
            sessionId: 'sess-1',
            sourceTreePath: '/repo',
            branch: 'feat/test',
        })
        expect(result.ok).toBe(true)
        expect(result.worktreePath).toBe('/tmp/wt')
    })

    it('delegates sessionMetrics query through SessionMetricsService', async () => {
        const mockMetrics = { summary: { totalTokens: 1000 }, buckets: [] }
        const capabilityClient = {
            invoke: vi.fn().mockResolvedValue(mockMetrics),
        }
        const services = createHostServices({ capabilityClient })

        const result = await services.sessionMetrics?.queryMetrics({ timeGranularity: 'day' })
        expect(capabilityClient.invoke).toHaveBeenCalledWith('session:queryMetrics', [{ timeGranularity: 'day' }])
        expect(result).toEqual(mockMetrics)
    })

    afterEach(() => {
        setHostBridge(null)
    })

    it('notifies chat message subscribers only for their session', () => {
        useMessageStore.setState({ entriesBySession: {}, maxCachedSessions: 8 })
        const services = createHostServices()
        const listener = vi.fn()
        const unsubscribe = services.chatMessages?.subscribeMessages?.('session-1', listener)

        try {
            useMessageStore.getState().replaceSessionEntries('session-2', [
                {
                    id: 'user-2',
                    sessionId: 'session-2',
                    kind: 'user',
                    version: 1,
                    createdAt: 1,
                    content: [{ type: 'text', text: 'background' }],
                },
            ])
            expect(listener).not.toHaveBeenCalled()

            useMessageStore.getState().replaceSessionEntries('session-1', [
                {
                    id: 'user-1',
                    sessionId: 'session-1',
                    kind: 'user',
                    version: 1,
                    createdAt: 1,
                    content: [{ type: 'text', text: 'visible' }],
                },
            ])
            expect(listener).toHaveBeenCalledTimes(1)
        } finally {
            unsubscribe?.()
            useMessageStore.setState({ entriesBySession: {}, maxCachedSessions: 8 })
        }
    })

    it('delegates process execution through ProcessService', async () => {
        const mockRunResult = { exitCode: 0, stdout: 'ok', stderr: '' }
        const capabilityClient = {
            invoke: vi.fn().mockResolvedValue(mockRunResult),
        }
        const services = createHostServices({ capabilityClient })

        const result = await services.process?.run({ command: 'git', args: ['status'] })
        expect(capabilityClient.invoke).toHaveBeenCalledWith('process.run', [{ command: 'git', args: ['status'] }])
        expect(result).toEqual(mockRunResult)
    })

    it('runs processes through host bridge RunProcess and decodes base64 output', async () => {
        const runProcess = vi.fn().mockResolvedValue({
            exitCode: 0,
            stdoutBase64: btoa('M file.ts\n'),
            stderrBase64: btoa(''),
            fullOutputPath: '/tmp/out.log',
        })
        const lookPath = vi.fn().mockResolvedValue('/usr/bin/git')
        setHostBridge({
            RunProcess: runProcess,
            LookPath: lookPath,
        } as any)

        const services = createHostServices()
        const result = await services.process?.run({
            command: 'git',
            args: ['status', '--porcelain'],
            cwd: '/workspace/demo',
        })

        expect(lookPath).toHaveBeenCalledWith('git')
        expect(runProcess).toHaveBeenCalledWith(
            expect.objectContaining({
                executable: '/usr/bin/git',
                args: ['status', '--porcelain'],
                cwd: '/workspace/demo',
                env: null,
                operationId: expect.any(String),
            }),
        )
        expect(result).toEqual({
            exitCode: 0,
            stdout: 'M file.ts\n',
            stderr: '',
        })
    })

    it('resolves worktree root dir correctly and safely expands ~ without hardcoded user paths', async () => {
        const services = createHostServices({
            fileSystem: {
                readFile: vi.fn(),
                writeFile: vi.fn(),
                getRuntimeInfo: vi.fn().mockResolvedValue({ homeDir: '/Users/testuser' }),
            } as any,
        })

        const resolvedDefault = await services.worktrees.resolveRootDir?.()
        expect(resolvedDefault).toBe('/Users/testuser/.coding-professional-agent/worktrees')

        const resolvedTilde = await services.worktrees.resolveRootDir?.('~/custom-wt')
        expect(resolvedTilde).toBe('/Users/testuser/custom-wt')

        const resolvedAbsolute = await services.worktrees.resolveRootDir?.('/opt/worktrees')
        expect(resolvedAbsolute).toBe('/opt/worktrees')
    })

    it('delegates navigation operations through NavigationService', async () => {
        const navigateFn = vi.fn()
        const services = createHostServices({ router: { navigate: navigateFn } })

        await services.navigation.navigate('/chat/sess-1')
        expect(navigateFn).toHaveBeenCalledWith({ to: '/chat/sess-1' })
    })

    it('delegates navigation through global host router when options.router is not supplied', async () => {
        const navigateFn = vi.fn()
        setHostRouter({ navigate: navigateFn })

        const services = createHostServices()
        await services.navigation.navigate({ to: '/chat/$sessionId', params: { sessionId: 'sess-2' } })
        expect(navigateFn).toHaveBeenCalledWith({ to: '/chat/$sessionId', params: { sessionId: 'sess-2' } })

        setHostRouter(null)
        expect(getHostRouter()).toBeNull()
    })

    it('delegates notification operations through NotificationService', () => {
        const notifyFn = vi.fn()
        const services = createHostServices({ notifier: { show: notifyFn } })

        services.notifications.show({ message: 'Hello World', type: 'info' })
        expect(notifyFn).toHaveBeenCalledWith({ message: 'Hello World', type: 'info' })
    })

    it('supports getHostServices and setHostServices lifecycle', () => {
        const customServices = createHostServices()
        setHostServices(customServices)
        expect(getHostServices()).toBe(customServices)
    })

    it('correctly dispatches openSettings with section string and params object to uiStore', () => {
        const services = createHostServices()
        useUiStore.setState({ settingsOpen: false, settingsSection: undefined, settingsParams: undefined })

        services.ui?.openSettings?.('environments', { projectId: 'proj-test', mode: 'detail', fromChat: true })
        expect(useUiStore.getState().settingsOpen).toBe(true)
        expect(useUiStore.getState().settingsSection).toBe('environments')
        expect(useUiStore.getState().settingsParams).toEqual({
            projectId: 'proj-test',
            mode: 'detail',
            fromChat: true,
        })

        services.ui?.closeSettings?.()
        expect(useUiStore.getState().settingsOpen).toBe(false)
        expect(useUiStore.getState().settingsSection).toBeUndefined()
        expect(useUiStore.getState().settingsParams).toBeUndefined()
    })

    it('delegates schedule operations through ScheduleService', async () => {
        const capabilityClient = {
            invoke: vi.fn().mockImplementation((method: string) => {
                if (method === 'schedule:list') return Promise.resolve([{ id: 'task-1', title: 'Task 1' }])
                if (method === 'schedule:save') return Promise.resolve()
                return Promise.resolve()
            }),
        }
        const services = createHostServices({ capabilityClient })

        const tasks = await services.schedule.list()
        expect(tasks).toHaveLength(1)
        expect(tasks[0].id).toBe('task-1')

        await services.schedule.save(tasks)
        expect(capabilityClient.invoke).toHaveBeenCalledWith('schedule:save', [tasks])
    })

    it('delegates skillUsage operations through SkillUsageService', async () => {
        useSkillUsageStore.getState().reset()
        const capabilityClient = {
            invoke: vi.fn().mockResolvedValue({ 'test-skill': 5 }),
        }
        const services = createHostServices({ capabilityClient })

        const counts = await services.skillUsage.fetchUsageCounts()
        expect(counts['test-skill']).toBe(5)
        expect(services.skillUsage.getSnapshot?.()?.['test-skill']).toBe(5)

        const listener = vi.fn()
        const unsubscribe = services.skillUsage.subscribe?.(listener)
        services.skillUsage.recordUsage('another-skill')
        expect(listener).toHaveBeenCalled()
        expect(services.skillUsage.getSnapshot?.()?.['another-skill']).toBe(1)
        unsubscribe?.()

        const skills = [{ name: 'gh-issue', description: 'Triage' }]
        const catalogListener = vi.fn()
        const unsubscribeCatalog = services.skillUsage.subscribeAvailableSkills?.(catalogListener)
        services.skillUsage.setAvailableSkills?.(skills)
        expect(services.skillUsage.getAvailableSkills?.()).toBe(skills)
        expect((globalThis as any).__cpaComposerSkills).toEqual(skills)
        expect(catalogListener).toHaveBeenCalledTimes(1)
        services.skillUsage.setAvailableSkills?.([])
        expect(services.skillUsage.getAvailableSkills?.()).toEqual([])
        expect((globalThis as any).__cpaComposerSkills).toEqual([])
        expect(catalogListener).toHaveBeenCalledTimes(2)
        unsubscribeCatalog?.()
        services.skillUsage.setAvailableSkills?.(skills)
        expect(catalogListener).toHaveBeenCalledTimes(2)

        useSkillUsageStore.getState().reset()
        delete (globalThis as any).__cpaComposerSkills
    })

    it('ensures frontend/src/stores does not import ElectronNativeBridge directly', () => {
        const storesDir = path.resolve(__dirname, '../../stores')
        const files = fs.readdirSync(storesDir)

        for (const file of files) {
            if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue
            if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue

            const content = fs.readFileSync(path.join(storesDir, file), 'utf8')
            expect(content).not.toContain('ElectronNativeBridge')
        }
    })

    it('ensures persistenceService.ts does not import from components/', () => {
        const persistPath = path.resolve(__dirname, './persistenceService.ts')
        const content = fs.readFileSync(persistPath, 'utf8')

        expect(content).not.toMatch(/from\s+['"]@\/components\//)
        expect(content).not.toMatch(/from\s+['"]\.\.\/components\//)
    })

    it('rejects plugin mutations with PluginManagementUnavailableError when capabilityClient is not configured', async () => {
        const services = createHostServices({ capabilityClient: undefined })
        const pm = services.pluginManagement
        expect(pm).toBeDefined()
        if (!pm) return

        // Read-only methods should be safe
        expect(Array.isArray(pm.getPluginSummaries())).toBe(true)
        expect(typeof pm.isPluginActive('any-id')).toBe('boolean')

        // Mutations must throw PluginManagementUnavailableError
        await expect(pm.activatePlugin('test-plugin')).rejects.toThrow(
            PluginManagementUnavailableError,
        )
        await expect(pm.enablePlugin?.('test-plugin')).rejects.toThrow(
            PluginManagementUnavailableError,
        )
        await expect(pm.deactivatePlugin('test-plugin')).rejects.toThrow(
            PluginManagementUnavailableError,
        )
        await expect(pm.disablePlugin?.('test-plugin')).rejects.toThrow(
            PluginManagementUnavailableError,
        )
        await expect(pm.reloadPlugin('test-plugin')).rejects.toThrow(
            PluginManagementUnavailableError,
        )
        await expect(pm.installPlugin?.('npm:test-pkg@1.0.0')).rejects.toThrow(
            PluginManagementUnavailableError,
        )
        await expect(pm.uninstallPlugin?.('test-plugin')).rejects.toThrow(
            PluginManagementUnavailableError,
        )
    })

    it('executes plugin coordinated actions via connected host bridge when capabilityClient is not explicitly passed', async () => {
        const prepareDisable = vi.fn().mockResolvedValue({
            candidateRevision: 'rev-2',
            generation: 2,
            graph: {
                revision: 'rev-2',
                packages: [],
            },
        })
        const prepareConfig = vi.fn().mockResolvedValue({ ok: true })
        const commit = vi.fn().mockResolvedValue({ ok: true })
        const finalize = vi.fn().mockResolvedValue({ ok: true })
        const pluginsList = vi.fn().mockResolvedValue({
            plugins: [
                {
                    manifest: { id: 'codex-computer-use', name: 'Codex Computer Use' },
                    status: 'inactive',
                },
            ],
            activeRevision: 'rev-2',
            generation: 2,
        })

        setHostBridge({
            PluginsPrepareDisable: prepareDisable,
            PluginsPrepareConfig: prepareConfig,
            PluginsCommit: commit,
            PluginsFinalize: finalize,
            PluginsList: pluginsList,
        } as any)

        const services = createHostServices()
        const pm = services.pluginManagement
        expect(pm).toBeDefined()
        if (!pm) return

        await pm.deactivatePlugin('codex-computer-use')

        expect(prepareDisable).toHaveBeenCalledWith('codex-computer-use', undefined)
        expect(prepareConfig).toHaveBeenCalledWith('rev-2')
        expect(commit).toHaveBeenCalledWith('rev-2', 2)
        expect(finalize).toHaveBeenCalledWith('rev-2')
        expect(pluginsList).toHaveBeenCalled()

        expect(pm.isPluginActive('codex-computer-use')).toBe(false)
        const summary = pm.getPluginSummaries().find((s) => s.manifest.id === 'codex-computer-use')
        expect(summary?.status).toBe('inactive')

        // Test re-enabling plugin
        const prepareEnable = vi.fn().mockResolvedValue({
            candidateRevision: 'rev-3',
            generation: 3,
            graph: {
                revision: 'rev-3',
                packages: [],
            },
        })
        pluginsList.mockResolvedValueOnce({
            plugins: [
                {
                    manifest: { id: 'codex-computer-use', name: 'Codex Computer Use' },
                    status: 'active',
                },
            ],
            activeRevision: 'rev-3',
            generation: 3,
        })
        setHostBridge({
            PluginsPrepareEnable: prepareEnable,
            PluginsPrepareConfig: prepareConfig,
            PluginsCommit: commit,
            PluginsFinalize: finalize,
            PluginsList: pluginsList,
        } as any)

        await pm.activatePlugin('codex-computer-use')
        expect(prepareEnable).toHaveBeenCalledWith('codex-computer-use', undefined)
        expect(pm.isPluginActive('codex-computer-use')).toBe(true)
        const summaryActive = pm.getPluginSummaries().find((s) => s.manifest.id === 'codex-computer-use')
        expect(summaryActive?.status).toBe('active')
    })

    it('provides unified plugin summaries and active status via pluginPlatformCoordinator', async () => {
        const services = createHostServices({ capabilityClient: undefined })
        const pm = services.pluginManagement
        expect(pm).toBeDefined()
        if (!pm) return

        const summaries = pm.getPluginSummaries()
        expect(Array.isArray(summaries)).toBe(true)
        expect(summaries.length).toBeGreaterThan(0)

        const listener = vi.fn()
        const unsub = pm.subscribe ? pm.subscribe(listener) : () => {}
        expect(typeof unsub).toBe('function')
        unsub()
    })

    it('delegates chatMessages and agentRun operations to registered HostAgentController', async () => {
        const services = createHostServices()
        expect(services.chatMessages).toBeDefined()
        expect(await services.chatMessages!.send?.({ text: 'hello', sessionId: 's1' })).toBeUndefined()

        const mockSend = vi.fn().mockResolvedValue('session-123')
        const mockStop = vi.fn()
        const mockCompact = vi.fn().mockResolvedValue(undefined)
        const mockRetrySession = vi.fn().mockResolvedValue(undefined)
        const mockResumeSession = vi.fn().mockResolvedValue('s1')
        const mockApproveTool = vi.fn()
        const mockRejectTool = vi.fn()
        const mockGetPrompts = vi.fn().mockReturnValue([{ name: 'test-prompt', content: 'content' }])

        const unregister = registerHostAgentController({
            send: mockSend,
            stop: mockStop,
            abort: mockStop,
            compact: mockCompact,
            retrySession: mockRetrySession,
            resumeSession: mockResumeSession,
            approveTool: mockApproveTool,
            rejectTool: mockRejectTool,
            getPrompts: mockGetPrompts,
        })

        expect(getHostAgentController()).toBeDefined()

        const sendResult = await services.chatMessages!.send?.({ text: 'hello', sessionId: 's1' })
        expect(sendResult).toBe('session-123')
        expect(mockSend).toHaveBeenCalledWith({ text: 'hello', sessionId: 's1' })

        services.chatMessages!.stop?.('s1')
        expect(mockStop).toHaveBeenCalledWith('s1')

        services.chatMessages!.abort?.('s1')
        expect(mockStop).toHaveBeenCalledWith('s1')

        await services.chatMessages!.compact?.('focus-test', 's1')
        expect(mockCompact).toHaveBeenCalledWith('focus-test', 's1')

        await services.chatMessages!.retrySession?.('s1')
        expect(mockRetrySession).toHaveBeenCalledWith('s1')

        const resumeResult = await services.chatMessages!.resumeSession?.('s1')
        expect(resumeResult).toBe('s1')
        expect(mockResumeSession).toHaveBeenCalledWith('s1')

        const agentRunResumeResult = await services.agentRun?.resumeSession?.('s1')
        expect(agentRunResumeResult).toBe('s1')

        services.chatMessages!.approveTool?.('tool-1')
        expect(mockApproveTool).toHaveBeenCalledWith('tool-1')

        services.chatMessages!.rejectTool?.('tool-2')
        expect(mockRejectTool).toHaveBeenCalledWith('tool-2')

        expect(services.chatMessages!.getPrompts?.()).toEqual([{ name: 'test-prompt', content: 'content' }])

        // Verify agentRun bridge
        const agentRunSendResult = await services.agentRun?.send({ text: 'run-hello', sessionId: 's2' })
        expect(agentRunSendResult).toBe('session-123')

        unregister()
        expect(getHostAgentController()).toBeNull()
        expect(await services.chatMessages!.send?.({ text: 'hello', sessionId: 's1' })).toBeUndefined()
    })

    it('cancels cache warmers when warming mode is turned off and when session is deleted', async () => {
        const mockCancelSessionWarmers = vi.fn()
        const unregister = registerHostAgentController({
            send: vi.fn(),
            cancelSessionWarmers: mockCancelSessionWarmers,
        })

        const services = createHostServices()

        // 1. Turning warming off immediately cancels all warmers
        await services.settings.update({
            modelSettings: {
                enableAll: true,
                models: {},
                cacheWarming: {
                    mode: 'off',
                    maxWarmingTime: 1800,
                },
            },
        })
        expect(mockCancelSessionWarmers).toHaveBeenCalledWith(undefined)

        // 2. Deleting a session cancels warmers for that session
        mockCancelSessionWarmers.mockClear()
        await services.sessions.delete?.('test-delete-session')
        expect(mockCancelSessionWarmers).toHaveBeenCalledWith('test-delete-session')

        unregister()
    })

    it('delegates forkSession through both sessions and chatMessages service', async () => {
        const services = createHostServices()
        const sourceId = 'test-fork-source'
        useSessionStore.getState().createSession({
            id: sourceId,
            title: 'Source Chat',
            branch: 'feature-1',
        })
        useMessageStore.getState().replaceSessionEntries(sourceId, [
            {
                kind: 'user',
                id: 'u-1',
                sessionId: sourceId,
                content: [{ type: 'text', text: 'Hello' }],
                createdAt: 100,
            },
        ])

        const forkedId = await services.sessions.forkSession?.(sourceId)
        expect(forkedId).toBeDefined()
        expect(forkedId).not.toBe(sourceId)

        const forkedSession = useSessionStore.getState().sessions.find((s) => s.id === forkedId)
        expect(forkedSession).toBeDefined()
        expect(forkedSession?.title).toBe('Source Chat (Fork)')
        expect(forkedSession?.branch).toBe('feature-1')

        const chatForkedId = await services.chatMessages?.forkSession?.(sourceId)
        expect(chatForkedId).toBeDefined()
        expect(chatForkedId).not.toBe(sourceId)
    })

    it('manages agentRunState correctly for idle, running, and error states', () => {
        const services = createHostServices()

        // Empty session
        expect(services.chatMessages?.getAgentRunState?.('')).toEqual({
            isStreaming: false,
            activeRunId: null,
        })

        // Remote running
        useSessionRunStore.getState().setRun('sess-run-1', {
            sessionId: 'sess-run-1',
            runId: 'run-1',
            status: 'running',
            clientId: 'client-1',
            updatedAt: Date.now(),
        })
        expect(services.chatMessages?.getAgentRunState?.('sess-run-1')?.isStreaming).toBe(true)
        expect(services.agentRun?.getRunState('sess-run-1').isStreaming).toBe(true)

        // Error / interrupted state: must NOT be streaming
        useSessionRunStore.getState().setRun('sess-run-1', {
            sessionId: 'sess-run-1',
            runId: 'run-1',
            status: 'error',
            error: 'Stream interrupted',
            clientId: 'client-1',
            updatedAt: Date.now(),
        })
        expect(services.chatMessages?.getAgentRunState?.('sess-run-1')?.isStreaming).toBe(false)
        expect(services.agentRun?.getRunState('sess-run-1').isStreaming).toBe(false)

        // Idle state: must NOT be streaming
        useSessionRunStore.getState().setRun('sess-run-1', {
            sessionId: 'sess-run-1',
            runId: 'run-1',
            status: 'idle',
            clientId: 'client-1',
            updatedAt: Date.now(),
        })
        expect(services.chatMessages?.getAgentRunState?.('sess-run-1')?.isStreaming).toBe(false)

        // Clean up
        useSessionRunStore.getState().clearRun('sess-run-1')
    })

    it('updates session and project workLocation when sessions.update receives workLocation patch', async () => {
        const services = createHostServices()
        const sessId = 'sess-work-location-sync'
        useProjectStore.setState({
            projects: [{ id: 'proj-sync-test', name: 'Sync Project', pinned: false, createdAt: 1, updatedAt: 1 }],
        })
        useSessionStore.setState({
            sessions: [
                {
                    id: sessId,
                    projectId: 'proj-sync-test',
                    title: 'Work Location Sync',
                    pinned: false,
                    workLocation: 'worktree',
                    environmentId: 'env-node',
                    createdAt: 100,
                    updatedAt: 100,
                },
            ],
            currentSessionId: sessId,
        })

        await services.sessions.update(sessId, { workLocation: 'local', environmentId: null })

        const session = useSessionStore.getState().sessions.find((s) => s.id === sessId)
        expect(session?.workLocation).toBe('local')
        expect(session?.environmentId).toBeNull()

        const project = useProjectStore.getState().projects.find((p) => p.id === 'proj-sync-test')
        expect(project?.workLocation).toBe('local')
        expect(project?.environmentId).toBeNull()
    })

    it('delegates sessions.setWorktree to update worktreeSetup in sessionStore cleanly', () => {
        const services = createHostServices()
        const sessId = 'sess-worktree-setup-sync'
        useSessionStore.setState({
            sessions: [
                {
                    id: sessId,
                    title: 'Setup Sync',
                    pinned: false,
                    createdAt: 100,
                    updatedAt: 100,
                },
            ],
        })

        services.sessions.setWorktree?.(sessId, {
            status: 'ready',
            branch: 'feat/test',
        } as any)

        const session = useSessionStore.getState().sessions.find((s) => s.id === sessId)
        expect(session?.worktreeSetup?.status).toBe('ready')
        expect(session?.worktreeSetup?.branch).toBe('feat/test')
        expect(session?.workLocation).toBe('worktree')
    })

    it('registers gatewayDiscoveryService and delegates discover call to bridge.GatewayDiscover', async () => {
        const mockGateways: DiscoveredGateway[] = [
            {
                instanceName: 'Test CPA',
                host: 'cpa.local',
                port: 8317,
                addresses: ['192.168.1.100'],
                primaryAddress: '192.168.1.100',
                baseUrl: 'http://192.168.1.100:8317',
                product: 'cliproxyapi',
                authRequired: true,
            },
        ]
        const gatewayDiscover = vi.fn().mockResolvedValue(mockGateways)
        setHostBridge({ GatewayDiscover: gatewayDiscover } as any)

        const services = createHostServices()
        expect(services.gatewayDiscovery).toBeDefined()

        const result = await services.gatewayDiscovery!.discover(2500)
        expect(gatewayDiscover).toHaveBeenCalledWith(2500)
        expect(result).toEqual(mockGateways)

        // Verify GatewayDiscoveryServiceToken resolution via HostServices
        const { result: hookResult } = renderHook(() => useHostService(GatewayDiscoveryServiceToken))
        expect(hookResult.current).toBe(services.gatewayDiscovery)
    })
})
