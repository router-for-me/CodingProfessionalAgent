import { describe, expect, it, vi } from 'vitest'
import type { ModelCatalogEntry } from '@/features/models/types'
import { FakeNativeBridge } from '../native/fakeNativeBridge'
import {
    createToolsFromProviders,
    findToolByNameOrAlias,
    selectApprovalPolicy,
    ToolFactoryProvider,
    type ToolFactoryProviderContext,
} from './ToolFactoryProvider'
import type { ToolFactoryContribution, AgentTool, HostServices } from '@cpa/plugin-api'
import { RendererRegistry } from '@/plugins/platform/rendererRegistry'
import { toolsAgentEntry } from '../../../../../plugins/bundled/cpa.core.tools/agent/index'

const testModel: ModelCatalogEntry = {
    id: 'test-model',
    label: 'Test Model',
    supportsFast: true,
    reasoningLevels: [],
    input: ['text', 'image'],
    contextWindow: 128_000,
    maxTokens: 8_192,
}

function createMockHostServices(): HostServices {
    return {
        sessions: {
            list: vi.fn(async () => []),
            get: vi.fn(async () => undefined),
            update: vi.fn(async () => {}),
            broadcastRunStatus: vi.fn(async () => {}),
        },
        projects: {
            list: vi.fn(async () => []),
            save: vi.fn(async () => {}),
            remove: vi.fn(async () => {}),
        },
        settings: {
            get: vi.fn(async () => ({} as any)),
            update: vi.fn(async () => {}),
        },
        worktrees: {
            setup: vi.fn(async () => ({ ok: true })),
        },
        hooks: {
            load: vi.fn(async () => ({})),
            save: vi.fn(async () => {}),
        },
        navigation: {
            navigate: vi.fn(async () => {}),
        },
        notifications: {
            show: vi.fn(),
        },
        schedule: {
            list: vi.fn(async () => []),
            save: vi.fn(async () => {}),
        },
        skillUsage: {
            fetchUsageCounts: vi.fn(async () => ({})),
            recordUsage: vi.fn(),
        },
        persistence: {
            init: vi.fn(async () => {}),
            flush: vi.fn(async () => {}),
        },
    }
}

function activateEntry(entry: any, registry: RendererRegistry): void {
    const fakeContext = {
        register: (contrib: any) => {
            if (contrib.kind === 'tool-factory') {
                registry.registerToolFactory(contrib.value)
            }
        },
        getService: () => undefined,
    }
    entry.activate(fakeContext as any)
}

