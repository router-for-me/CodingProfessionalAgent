import { describe, expect, it, vi } from 'vitest'
import type { AgentTool, PluginCapabilityClient, PluginManifest, ToolFactoryContribution } from '@cpa/plugin-api'
import { scopeToolModelInvocation } from './scopeToolModelInvocation.js'

const manifest = (capabilities: string[]): PluginManifest => ({ id: 'test.tool', name: 'Test', version: '1.0.0', apiVersion: '1.0.0', engines: { cpa: '>=1.0.0' }, capabilities })
const tool = (execute: AgentTool['execute']): AgentTool => ({ name: 'test', label: 'Test', description: 'Test', parameters: {}, validate: () => ({}), execute })
const client = (has: PluginCapabilityClient['has']): PluginCapabilityClient => ({ has, invoke: vi.fn(), subscribe: () => () => {} })

describe('tool model invocation capability scope', () => {
    it.each([
        [[], true],
        [['models.invoke'], false],
    ] as const)('strips invocation unless both declared and granted', async (capabilities, granted) => {
        const execute = vi.fn().mockResolvedValue({ content: [] })
        const scoped = scopeToolModelInvocation<ToolFactoryContribution>({ kind: 'tool-factory', id: 'test', value: { id: 'test', create: () => tool(execute) } }, manifest([...capabilities]), client(() => granted))
        const created = await scoped.create({ platform: 'darwin', services: {} as never })
        const invoke = vi.fn()
        await created!.execute('call-A', {}, { modelInvoker: { invoke }, cwd: '/project' })
        expect(execute.mock.calls[0][2]).toEqual({ cwd: '/project' })
        expect(invoke).not.toHaveBeenCalled()
    })
    it('scopes async factories and rechecks grant before a retained facade is used', async () => {
        let allowed = true
        const execute = vi.fn().mockResolvedValue({ content: [] })
        const scoped = scopeToolModelInvocation<ToolFactoryContribution>({ kind: 'tool-factory', id: 'test', value: { id: 'test', create: async () => tool(execute) } }, manifest(['models.*']), client(() => allowed))
        const created = await scoped.create({ platform: 'darwin', services: {} as never })
        const invoke = vi.fn().mockResolvedValue({})
        await created!.execute('call-A', {}, { modelInvoker: { invoke } })
        const facade = execute.mock.calls[0][2].modelInvoker
        const request = { model: { id: 'model-B' }, query: 'query', instructions: 'instructions' }
        await facade.invoke(request)
        expect(invoke).toHaveBeenCalledWith(request)
        allowed = false
        expect(() => facade.invoke(request)).toThrow('models.invoke')
        expect(invoke).toHaveBeenCalledTimes(1)
    })
    it('also scopes legacy callable contributions', async () => {
        const execute = vi.fn().mockResolvedValue({ content: [] })
        const scoped = scopeToolModelInvocation({ kind: 'tool-factory', id: 'legacy', value: { execute } }, manifest([]), client(() => true))
        await scoped.execute({}, { modelInvoker: { invoke: vi.fn() } })
        expect(execute.mock.calls[0][1]).toEqual({})
    })
    it('leaves other contributions and disabled factories unchanged', async () => {
        const registration = { kind: 'service' as const, id: 'service', value: { arbitrary: true } }
        expect(scopeToolModelInvocation(registration, manifest([]), client(() => false))).toBe(registration.value)
        const scoped = scopeToolModelInvocation<ToolFactoryContribution>({ kind: 'tool-factory', id: 'test', value: { id: 'test', create: () => null } }, manifest([]), client(() => false))
        expect(await scoped.create({ platform: 'darwin', services: {} as never })).toBeNull()
    })
})
