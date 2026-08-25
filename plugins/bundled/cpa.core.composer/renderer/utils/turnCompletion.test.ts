import { describe, expect, it } from 'vitest'
import { isTurnCompleted } from './turnCompletion.js'

describe('isTurnCompleted', () => {
    it('returns false when streaming is active', () => {
        expect(
            isTurnCompleted(
                [{ kind: 'message', role: 'assistant', status: 'done' }],
                'done',
                true,
            ),
        ).toBe(false)
    })

    it('returns true when runStatus is done and not streaming', () => {
        expect(isTurnCompleted([], 'done', false)).toBe(true)
    })

    it('returns false for empty messages without done runStatus', () => {
        expect(isTurnCompleted([], 'idle', false)).toBe(false)
        expect(isTurnCompleted(undefined, 'idle', false)).toBe(false)
    })

    it('returns false when the latest message is from user', () => {
        const messages = [
            { kind: 'message', role: 'assistant', status: 'done' },
            { kind: 'message', role: 'user', content: 'hello' },
        ]
        expect(isTurnCompleted(messages, 'idle', false)).toBe(false)
    })

    it('returns false when latest assistant message is streaming, aborted, or error', () => {
        expect(
            isTurnCompleted(
                [{ kind: 'message', role: 'assistant', status: 'streaming' }],
                'idle',
                false,
            ),
        ).toBe(false)
        expect(
            isTurnCompleted(
                [{ kind: 'message', role: 'assistant', status: 'aborted' }],
                'idle',
                false,
            ),
        ).toBe(false)
        expect(
            isTurnCompleted(
                [{ kind: 'message', role: 'assistant', status: 'error' }],
                'idle',
                false,
            ),
        ).toBe(false)
        expect(
            isTurnCompleted(
                [{ kind: 'message', role: 'assistant', status: 'done', interrupted: true }],
                'idle',
                false,
            ),
        ).toBe(false)
    })

    it('returns false when assistant message has pending or running tool calls', () => {
        const messagesWithRunningTool = [
            {
                kind: 'message',
                role: 'assistant',
                status: 'done',
                parts: [
                    { type: 'text', text: 'Working on it' },
                    { type: 'tool_call', id: 'call-1', name: 'bash', status: 'running' },
                ],
            },
        ]
        expect(isTurnCompleted(messagesWithRunningTool, 'idle', false)).toBe(false)

        const messagesWithPendingTool = [
            {
                kind: 'message',
                role: 'assistant',
                status: 'done',
                parts: [
                    { type: 'tool_call', id: 'call-2', name: 'read', status: 'pending' },
                ],
            },
        ]
        expect(isTurnCompleted(messagesWithPendingTool, 'idle', false)).toBe(false)
    })

    it('returns true when latest assistant message is done with all tool calls completed', () => {
        const messages = [
            { kind: 'message', role: 'user', content: 'run test' },
            {
                kind: 'message',
                role: 'assistant',
                status: 'done',
                parts: [
                    { type: 'tool_call', id: 'call-1', name: 'bash', status: 'done' },
                    { type: 'text', text: 'All tests pass' },
                ],
            },
        ]
        expect(isTurnCompleted(messages, 'idle', false)).toBe(true)
    })

    it('skips compaction records when finding the latest conversational message', () => {
        const messages = [
            { kind: 'message', role: 'assistant', status: 'done' },
            { kind: 'compaction', id: 'comp-1' },
        ]
        expect(isTurnCompleted(messages, 'idle', false)).toBe(true)
    })
})
