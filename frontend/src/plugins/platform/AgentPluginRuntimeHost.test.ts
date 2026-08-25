import { describe, expect, it } from 'vitest'
import { AgentPluginRuntimeHost } from './AgentPluginRuntimeHost'
import {
    type CapabilityHandle,
    type HookContribution,
    type ResourceProvider,
    type ToolFactoryContribution,
    PluginCapabilityError,
} from '@cpa/plugin-api'
import { loadResourcesFromProviders } from '@/features/agent-runtime/providers/ResourceProvider'
import { createToolsFromProviders } from '@/features/agent-runtime/providers/ToolFactoryProvider'
import { HookProvider } from '@/features/agent-runtime/providers/HookProvider'
import { RendererRegistry } from './rendererRegistry'

describe('AgentPluginRuntimeHost lifecycle, capabilities, and SPI integration', () => {
    it('activates plugins with scoped capability client and registers contributions in ContributionRegistry', async () => {
        const host = new AgentPluginRuntimeHost()
        const handle = 'granted-handle-gen1' as CapabilityHandle
        host.setPluginHandle('cpa.core.tools', handle, 1)
        host.setPluginHandle('cpa.core.resources', handle, 1)

        const calls: Array<{ method: string; args: unknown[] }> = []
        host.setCapabilityTransport(async (_h, method, args) => {
            calls.push({ method, args })
            if (method === 'native:stat') {
                return { isDir: true, isFile: false, sizeBytes: 0 }
            }
            if (method === 'native:readDir') {
                return []
            }
            return undefined
        })

        await host.activateAll()
        expect(host.isPluginActive('cpa.core.tools')).toBe(true)
        expect(host.isPluginActive('cpa.core.resources')).toBe(true)

        // Verify contributions registered in host registry
        const toolFactories = host.contributionRegistry.list<ToolFactoryContribution>('tool-factory')
        expect(toolFactories.length).toBeGreaterThan(0)
        expect(toolFactories.some((tf) => tf.id === 'read')).toBe(true)
        expect(toolFactories.some((tf) => tf.id === 'shell')).toBe(true)
        expect(toolFactories.some((tf) => tf.id === 'edit')).toBe(true)
        expect(toolFactories.some((tf) => tf.id === 'write')).toBe(true)

        const resourceProviders = host.contributionRegistry.list<ResourceProvider>('resource-provider')
        expect(resourceProviders.some((rp) => rp.id === 'cpa.core.context')).toBe(true)
        expect(resourceProviders.some((rp) => rp.id === 'cpa.core.skills')).toBe(true)
        expect(resourceProviders.some((rp) => rp.id === 'cpa.core.prompt-templates')).toBe(true)
    })

    it('denies capability access when no handle is granted', async () => {
        const host = new AgentPluginRuntimeHost()
        // Do NOT grant capability handle
        host.clearHandles()

        let transportCalled = false
        host.setCapabilityTransport(async () => {
            transportCalled = true
            return undefined
        })

        await host.activateAll()

        const readFactory = host.contributionRegistry.get<ToolFactoryContribution>('tool-factory', 'read')
        expect(readFactory).toBeDefined()

        const readTool = await readFactory?.create({ cwd: '/test', platform: 'darwin', services: {} as any })
        expect(readTool).toBeDefined()

        // Executing tool via ungranted capability client throws PluginCapabilityError
        await expect(
            readTool?.execute('call_1', { path: 'file.txt' }, {}),
        ).rejects.toThrow(PluginCapabilityError)
        expect(transportCalled).toBe(false)
    })

    it('handles generation replacement: activates new generation and deactivates old', async () => {
        const host = new AgentPluginRuntimeHost()
        const handleGen1 = 'handle-gen1' as CapabilityHandle
        const handleGen2 = 'handle-gen2' as CapabilityHandle

        host.setPluginHandle('cpa.core.tools', handleGen1, 1)
        host.setPluginHandle('cpa.core.resources', handleGen1, 1)
        await host.activateAll()
        expect(host.getGeneration()).toBe(1)

        // Prepare generation 2
        host.setPluginHandle('cpa.core.tools', handleGen2, 2)
        host.setPluginHandle('cpa.core.resources', handleGen2, 2)

        const prepared = await host.prepareGeneration(undefined, 2)
        expect(prepared.generation).toBe(2)

        await prepared.commit()
        expect(host.getGeneration()).toBe(2)
        expect(host.isPluginActive('cpa.core.tools')).toBe(true)
    })

    it('protects active generation during lease and releases properly', async () => {
        const host = new AgentPluginRuntimeHost()
        const handle = 'lease-handle' as CapabilityHandle
        host.setPluginHandle('cpa.core.tools', handle, 1)
        await host.activateAll()

        const lease = host.acquireGeneration(['cpa.core.tools'])
        expect(lease.generation).toBe(1)
        expect(lease.released).toBe(false)

        lease.release()
        expect(lease.released).toBe(true)
    })

    it('loads resources and tools through AgentPluginRuntimeHost contribution registry', async () => {
        const host = new AgentPluginRuntimeHost()
        const handle = 'test-handle' as CapabilityHandle
        host.setPluginHandle('cpa.core.tools', handle, 1)
        host.setPluginHandle('cpa.core.resources', handle, 1)

        const files = new Map<string, string>([
            ['/project/AGENTS.md', 'Project Instructions'],
            ['/project/skills/my-skill/SKILL.md', '---\nname: my-skill\ndescription: "A test skill"\n---\nSkill content'],
        ])

        host.setCapabilityTransport(async (_h, method, args) => {
            if (method === 'native:stat') {
                const target = args[0] as string
                if (target === '/project' || target === '/project/skills' || target === '/project/skills/my-skill') {
                    return { isDir: true, isFile: false, sizeBytes: 0 }
                }
                if (files.has(target)) {
                    return { isDir: false, isFile: true, sizeBytes: files.get(target)!.length }
                }
                throw new Error(`Path not found: ${target}`)
            }
            if (method === 'native:readDir') {
                const target = args[0] as string
                if (target === '/project/skills') {
                    return [{ name: 'my-skill', isDir: true, isFile: false }]
                }
                if (target === '/project/skills/my-skill') {
                    return [{ name: 'SKILL.md', isDir: false, isFile: true }]
                }
                return []
            }
            if (method === 'native:readFile') {
                const target = args[0] as string
                const content = files.get(target)
                if (content !== undefined) {
                    return { dataBase64: Buffer.from(content).toString('base64') }
                }
                throw new Error(`File not found: ${target}`)
            }
            if (method === 'native:realPath') {
                return args[0] as string
            }
            if (method === 'native:runtimeInfo') {
                return { platform: 'darwin', homeDir: '/home/user', userConfigDir: '/cfg', tempDir: '/tmp' }
            }
            return undefined
        })

        await host.activateAll()

        const bridge = {
            stat: async (p: string) => ({ isDir: p === '/project', isFile: p !== '/project', sizeBytes: 0 }),
            readFile: async (p: string) => Buffer.from(files.get(p) ?? ''),
            readDir: async () => [],
            runtimeInfo: async () => ({ platform: 'darwin', homeDir: '/home/user', userConfigDir: '/cfg', tempDir: '/tmp' }),
        } as any

        // Wrap host registry into RendererRegistry for adapter compatibility
        const registry = new RendererRegistry(host.contributionRegistry)

        const tools = await createToolsFromProviders({
            cwd: '/project',
            bridge,
            extensionRegistry: registry,
        })
        expect(tools.map((t) => t.name)).toContain('read')
        expect(tools.map((t) => t.name)).toContain('bash')
        expect(tools.map((t) => t.name)).toContain('edit')
        expect(tools.map((t) => t.name)).toContain('write')

        const snapshot = await loadResourcesFromProviders({
            cwd: '/project',
            agentDir: '/cfg/coding-professional-agent/agent',
            bridge,
            extensionRegistry: registry,
            tools: [{ name: 'read', description: 'read files' }],
        })

        expect(snapshot.systemPrompt).toContain('Current working directory: /project')
        expect(snapshot.systemPrompt).toContain('Coding Professional Agent')
    })

    it('activates cpa.core.hooks and registers all 11 hook contributions in AgentPluginRuntimeHost', async () => {
        const host = new AgentPluginRuntimeHost()
        const handle = 'granted-handle-gen1' as CapabilityHandle
        host.setPluginHandle('cpa.core.hooks', handle, 1)

        await host.activateAll()
        expect(host.isPluginActive('cpa.core.hooks')).toBe(true)

        const hookContributions = host.contributionRegistry.list<HookContribution>('hook').map((item) => item.value)
        expect(hookContributions).toHaveLength(11)

        const events = hookContributions.map((h) => h.event).sort()
        expect(events).toEqual([
            'PermissionRequest',
            'PostCompact',
            'PostToolUse',
            'PreCompact',
            'PreToolUse',
            'SessionEnd',
            'SessionStart',
            'Stop',
            'SubagentStart',
            'SubagentStop',
            'UserPromptSubmit',
        ].sort())
    })

    it('dispatches all 11 lifecycle hook points via HookProvider snapshot from AgentPluginRuntimeHost', async () => {
        const host = new AgentPluginRuntimeHost()
        const handle = 'granted-handle-gen1' as CapabilityHandle
        host.setPluginHandle('cpa.core.hooks', handle, 1)

        host.setCapabilityTransport(async (_h, method) => {
            if (method === 'native:stat') {
                return { isDir: false, isFile: false, sizeBytes: 0 }
            }
            if (method === 'native:runtimeInfo') {
                return { platform: 'darwin', userConfigDir: '', tempDir: '/tmp', homeDir: '/home' }
            }
            return undefined
        })

        await host.activateAll()
        const hooks = host.contributionRegistry.list<HookContribution>('hook').map((item) => item.value)

        // 1. SessionStart
        const res1 = await HookProvider.execute('SessionStart', {
            event: 'SessionStart',
            sessionId: 'sess-1',
            payload: { hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: '/test', model: 'gpt-4o', permission_mode: 'default', source: 'startup' },
        }, { hooks })
        expect(res1.continue).toBe(true)

        // 2. UserPromptSubmit
        const res2 = await HookProvider.execute('UserPromptSubmit', {
            event: 'UserPromptSubmit',
            sessionId: 'sess-1',
            payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: '/test', model: 'gpt-4o', permission_mode: 'default', prompt: 'test' },
        }, { hooks })
        expect(res2.continue).toBe(true)

        // 3. PreToolUse
        const res3 = await HookProvider.execute('PreToolUse', {
            event: 'PreToolUse',
            sessionId: 'sess-1',
            payload: { hook_event_name: 'PreToolUse', session_id: 'sess-1', cwd: '/test', model: 'gpt-4o', permission_mode: 'default', tool_name: 'read', tool_input: { path: 'a.txt' }, tool_use_id: 'c-1' },
        }, { hooks })
        expect(res3.continue).toBe(true)

        // 4. PermissionRequest
        const res4 = await HookProvider.execute('PermissionRequest', {
            event: 'PermissionRequest',
            sessionId: 'sess-1',
            payload: { hook_event_name: 'PermissionRequest', session_id: 'sess-1', cwd: '/test', model: 'gpt-4o', permission_mode: 'default', tool_name: 'bash', tool_input: { command: 'ls' }, tool_use_id: 'c-2' },
        }, { hooks })
        expect(res4.continue).toBe(true)

        // 5. PostToolUse
        const res5 = await HookProvider.execute('PostToolUse', {
            event: 'PostToolUse',
            sessionId: 'sess-1',
            payload: { hook_event_name: 'PostToolUse', session_id: 'sess-1', cwd: '/test', model: 'gpt-4o', permission_mode: 'default', tool_name: 'read', tool_input: { path: 'a.txt' }, tool_output: 'ok', tool_use_id: 'c-3' },
        }, { hooks })
        expect(res5.continue).toBe(true)

        // 6. PreCompact
        const res6 = await HookProvider.execute('PreCompact', {
            event: 'PreCompact',
            sessionId: 'sess-1',
            payload: { hook_event_name: 'PreCompact', session_id: 'sess-1', trigger: 'manual', cwd: '/test' },
        }, { hooks })
        expect(res6.continue).toBe(true)

        // 7. PostCompact
        const res7 = await HookProvider.execute('PostCompact', {
            event: 'PostCompact',
            sessionId: 'sess-1',
            payload: { hook_event_name: 'PostCompact', session_id: 'sess-1', trigger: 'manual', cwd: '/test' },
        }, { hooks })
        expect(res7.continue).toBe(true)

        // 8. SubagentStart
        const res8 = await HookProvider.execute('SubagentStart', {
            event: 'SubagentStart',
            sessionId: 'sess-1',
            payload: { hook_event_name: 'SubagentStart', session_id: 'sess-1', cwd: '/test', subagent_id: 'sub-1', name: 'child', task: 'task' },
        }, { hooks })
        expect(res8.continue).toBe(true)

        // 9. SubagentStop
        const res9 = await HookProvider.execute('SubagentStop', {
            event: 'SubagentStop',
            sessionId: 'sess-1',
            payload: { hook_event_name: 'SubagentStop', session_id: 'sess-1', cwd: '/test', subagent_id: 'sub-1', name: 'child', outcome: 'success' },
        }, { hooks })
        expect(res9.continue).toBe(true)

        // 10. Stop
        const res10 = await HookProvider.execute('Stop', {
            event: 'Stop',
            sessionId: 'sess-1',
            payload: { hook_event_name: 'Stop', session_id: 'sess-1', cwd: '/test', reason: 'cancelled' },
        }, { hooks })
        expect(res10.continue).toBe(true)

        // 11. SessionEnd
        const res11 = await HookProvider.execute('SessionEnd', {
            event: 'SessionEnd',
            sessionId: 'sess-1',
            payload: { hook_event_name: 'SessionEnd', session_id: 'sess-1', cwd: '/test', reason: 'closed' },
        }, { hooks })
        expect(res11.continue).toBe(true)
    })
})
