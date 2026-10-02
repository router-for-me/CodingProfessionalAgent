import { describe, expect, it, vi } from 'vitest'
import type { AgentTool, AppSettings, PluginCapabilityClient, SettingsService } from '@cpa/plugin-api'
import { CellClient } from './client'
import { createExecTool } from './execTool'
import { createWaitTool } from './waitTool'
import { CELL_RPC } from '../shared/messages'

const ordinary = (name: string, exposure?: AgentTool['exposure']): AgentTool => ({ name, label: name, description: `${name} description`, parameters: { type: 'object', properties: { path: { type: 'string' } } }, exposure, validate: (value) => value as any, execute: async () => ({ content: [] }) })
function setup(mode: AppSettings['toolMode'] = 'code', unavailable = false) {
    const snapshot = { toolMode: mode, directOnlyToolNames: ['standalone'] } as AppSettings
    const settings = { get: async () => snapshot, getSnapshot: () => snapshot } as SettingsService
    let listener: (value: any) => void = () => {}
    const capability: PluginCapabilityClient = {
        has: () => true,
        subscribe: (_event, callback) => { listener = callback; return vi.fn() },
        invoke: vi.fn(async (_method, args) => {
            const command = args![0] as any
            if (command.type === 'prepare') { if (unavailable) throw new Error('offline'); return undefined }
            if (command.type === 'observe') return { cellId: command.input.cellId, status: command.input.terminate ? 'terminated' : 'missing', content: [] }
            if (command.type === 'start') {
                listener({ requestId: command.requestId, event: { type: 'tool-request', request: { cellId: 'cell', invocationId: 'nested', toolName: 'read', input: { path: 'a' } } } })
                return { cellId: 'cell', status: 'completed', content: [{ type: 'text', text: 'done' }] }
            }
        }) as PluginCapabilityClient['invoke'],
    }
    const client = new CellClient(capability)
    const exec = createExecTool(client, settings, snapshot)
    const wait = createWaitTool(client, settings, snapshot)
    const tools = [ordinary('read'), ordinary('standalone'), ordinary('sensitive', 'direct'), exec, wait]
    return { settings, snapshot, client, exec, wait, tools, capability }
}
const preparationContext = () => ({ sessionId: 'session', signal: new AbortController().signal })