describe('ToolFactoryProvider', () => {
    it('preserves the existing coding tool order and approval categories', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setRuntimeInfo({ platform: 'darwin' })
        await bridge.mkdirAll('/repo')

        const registry = new RendererRegistry()
        activateEntry(toolsAgentEntry, registry)

        const context: ToolFactoryProviderContext = {
            cwd: '/repo',
            platform: 'darwin',
            services: createMockHostServices(),
            bridge,
            model: testModel,
            extensionRegistry: registry,
        }

        const tools = await createToolsFromProviders(context)
        expect(tools.map((tool) => tool.name)).toEqual(['read', 'bash', 'edit', 'write'])
        expect(selectApprovalPolicy(tools.find((tool) => tool.name === 'write')!)).toEqual({
            riskLevel: 'write',
            requiresApproval: true,
            approvalCategory: 'filesystem-write',
        })
        expect(selectApprovalPolicy(tools.find((tool) => tool.name === 'edit')!)).toEqual({
            riskLevel: 'write',
            requiresApproval: true,
            approvalCategory: 'filesystem-write',
        })
        expect(selectApprovalPolicy(tools.find((tool) => tool.name === 'bash')!)).toEqual({
            riskLevel: 'process',
            requiresApproval: true,
            approvalCategory: 'shell-execution',
        })
        expect(selectApprovalPolicy(tools.find((tool) => tool.name === 'read')!)).toEqual({
            riskLevel: 'read',
            requiresApproval: false,
            approvalCategory: 'filesystem-read',
        })
    })

    it('supports windows shell selection (pwsh) and aliases (powershell, bash)', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setRuntimeInfo({ platform: 'win32' })
        await bridge.mkdirAll('/repo')

        const registry = new RendererRegistry()
        activateEntry(toolsAgentEntry, registry)

        const context: ToolFactoryProviderContext = {
            cwd: '/repo',
            platform: 'win32',
            services: createMockHostServices(),
            bridge,
            model: testModel,
            extensionRegistry: registry,
        }

        const tools = await createToolsFromProviders(context)
        expect(tools.map((tool) => tool.name)).toEqual(['read', 'pwsh', 'edit', 'write'])
        expect(selectApprovalPolicy(tools.find((tool) => tool.name === 'pwsh')!)).toEqual({
            riskLevel: 'process',
            requiresApproval: true,
            approvalCategory: 'shell-execution',
        })

        // pwsh tool can be found by alias 'powershell'
        const matched = findToolByNameOrAlias(tools, 'powershell')
        expect(matched).toBeDefined()
        expect(matched?.name).toBe('pwsh')
        expect(selectApprovalPolicy('powershell')).toEqual({
            riskLevel: 'process',
            requiresApproval: true,
            approvalCategory: 'shell-execution',
        })
    })

    it('filters tools by targetAgent (main vs subagent vs all)', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setRuntimeInfo({ platform: 'darwin' })
        await bridge.mkdirAll('/repo')

        const registry = new RendererRegistry()
        const customMainContrib: ToolFactoryContribution = {
            id: 'custom_main_only',
            order: 50,
            targets: ['main'],
            riskLevel: 'read',
            requiresApproval: false,
            approvalCategory: 'custom',
            create: () => ({
                name: 'custom_main_only',
                label: 'custom_main_only',
                description: 'Main only custom tool',
                parameters: { type: 'object' },
                validate: (input) => input as any,
                execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
            }),
        }

        const customSubContrib: ToolFactoryContribution = {
            id: 'custom_sub_only',
            order: 60,
            targets: ['subagent'],
            riskLevel: 'read',
            requiresApproval: false,
            approvalCategory: 'custom',
            create: () => ({
                name: 'custom_sub_only',
                label: 'custom_sub_only',
                description: 'Sub only custom tool',
                parameters: { type: 'object' },
                validate: (input) => input as any,
                execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
            }),
        }

        registry.registerToolFactory(customMainContrib)
        registry.registerToolFactory(customSubContrib)

        const mainTools = await createToolsFromProviders({
            cwd: '/repo',
            platform: 'darwin',
            services: createMockHostServices(),
            bridge,
            model: testModel,
            extensionRegistry: registry,
            targetAgent: 'main',
        })

        expect(mainTools.map((t) => t.name)).toContain('custom_main_only')
        expect(mainTools.map((t) => t.name)).not.toContain('custom_sub_only')

        const subTools = await createToolsFromProviders({
            cwd: '/repo',
            platform: 'darwin',
            services: createMockHostServices(),
            bridge,
            model: testModel,
            extensionRegistry: registry,
            targetAgent: 'subagent',
        })

        expect(subTools.map((t) => t.name)).not.toContain('custom_main_only')
        expect(subTools.map((t) => t.name)).toContain('custom_sub_only')
    })

    it('returns empty array when cwd is missing, relative, or not a directory', async () => {
        const bridge = new FakeNativeBridge()
        const services = createMockHostServices()

        expect(
            await createToolsFromProviders({
                cwd: undefined,
                platform: 'darwin',
                services,
                bridge,
                model: testModel,
            })
        ).toEqual([])

        expect(
            await createToolsFromProviders({
                cwd: '',
                platform: 'darwin',
                services,
                bridge,
                model: testModel,
            })
        ).toEqual([])

        expect(
            await createToolsFromProviders({
                cwd: 'relative/path',
                platform: 'darwin',
                services,
                bridge,
                model: testModel,
            })
        ).toEqual([])

        bridge.setFile('/file.txt', '')
        expect(
            await createToolsFromProviders({
                cwd: '/file.txt',
                platform: 'darwin',
                services,
                bridge,
                model: testModel,
            })
        ).toEqual([])
    })

    it('orders dynamic tools according to contribution order property', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setRuntimeInfo({ platform: 'darwin' })
        await bridge.mkdirAll('/repo')

        const registry = new RendererRegistry()
        activateEntry(toolsAgentEntry, registry)
        registry.registerToolFactory({
            id: 'z_tool_first',
            order: 5, // Should come before 'read' (order 10)
            targets: ['all'],
            riskLevel: 'read',
            requiresApproval: false,
            create: () => ({
                name: 'z_tool_first',
                label: 'z_tool_first',
                description: 'First tool',
                parameters: { type: 'object' },
                validate: (input) => input as any,
                execute: async () => ({ content: [{ type: 'text', text: 'first' }] }),
            }),
        })

        registry.registerToolFactory({
            id: 'a_tool_last',
            order: 100, // Should come after 'write' (order 40)
            targets: ['all'],
            riskLevel: 'write',
            requiresApproval: true,
            approvalCategory: 'custom-mutation',
            create: () => ({
                name: 'a_tool_last',
                label: 'a_tool_last',
                description: 'Last tool',
                parameters: { type: 'object' },
                validate: (input) => input as any,
                execute: async () => ({ content: [{ type: 'text', text: 'last' }] }),
            }),
        })

        const tools = await createToolsFromProviders({
            cwd: '/repo',
            platform: 'darwin',
            services: createMockHostServices(),
            bridge,
            model: testModel,
            extensionRegistry: registry,
        })

        expect(tools.map((t) => t.name)).toEqual([
            'z_tool_first',
            'read',
            'bash',
            'edit',
            'write',
            'a_tool_last',
        ])
        expect(selectApprovalPolicy(tools.find((t) => t.name === 'a_tool_last')!)).toEqual({
            riskLevel: 'write',
            requiresApproval: true,
            approvalCategory: 'custom-mutation',
        })
    })

    it('finds tools by name or alias', () => {
        const dummyTool = (name: string): AgentTool => ({
            name,
            label: name,
            description: name,
            parameters: {},
            validate: (x) => x as any,
            execute: async () => ({ content: [] }),
        })

        const tools: AgentTool[] = [
            dummyTool('read'),
            dummyTool('pwsh'),
            dummyTool('edit'),
            dummyTool('write'),
            dummyTool('send_message'),
            dummyTool('memories_search'),
        ]

        expect(findToolByNameOrAlias(tools, 'read')?.name).toBe('read')
        expect(findToolByNameOrAlias(tools, 'pwsh')?.name).toBe('pwsh')
        expect(findToolByNameOrAlias(tools, 'powershell')?.name).toBe('pwsh')
        expect(findToolByNameOrAlias(tools, 'send_input')?.name).toBe('send_message')
        expect(findToolByNameOrAlias(tools, 'memory_search')?.name).toBe('memories_search')
        expect(findToolByNameOrAlias(tools, 'unknown_tool')).toBeUndefined()

        // Verify static methods on class
        expect(ToolFactoryProvider.findToolByNameOrAlias(tools, 'pwsh')?.name).toBe('pwsh')
        expect(ToolFactoryProvider.selectApprovalPolicy('bash').requiresApproval).toBe(true)
        expect(ToolFactoryProvider.isMutatingToolName('bash')).toBe(true)
    })

    it('tells the model when a previously provided plugin tool was disabled by the user', async () => {
        const bridge = new FakeNativeBridge()
        await bridge.mkdirAll('/repo')
        const registry = new RendererRegistry()
        const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'executed' }] }))
        const transaction = registry.kernelRegistry.beginActivation({
            id: 'codex-computer-use',
            version: '1.0.0',
        })
        transaction.register('tool-factory', 'computer_use', {
            id: 'computer_use',
            name: 'computer_use',
            description: 'Computer use',
            parameters: { type: 'object', properties: {} },
            create: () => ({
                name: 'computer_use',
                label: 'Computer use',
                description: 'Computer use',
                parameters: { type: 'object', properties: {} },
                validate: (value: unknown) => value as Record<string, unknown>,
                execute,
            }),
        } satisfies ToolFactoryContribution)
        const disposers = transaction.commit()

        const tools = await createToolsFromProviders({
            cwd: '/repo',
            bridge,
            platform: 'darwin',
            services: createMockHostServices(),
            extensionRegistry: registry,
        })
        const tool = tools.find((item) => item.name === 'computer_use')!
        const context = { sessionId: 'existing-session' }
        expect((await tool.execute('call-1', {}, context)).isError).toBeFalsy()
        expect(execute).toHaveBeenCalledTimes(1)

        for (const dispose of disposers) dispose()

        const result = await tool.execute('call-2', {}, context)
        expect(result).toMatchObject({
            isError: true,
            content: [{ type: 'text', text: expect.stringMatching(/codex-computer-use.*disabled or uninstalled by the user/) }],
        })
        expect(execute).toHaveBeenCalledTimes(1)

        const replacement = registry.kernelRegistry.beginActivation({
            id: 'codex-computer-use',
            version: '1.0.0',
        })
        replacement.register('tool-factory', 'computer_use', {
            id: 'computer_use',
            create: () => ({
                name: 'computer_use',
                label: 'Computer use',
                description: 'New version',
                parameters: {},
                validate: () => ({}),
                execute: async () => ({ content: [] }),
            }),
        } satisfies ToolFactoryContribution)
        replacement.commit()

        expect((await tool.execute('call-3', {}, context)).isError).toBe(true)
        expect(execute).toHaveBeenCalledTimes(1)
    })

    it('does not execute a legacy factory tool if the plugin is disabled while create is pending', async () => {
        const registry = new RendererRegistry()
        let resolveCreate!: (tool: AgentTool) => void
        const create = vi.fn(() => new Promise<AgentTool>((resolve) => { resolveCreate = resolve }))
        const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'executed' }] }))
        const transaction = registry.kernelRegistry.beginActivation({ id: 'test.plugin', version: '1.0.0' })
        transaction.register('tool-factory', 'legacy-tool', {
            id: 'legacy-tool',
            name: 'legacy-tool',
            description: 'Legacy tool',
            parameters: {},
            create,
        } satisfies ToolFactoryContribution)
        const disposers = transaction.commit()
        const legacyTool = registry.getAgentTools().find((tool) => tool.name === 'legacy-tool')!

        const pending = legacyTool.execute({}, {})
        expect(create).toHaveBeenCalledTimes(1)
        for (const dispose of disposers) dispose()
        resolveCreate({
            name: 'legacy-tool',
            label: 'Legacy tool',
            description: 'Legacy tool',
            parameters: {},
            validate: () => ({}),
            execute,
        })

        expect(await pending).toMatchObject({ isError: true })
        expect(execute).not.toHaveBeenCalled()
    })

    it('does not inject requiresScheduledSession tools into non-scheduled sessions', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setRuntimeInfo({ platform: 'darwin' })
        await bridge.mkdirAll('/repo')

        const registry = new RendererRegistry()
        activateEntry(toolsAgentEntry, registry)

        const scheduledOnlyFactory: ToolFactoryContribution = {
            id: 'scheduled_only_tool',
            order: 99,
            targets: ['all'],
            requiresScheduledSession: true,
            riskLevel: 'read',
            requiresApproval: false,
            create: () => ({
                name: 'scheduled_only_tool',
                label: 'scheduled_only_tool',
                description: 'Only for scheduled sessions',
                parameters: { type: 'object' },
                validate: (input) => input as any,
                execute: async () => ({ content: [{ type: 'text', text: 'scheduled' }] }),
            }),
        }
        registry.registerToolFactory(scheduledOnlyFactory)

        // 1. Non-scheduled session context without scheduleId
        const nonScheduledTools = await createToolsFromProviders({
            cwd: '/repo',
            platform: 'darwin',
            services: createMockHostServices(),
            bridge,
            model: testModel,
            extensionRegistry: registry,
            sessionId: 'sess_normal',
            scheduleId: null,
        })
        expect(nonScheduledTools.map((t) => t.name)).not.toContain('scheduled_only_tool')

        // 2. Scheduled session with explicit scheduleId
        const scheduledTools = await createToolsFromProviders({
            cwd: '/repo',
            platform: 'darwin',
            services: createMockHostServices(),
            bridge,
            model: testModel,
            extensionRegistry: registry,
            sessionId: 'sess_sched',
            scheduleId: 'sched_daily_job',
        })
        expect(scheduledTools.map((t) => t.name)).toContain('scheduled_only_tool')

        // 3. Scheduled session resolved via services session snapshot
        const mockServicesWithScheduledSession = createMockHostServices()
        mockServicesWithScheduledSession.sessions = {
            ...mockServicesWithScheduledSession.sessions,
            getSnapshot: () => [
                {
                    id: 'sess_from_snapshot',
                    title: 'Snapshot Sched Session',
                    pinned: false,
                    createdAt: 0,
                    updatedAt: 0,
                    scheduleId: 'sched_snapshot_job',
                } as any,
            ],
        } as any

        const snapshotScheduledTools = await createToolsFromProviders({
            cwd: '/repo',
            platform: 'darwin',
            services: mockServicesWithScheduledSession,
            bridge,
            model: testModel,
            extensionRegistry: registry,
            sessionId: 'sess_from_snapshot',
        })
        expect(snapshotScheduledTools.map((t) => t.name)).toContain('scheduled_only_tool')
    })

})
