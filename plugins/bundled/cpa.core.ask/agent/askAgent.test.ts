import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PluginEventBus } from '@cpa/plugin-kernel'
import { AgentPluginRuntimeHost } from '../../../../frontend/src/plugins/platform/AgentPluginRuntimeHost'
import { askAgentEntry, createAskTool, parseAskOptions } from './index.js'
import {
    defaultAskController,
    useAskStore,
    __resetAskStoreForTests,
} from '../shared/askStore.js'
import manifest from '../manifest.json'

describe('cpa.core.ask agent entry', () => {
    let runtimeHost: AgentPluginRuntimeHost
    let eventBus: PluginEventBus

    beforeEach(() => {
        __resetAskStoreForTests()
        eventBus = new PluginEventBus()
        runtimeHost = new AgentPluginRuntimeHost({ eventBus })
    })

    afterEach(() => {
        __resetAskStoreForTests()
        vi.useRealTimers()
    })

    it('normalizes exactly one recommended option using strict booleans', () => {
        expect(parseAskOptions([
            { title: 'A', recommended: 'true' },
            { title: 'B', recommended: true },
            { title: 'C', recommended: true },
        ])).toEqual([
            { title: 'A', description: undefined },
            { title: 'B', description: undefined, recommended: true },
            { title: 'C', description: undefined },
        ])
        expect(parseAskOptions(['A', 'B'])).toEqual([
            { title: 'A', recommended: true }, { title: 'B' },
        ])
    })

    it('sets a 180-second deadline and reports an automatic timeout decision', async () => {
        vi.useFakeTimers()
        const pending = createAskTool().execute('timeout', {
            question: 'Pick', options: ['A', { title: 'B', description: 'Better', recommended: true }],
        }, { sessionId: 'timeout-session' } as any)
        expect(useAskStore.getState().getRequest('timeout-session')?.countdownDeadline).toBe(Date.now() + 180_000)
        await vi.advanceTimersByTimeAsync(180_000)
        const result = await pending
        expect((result.content[0] as any).text).toBe('No response from the user within 180 seconds. The countdown expired, so the recommended option was automatically selected: B (Better). Note: this was an automatic timeout decision, not an explicit user choice.')
        expect(useAskStore.getState().getRequest('timeout-session')).toBeUndefined()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('does not start a countdown for freeform requests', async () => {
        vi.useFakeTimers()
        const pending = createAskTool().execute('freeform', { question: 'Explain' }, { sessionId: 'freeform' } as any)
        expect(useAskStore.getState().getRequest('freeform')?.countdownDeadline).toBeUndefined()
        expect(vi.getTimerCount()).toBe(0)
        defaultAskController.cancel('freeform', 'freeform')
        await pending
    })

    it.each(['same-call', 'different-call'])('keeps the newer request visible when replacing %s', async (replacement) => {
        vi.useFakeTimers()
        const tool = createAskTool()
        const first = tool.execute('first', { question: 'Old question', options: ['Old default'] }, { sessionId: 'replace-session' } as any)
        const firstRequest = useAskStore.getState().getRequest('replace-session')!
        const firstResolved = vi.fn()
        void first.then(firstResolved)
        await vi.advanceTimersByTimeAsync(60_000)
        const secondCallId = replacement === 'same-call' ? 'first' : 'second'
        const second = tool.execute(secondCallId, { question: 'New question', options: ['New default'] }, { sessionId: 'replace-session' } as any)
        const secondRequest = useAskStore.getState().getRequest('replace-session')!
        const secondResolved = vi.fn()
        void second.then(secondResolved)
        expect(secondRequest.id).not.toBe(firstRequest.id)
        await vi.advanceTimersByTimeAsync(0)
        expect(firstResolved).toHaveBeenCalledTimes(1)
        const firstResult = await first
        expect((firstResult.content[0] as any).text).toBe('User dismissed or cancelled this question.')
        expect(useAskStore.getState().getRequest('replace-session')).toBe(secondRequest)
        expect(secondRequest.countdownDeadline).toBe(Date.now() + 180_000)
        expect(vi.getTimerCount()).toBe(1)
        // Pass the old deadline while the new request still has a minute remaining.
        await vi.advanceTimersByTimeAsync(120_001)
        expect(Date.now()).toBeGreaterThan(firstRequest.countdownDeadline!)
        expect(firstResolved).toHaveBeenCalledTimes(1)
        expect(secondResolved).not.toHaveBeenCalled()
        expect(useAskStore.getState().getRequest('replace-session')).toBe(secondRequest)
        expect(secondRequest.countdownDeadline! - Date.now()).toBe(59_999)
        expect(vi.getTimerCount()).toBe(1)
        useAskStore.getState().cancelCountdown('replace-session', secondCallId)
        await vi.advanceTimersByTimeAsync(180_000)
        expect(secondResolved).not.toHaveBeenCalled()
        expect(useAskStore.getState().getRequest('replace-session')?.id).toBe(secondRequest.id)
        useAskStore.getState().submitAnswer('replace-session', secondCallId, { type: 'skipped' })
        const secondResult = await second
        expect((secondResult.content[0] as any).text).toBe('User skipped this question.')
        expect(useAskStore.getState().getRequest('replace-session')).toBeUndefined()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('keeps the newer request when an older execution aborts in finally', async () => {
        const abortController = new AbortController()
        const tool = createAskTool()
        const first = tool.execute('old', { question: 'Old' }, { sessionId: 'replace-abort', signal: abortController.signal } as any)
        const rejected = expect(first).rejects.toThrow('Tool execution aborted')
        abortController.abort()
        const second = tool.execute('new', { question: 'New' }, { sessionId: 'replace-abort' } as any)
        const secondRequest = useAskStore.getState().getRequest('replace-abort')
        await rejected
        expect(useAskStore.getState().getRequest('replace-abort')).toBe(secondRequest)
        useAskStore.getState().submitAnswer('replace-abort', 'new', { type: 'skipped' })
        await second
    })

    it('has valid manifest metadata', () => {
        expect(manifest.id).toBe('cpa.core.ask')
        expect(manifest.name).toBe('Ask User Tool')
        expect(manifest.apiVersion).toBe('1.0.0')
        expect(manifest.entries.agent).toBe('./agent/index.ts')
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.capabilities).toContain('ui.overlay')
        expect(manifest.contributes['tool-factory']).toContain('ask')
    })

    it('parses various options shapes correctly', () => {
        const strings = parseAskOptions(['Option 1', 'Option 2'])
        expect(strings).toEqual([
            { title: 'Option 1', recommended: true },
            { title: 'Option 2' },
        ])

        const objects = parseAskOptions([
            { title: 'A', description: 'Desc A' },
            { label: 'B', desc: 'Desc B' },
            { text: 'C' },
            { value: 'D' },
        ])
        expect(objects).toEqual([
            { title: 'A', description: 'Desc A', recommended: true },
            { title: 'B', description: 'Desc B' },
            { title: 'C', description: undefined },
            { title: 'D', description: undefined },
        ])

        expect(parseAskOptions(null)).toEqual([])
        expect(parseAskOptions(undefined)).toEqual([])
        expect(parseAskOptions('not an array')).toEqual([])
    })

    it('activates and registers ask tool-factory contribution', async () => {
        const registeredFactories: any[] = []
        const context: any = {
            manifest,
            generation: 1,
            capabilities: new Set(['ui.overlay']),
            events: eventBus,
            register: vi.fn((reg) => {
                if (reg.kind === 'tool-factory') {
                    registeredFactories.push(reg.value)
                }
                return () => {}
            }),
            getService: vi.fn(),
        }

        await askAgentEntry.activate(context)
        expect(registeredFactories).toHaveLength(1)

        const factory = registeredFactories[0]
        expect(factory.id).toBe('ask')
        expect(factory.name).toBe('ask')
        expect(factory.order).toBe(130)
        expect(factory.targets).toEqual(['main'])
        expect(factory.riskLevel).toBe('read')
        expect(factory.requiresApproval).toBe(false)
        expect(factory.approvalCategory).toBe('user-interaction')
    })

    it('executes ask tool and resolves on option selection', async () => {
        const tool = createAskTool()

        const executionPromise = tool.execute(
            'call-100',
            {
                question: '8 × (5 + 3) - 12 ÷ 4 = ?',
                options: [
                    { title: '61', description: 'Calculate parentheses first, then multiply/divide, finally subtract.' },
                    { title: '52', description: 'Calculate from left to right.' },
                ],
            },
            { sessionId: 'test-session', toolCallId: 'call-100' } as any
        )

        const activeReq = useAskStore.getState().getRequest('test-session')
        expect(activeReq).toBeDefined()
        expect(activeReq?.question).toBe('8 × (5 + 3) - 12 ÷ 4 = ?')
        expect(activeReq?.options).toHaveLength(2)

        defaultAskController.submitAnswer('test-session', 'call-100', {
            type: 'selected',
            option: { title: '61', description: 'Calculate parentheses first, then multiply/divide, finally subtract.' },
            index: 0,
        })

        const result = await executionPromise
        expect(result.content[0]?.type).toBe('text')
        expect((result.content[0] as any).text).toContain('User selected: 61 (Calculate parentheses first, then multiply/divide, finally subtract.)')
        expect(useAskStore.getState().getRequest('test-session')).toBeUndefined()
    })

    it('executes ask tool and resolves on custom text answer', async () => {
        const tool = createAskTool()

        const executionPromise = tool.execute(
            'call-200',
            {
                question: 'Enter custom instruction',
                allowCustom: true,
            },
            { sessionId: 'test-session-2', toolCallId: 'call-200' } as any
        )

        defaultAskController.submitAnswer('test-session-2', 'call-200', {
            type: 'custom',
            text: 'Custom user prompt response',
        })

        const result = await executionPromise
        expect((result.content[0] as any).text).toBe('User response: Custom user prompt response')
    })

    it('executes ask tool and resolves on skip', async () => {
        const tool = createAskTool()

        const executionPromise = tool.execute(
            'call-300',
            { question: 'Optional question' },
            { sessionId: 'test-session-3', toolCallId: 'call-300' } as any
        )

        defaultAskController.submitAnswer('test-session-3', 'call-300', {
            type: 'skipped',
        })

        const result = await executionPromise
        expect((result.content[0] as any).text).toBe('User skipped this question.')
    })

    it('executes ask tool and resolves on cancel', async () => {
        const tool = createAskTool()

        const executionPromise = tool.execute(
            'call-400',
            { question: 'Cancelable question' },
            { sessionId: 'test-session-4', toolCallId: 'call-400' } as any
        )

        defaultAskController.cancel('test-session-4', 'call-400')

        const result = await executionPromise
        expect((result.content[0] as any).text).toBe('User dismissed or cancelled this question.')
    })

    it('aborts ask tool execution when signal triggers abort', async () => {
        const tool = createAskTool()
        const abortController = new AbortController()

        const executionPromise = tool.execute(
            'call-500',
            { question: 'Aborted question' },
            {
                sessionId: 'test-session-5',
                toolCallId: 'call-500',
                signal: abortController.signal,
            } as any
        )

        abortController.abort()

        await expect(executionPromise).rejects.toThrow('Tool execution aborted')
        expect(useAskStore.getState().getRequest('test-session-5')).toBeUndefined()
    })

    it('validates required question parameter', async () => {
        const tool = createAskTool()

        await expect(
            tool.execute(
                'call-600',
                {},
                { sessionId: 'test-session-6', toolCallId: 'call-600' } as any
            )
        ).rejects.toThrow('Missing required parameter "question" for ask tool.')

        await expect(
            tool.execute(
                'call-601',
                { question: '   ' },
                { sessionId: 'test-session-6', toolCallId: 'call-601' } as any
            )
        ).rejects.toThrow('Missing required parameter "question" for ask tool.')
    })

    it('handles concurrent sessions asking questions independently without crosstalk', async () => {
        const tool = createAskTool()

        const p1 = tool.execute(
            'call-sess1',
            { question: 'Session 1 question' },
            { sessionId: 'sess-concurrent-1', toolCallId: 'call-sess1' } as any
        )
        const p2 = tool.execute(
            'call-sess2',
            { question: 'Session 2 question' },
            { sessionId: 'sess-concurrent-2', toolCallId: 'call-sess2' } as any
        )

        expect(useAskStore.getState().getRequest('sess-concurrent-1')?.question).toBe('Session 1 question')
        expect(useAskStore.getState().getRequest('sess-concurrent-2')?.question).toBe('Session 2 question')

        defaultAskController.submitAnswer('sess-concurrent-1', 'call-sess1', {
            type: 'custom',
            text: 'Ans 1',
        })
        defaultAskController.submitAnswer('sess-concurrent-2', 'call-sess2', {
            type: 'custom',
            text: 'Ans 2',
        })

        const [r1, r2] = await Promise.all([p1, p2])
        expect((r1.content[0] as any).text).toBe('User response: Ans 1')
        expect((r2.content[0] as any).text).toBe('User response: Ans 2')
    })
})