describe('Code Mode tools and exposure policy', () => {
    it('keeps direct tool definitions unchanged and registers no orchestration exposure', async () => {
        const { exec, tools, client } = setup('direct')
        const result = await exec.prepareToolSet!(tools, preparationContext())
        expect(result.tools).toEqual(tools.slice(0, 3))
        expect(result.nestedTools).toEqual([])
        client.dispose()
    })
    it('code includes ordinary tools plus execution tools', async () => {
        const { exec, tools, client } = setup('code')
        const result = await exec.prepareToolSet!(tools, preparationContext())
        expect(result.tools.map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name))
        expect(result.nestedTools.map((tool) => tool.name)).toEqual(['read'])
        const prepared = result.tools.find((tool) => tool.name === 'exec')
        const description = (prepared?.parameters as { properties: { description: { description: string } } }).properties.description.description
        expect(description).toContain('Simplified Chinese (zh-CN)')
        expect(prepared?.description).toContain('Simplified Chinese (zh-CN)')
        client.dispose()
    })
    it('code-only includes declarations and retains explicit direct-only tools', async () => {
        const { exec, tools, client } = setup('code-only')
        const result = await exec.prepareToolSet!(tools.map((tool) => Object.freeze({ ...tool })), preparationContext())
        expect(exec.toolPolicyId).toBe('code-only')
        expect(result.policyId).toBe('code-only')
        expect(result.tools.find((tool) => tool.name === 'exec')?.description).toContain('tools.read')
        expect(result.tools.find((tool) => tool.name === 'wait')?.nestedToolNames).toEqual(['read'])
        expect(result.tools.map((tool) => tool.name)).toEqual(['standalone', 'sensitive', 'exec', 'wait'])
        expect(exec.description).toContain('tools.read')
        expect(exec.description).toContain('QuickJS-ng')
        expect(exec.nestedToolNames).toEqual(['read'])
        client.dispose()
    })
    it('fails closed without a nested dispatcher', async () => {
        const { exec, client } = setup()
        await expect(exec.execute('id', { source: 'text(2)' }, { sessionId: 's' })).rejects.toThrow('dispatchNestedTool')
        client.dispose()
    })
    it('sends only structured-cloneable tool specifications', async () => {
        const { exec, tools, client, capability } = setup()
        await exec.prepareToolSet!(tools, preparationContext())
        await exec.execute('id', { source: 'text(1)' }, { sessionId: 'session', dispatchNestedTool: vi.fn(async () => ({ content: [] })) })
        const start = vi.mocked(capability.invoke).mock.calls.map((call) => call[1]?.[0] as { type?: string; input?: { tools?: unknown } }).find((command) => command?.type === 'start')
        expect(start?.input?.tools).toEqual([{ name: 'read', identifier: 'read', description: 'read description' }])
        expect(() => structuredClone(start)).not.toThrow()
        client.dispose()
    })
    it('does not let another session preparation replace this session nested tools', async () => {
        const { exec, tools, client, capability } = setup()
        await exec.prepareToolSet!(tools, preparationContext())
        await exec.prepareToolSet!([ordinary('bash'), exec], { sessionId: 'child', signal: new AbortController().signal })
        await exec.execute('id', { source: 'text(1)', description: 'keep parent tools' }, { sessionId: 'session', dispatchNestedTool: vi.fn(async () => ({ content: [] })) })
        const start = vi.mocked(capability.invoke).mock.calls.map((call) => call[1]?.[0] as { type?: string; input?: { tools?: Array<{ name: string }> } }).find((command) => command?.type === 'start')
        expect(start?.input?.tools?.map((tool) => tool.name)).toEqual(['read'])
        client.dispose()
    })
    it('dispatches nested requests through the injected host callback', async () => {
        const { exec, tools, client, capability } = setup()
        await exec.prepareToolSet!(tools, preparationContext())
        const dispatch = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'read result' }] }))
        const result = await exec.execute('id', { source: 'await tools.read({path:"a"})' }, { sessionId: 'session', dispatchNestedTool: dispatch })
        expect(result.isError).toBe(false)
        expect(dispatch).toHaveBeenCalledWith({ cellId: 'cell', invocationId: 'nested', toolName: 'read', input: { path: 'a' } }, expect.any(AbortSignal))
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(capability.invoke).toHaveBeenCalledWith(CELL_RPC, [expect.objectContaining({ type: 'deliver', invocationId: 'nested' })])
        client.dispose()
    })
    it.each(['missing', 'terminated'])('wait reports %s as an explicit tool error', async (status) => {
        const { wait, client } = setup()
        const result = await wait.execute('id', { cell_id: 'old', terminate: status === 'terminated' }, { sessionId: 's', dispatchNestedTool: vi.fn() })
        expect(result.isError).toBe(true)
        expect(result.content).toContainEqual({ type: 'text', text: `Cell old ${status}.` })
        client.dispose()
    })
    it('code can fall back with a visible notice, code-only cannot', async () => {
        const code = setup('code', true)
        const fallback = await code.exec.prepareToolSet!(code.tools, preparationContext())
        expect(fallback.tools).toEqual(code.tools.slice(0, 3))
        expect(fallback.systemMessage).toContain('offline')
        const strict = setup('code-only', true)
        await expect(strict.exec.prepareToolSet!(strict.tools, preparationContext())).rejects.toThrow('fail closed')
        code.client.dispose(); strict.client.dispose()
    })
    it('validates exec and wait inputs', () => {
        const { exec, wait, client } = setup()
        expect(() => exec.validate({ source: '' })).toThrow()
        expect(() => exec.validate({ source: '2', extra: true })).toThrow()
        expect(() => exec.validate({ source: '2' })).toThrow('description')
        expect(exec.validate({ source: '2', description: '  读取两个文件  ' })).toEqual({ source: '2', description: '读取两个文件' })
        expect(() => wait.validate({ cell_id: 'id', yield_time_ms: -1 })).toThrow()
        expect(() => wait.validate({ cell_id: 'id', terminate: 'yes' })).toThrow()
        client.dispose()
    })
})
