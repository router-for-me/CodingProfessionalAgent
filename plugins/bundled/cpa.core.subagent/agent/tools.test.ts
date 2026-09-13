import { describe, expect, it, vi } from 'vitest'
import {
    createSendMessageTool,
    createSpawnAgentTool,
    createStopAgentTool,
    createSubAgentTools,
    type SubAgentExecutionCoordinator,
} from './tools.js'

describe('sub-agent tools', () => {
    const createMockCoordinator = (): SubAgentExecutionCoordinator => ({
        spawn: vi.fn(async () => ({ content: [{ type: 'text', text: 'spawned' }] })),
        sendMessage: vi.fn(async () => ({ content: [{ type: 'text', text: 'sent' }] })),
        stop: vi.fn(() => ({ content: [{ type: 'text', text: 'stopped' }] })),
    })

    it('validates spawn/send/stop arguments', () => {
        const coordinator = createMockCoordinator()
        const [spawn, send, stop] = createSubAgentTools(coordinator)
        expect(spawn?.validate({ prompt: 'do work', name: 'Atlas', model: 'flash' })).toEqual({
            prompt: 'do work',
            name: 'Atlas',
            model: 'flash',
        })
        expect(spawn?.validate({ prompt: 'review', name: 'Grok', model: 'grok-4.6:xhigh' })).toEqual({
            prompt: 'review',
            name: 'Grok',
            model: 'grok-4.6:xhigh',
            reasoning_effort: undefined,
            thinking: undefined,
        })
        expect(spawn?.validate({ prompt: 'review', name: 'Grok', model: 'grok-4.6', thinking: 'xhigh' })).toEqual({
            prompt: 'review',
            name: 'Grok',
            model: 'grok-4.6',
            reasoning_effort: undefined,
            thinking: 'xhigh',
        })
        expect(() => spawn?.validate({ prompt: '   ', name: 'Atlas', model: 'flash' })).toThrow(/prompt/)
        expect(() => spawn?.validate({ prompt: 'do work', model: 'flash' })).toThrow(/name/)
        expect(() => spawn?.validate({ prompt: 'do work', name: 'Atlas' })).toThrow(/model/)
        expect(send?.validate({ agent_id: 'a1', message: 'hi' })).toEqual({
            agent_id: 'a1',
            message: 'hi',
        })
        expect(() => send?.validate({ agent_id: 'a1' })).toThrow(/message/)
        expect(stop?.validate({ agent_id: 'a1' })).toEqual({ agent_id: 'a1' })
        expect(() => stop?.validate({})).toThrow(/agent_id/)
    })

    it('exposes tools in spawn / send / stop order', () => {
        const coordinator = createMockCoordinator()
        const tools = createSubAgentTools(coordinator)
        expect(tools.map((tool) => tool.name)).toEqual([
            'spawn_agent',
            'send_message',
            'stop_agent',
        ])
        expect(tools[0]?.parameters).toMatchObject({
            required: ['prompt', 'name'],
        })
        expect(tools[0]?.description).not.toContain('cannot spawn their own sub-agents')
    })

    it('executes spawn via coordinator forwarding options and context', async () => {
        const coordinator = createMockCoordinator()
        const spawnTool = createSpawnAgentTool(coordinator)
        const abortController = new AbortController()
        const onUpdate = vi.fn()

        const result = await spawnTool.execute(
            'call-1',
            {
                prompt: 'test prompt',
                name: 'Worker',
                model: 'gpt-4o',
                reasoning_effort: 'high',
            },
            {
                sessionId: 'session-parent-1',
                signal: abortController.signal,
                onUpdate,
            },
        )

        expect(result.content[0]).toEqual({ type: 'text', text: 'spawned' })
        expect(coordinator.spawn).toHaveBeenCalledWith('test prompt', {
            name: 'Worker',
            toolCallId: 'call-1',
            parentSessionId: 'session-parent-1',
            modelId: 'gpt-4o',
            reasoningEffort: 'high',
            signal: abortController.signal,
            onUpdate,
        })
    })

    it('validates and forwards role parameter to coordinator', async () => {
        const coordinator = createMockCoordinator()
        const spawnTool = createSpawnAgentTool(coordinator)

        const validated = spawnTool.validate({
            prompt: 'review changes',
            name: 'Reviewer',
            model: 'claude-sonnet-5',
            role: '代码审查员',
        })
        expect(validated.role).toBe('代码审查员')

        await spawnTool.execute('call-2', validated, { sessionId: 'session-parent-2' })
        expect(coordinator.spawn).toHaveBeenCalledWith('review changes', expect.objectContaining({
            name: 'Reviewer',
            role: '代码审查员',
            modelId: 'claude-sonnet-5',
            parentSessionId: 'session-parent-2',
        }))
    })

    it('allows omitting model when role is specified, but rejects when both are missing', () => {
        const coordinator = createMockCoordinator()
        const spawnTool = createSpawnAgentTool(coordinator)

        const validated = spawnTool.validate({
            prompt: 'review changes',
            name: 'Reviewer',
            role: '代码审查员',
        })
        expect(validated.role).toBe('代码审查员')
        expect(validated.model).toBeUndefined()

        expect(() =>
            spawnTool.validate({
                prompt: 'review changes',
                name: 'Reviewer',
            }),
        ).toThrow('model is required when role is not specified')
    })

    it('executes sendMessage and stopAgent via coordinator', async () => {
        const coordinator = createMockCoordinator()
        const sendTool = createSendMessageTool(coordinator)
        const stopTool = createStopAgentTool(coordinator)
        const abortController = new AbortController()

        const sendRes = await sendTool.execute(
            'call-send',
            { agent_id: 'agent-1', message: 'hello' },
            { signal: abortController.signal },
        )
        expect(sendRes.content[0]).toEqual({ type: 'text', text: 'sent' })
        expect(coordinator.sendMessage).toHaveBeenCalledWith('agent-1', 'hello', abortController.signal)

        const stopRes = await stopTool.execute(
            'call-stop',
            { agent_id: 'agent-1' },
            {},
        )
        expect(stopRes.content[0]).toEqual({ type: 'text', text: 'stopped' })
        expect(coordinator.stop).toHaveBeenCalledWith('agent-1')
    })
})
