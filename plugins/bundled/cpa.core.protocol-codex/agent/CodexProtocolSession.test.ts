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
})
