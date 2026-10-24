import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationEntry, ModelCatalogEntry, ProtocolStreamInput } from '@cpa/plugin-api'
import { CodexClient } from './codexClient.js'
import { CodexProtocolSession } from './CodexProtocolSession.js'
import { buildCodexRequest } from './codexRequest.js'

const model: ModelCatalogEntry = {
    id: 'reasoning-model', label: 'Reasoning Model', supportsFast: false,
    reasoningLevels: [{ id: 'low', requestValue: 'LowEffort' }, { id: 'high', requestValue: 'HighEffort' }],
    input: ['text'], contextWindow: 128_000, maxTokens: 16_384,
}

const firstUser: ConversationEntry = {
    id: 'u1', sessionId: 's1', createdAt: 1, kind: 'user', reasoningEffort: 'low',
    content: [{ type: 'text', text: 'First' }],
}
const answer: ConversationEntry = {
    id: 'a1', sessionId: 's1', createdAt: 2, kind: 'assistant', reasoningEffort: 'low',
    model: model.id, status: 'done', stopReason: 'stop', content: [{ type: 'text', text: 'Answer' }],
}
const secondUser: ConversationEntry = {
    id: 'u2', sessionId: 's1', createdAt: 3, kind: 'user', reasoningEffort: 'high',
    content: [{ type: 'text', text: 'Second' }],
}

function streamInput(entries: ConversationEntry[], effort: string): ProtocolStreamInput {
    return {
        model, entries, reasoningEffort: effort, systemPrompt: 'System',
        seed: { id: 'seed', sessionId: 's1', createdAt: 4, kind: 'assistant',
            status: 'streaming', stopReason: 'pending', content: [] },
    }
}

function session(): CodexProtocolSession {
    return new CodexProtocolSession({
        sessionId: 's1', baseUrl: 'https://proxy.test/v1', apiKey: 'key', bridge: {},
    })
}

async function collectStream(protocol: CodexProtocolSession, input: ProtocolStreamInput): Promise<void> {
    for await (const _event of protocol.stream(input)) {
        // The mocked client has no events.
    }
}

afterEach(() => vi.restoreAllMocks())

describe('CodexProtocolSession reasoning effort', () => {
    it('pins the first recorded effort even on a newly created session for a later turn', async () => {
        const stream = vi.spyOn(CodexClient.prototype, 'stream').mockImplementation(async function* (input) {
            return input.seed
        })
        const first = session()
        await collectStream(first, streamInput([firstUser], 'low'))
        await first.dispose()

        const second = session()
        await collectStream(second, streamInput([firstUser, answer, secondUser], 'high'))
        await second.dispose()

        const bodies = stream.mock.calls.map(([input]) => buildCodexRequest({
            model: input.model, sessionId: 's1', systemPrompt: input.systemPrompt,
            entries: input.entries, reasoningEffort: input.reasoningEffort,
            baseReasoningEffort: input.baseReasoningEffort,
        }))
        expect(stream.mock.calls.map(([input]) => input.baseReasoningEffort)).toEqual(['low', 'low'])
        expect(bodies.map((body) => body.reasoning?.effort)).toEqual(['LowEffort', 'LowEffort'])
        expect(bodies[1]?.input).toContainEqual({
            type: 'configuration_update', reasoning: { effort: 'HighEffort' },
        })
    })

    it('preserves baseReasoningEffort on isolated streams that share the session promptCacheKey', async () => {
        const stream = vi.spyOn(CodexClient.prototype, 'stream').mockImplementation(async function* (input) {
            return input.seed
        })
        const s = session()
        await collectStream(s, streamInput([firstUser, answer, secondUser], 'high'))

        // Cached compaction stream: isolated connection mode sharing sessionId promptCacheKey.
        // Even if caller passes input.baseReasoningEffort = 'high' (current turn), the session's pinned base 'low' wins.
        for await (const _event of s.stream(
            { ...streamInput([firstUser, answer, secondUser], 'high'), baseReasoningEffort: 'high' },
            { connectionMode: 'isolated', promptCacheKey: 's1', maxOutputTokens: 4096 },
        )) {
            // drain
        }
        await s.dispose()

        expect(stream.mock.calls).toHaveLength(2)
        expect(stream.mock.calls[1]?.[0].baseReasoningEffort).toBe('low')
        const cachedSummaryBody = buildCodexRequest({
            model,
            sessionId: 's1',
            systemPrompt: 'System',
            entries: [firstUser, answer, secondUser],
            reasoningEffort: 'high',
            baseReasoningEffort: stream.mock.calls[1]?.[0].baseReasoningEffort,
        })
        expect(cachedSummaryBody.reasoning?.effort).toBe('LowEffort')

        // Also when a brand-new CodexProtocolSession is created for manual compaction after
        // earlier low-effort entries were compacted away, explicit input.baseReasoningEffort ('low')
        // wins over the remaining post-compaction entry's reasoningEffort ('high').
        const freshCompactSession = session()
        for await (const _event of freshCompactSession.stream(
            { ...streamInput([secondUser], 'high'), baseReasoningEffort: 'low' },
            { connectionMode: 'isolated', promptCacheKey: 's1', maxOutputTokens: 4096 },
        )) {
            // drain
        }
        await freshCompactSession.dispose()
        expect(stream.mock.calls[2]?.[0].baseReasoningEffort).toBe('low')

        // An isolated pre-turn cached compaction on a fresh session must NOT prematurely pin
        // this.baseReasoningEffort for the subsequent normal post-compaction turn.
        const preTurnCompactSession = session()
        for await (const _event of preTurnCompactSession.stream(
            { ...streamInput([firstUser, answer, secondUser], 'high'), baseReasoningEffort: 'low' },
            { connectionMode: 'isolated', promptCacheKey: 's1', maxOutputTokens: 4096 },
        )) {
            // drain isolated pre-turn compaction
        }
        // Now first normal turn after compaction only has secondUser ('high'):
        await collectStream(preTurnCompactSession, streamInput([secondUser], 'high'))
        await preTurnCompactSession.dispose()
        expect(stream.mock.calls[3]?.[0].baseReasoningEffort).toBe('low')
        expect(stream.mock.calls[4]?.[0].baseReasoningEffort).toBe('high')
    })
})
