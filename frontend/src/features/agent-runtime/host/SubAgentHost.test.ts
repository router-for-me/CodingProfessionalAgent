import { describe, expect, it } from 'vitest'
import type {
    AgentTool,
    AssistantEntry,
    ModelCatalogEntry,
    UserEntry,
} from '@cpa/plugin-api'
import type { PreparedAgentRun } from '@/features/agent/types'
import type { AgentRunEvent } from '../agent/types'
import {
    collectSpawnAgentToolCallIds,
    isLinkedSubAgent,
    parseModelSpec,
    resolveCatalogModel,
    resolveChildReasoning,
    SubAgentHost,
    type SubAgentRunRequest,
} from './SubAgentHost'

const model: ModelCatalogEntry = {
    id: 'parent-model',
    label: 'Parent',
    supportsFast: true,
    reasoningLevels: [{ id: 'medium', requestValue: 'medium' }],
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 8_192,
}

const altModel: ModelCatalogEntry = {
    ...model,
    id: 'flash',
    label: 'Flash',
}

const readTool: AgentTool = {
    name: 'read',
    label: 'read',
    description: 'Read files',
    parameters: { type: 'object', properties: {} },
    validate: (input) => (input ?? {}) as Record<string, unknown>,
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
}

function preparedRun(): PreparedAgentRun {
    return {
        baseUrl: 'http://127.0.0.1:8317',
        apiKey: 'key',
        model,
        reasoningEffort: 'medium',
        speed: 'standard',
        requestApproval: false,
        fastContextCompaction: true,
        agentDir: '/cfg/agent',
        projectCwd: '/repo',
        projectPaths: ['/repo'],
        tools: [readTool],
        snapshot: {
            contextFiles: [],
            skills: [],
            prompts: [],
            systemPrompt: 'parent prompt',
            diagnostics: [],
        },
        diagnostics: [],
        systemPrompt: 'parent prompt',
        supportsImages: false,
        skills: [],
        prompts: [],
    }
}

function assistant(sessionId: string, text: string): AssistantEntry {
    return {
        id: `a-${text}`,
        sessionId,
        createdAt: 1,
        kind: 'assistant',
        content: [{ type: 'text', text }],
        stopReason: 'stop',
        status: 'done',
    }
}

async function* scriptedRun(
    request: SubAgentRunRequest,
    replies: string[],
): AsyncGenerator<AgentRunEvent> {
    const text = replies.shift() ?? 'done'
    const entry = assistant(request.sessionId, text)
    yield {
        type: 'agent-start',
        runId: request.runId,
        sessionId: request.sessionId,
    }
    yield {
        type: 'assistant-end',
        runId: request.runId,
        sessionId: request.sessionId,
        entry,
    }
    yield {
        type: 'agent-end',
        runId: request.runId,
        sessionId: request.sessionId,
        entries: [request.userEntry, entry],
    }
}

describe('SubAgentHost', () => {
    it('uses the model-provided name and returns the last assistant message', async () => {
        const replies = ['final answer 146']
        let childSystemPrompt = ''
        const host = new SubAgentHost({
            generateId: () => 'agent-1',
            now: () => 10,
            run: (request) => {
                childSystemPrompt = request.systemPrompt
                return scriptedRun(request, replies)
            },
        })
        host.configure({
            prepared: preparedRun(),
            codingTools: [readTool],
            models: [model, altModel],
        })
        host.setParentContext({ sessionId: 'parent', runId: 'run-1' })

        const result = await host.spawn('solve the problem', { name: 'Atlas' })
        expect(result.isError).toBeFalsy()
        expect(result.content[0]).toEqual({
            type: 'text',
            text: '[sub-agent Atlas id=agent-1]\nfinal answer 146',
        })
        const record = host.get('agent-1')
        expect(record?.name).toBe('Atlas')
        expect(childSystemPrompt).toContain('You are a sub-agent named Atlas.')
        expect(record?.status).toBe('completed')
        expect(record?.parentSessionId).toBe('parent')
        expect(record?.lastMessage).toBe('final answer 146')
        expect(record?.modelId).toBe('parent-model')
        expect(record?.reasoningEffort).toBe('medium')
    })

    it('keeps run-scoped tools and prepared state isolated across parent sessions', async () => {
        const requests: SubAgentRunRequest[] = []
        const host = new SubAgentHost({
            generateId: (() => {
                let count = 0
                return () => `isolated-${++count}`
            })(),
            now: () => 10,
            run: (request) => {
                requests.push(request)
                return scriptedRun(request, ['isolated child done'])
            },
        })
        const projectTool: AgentTool = {
            ...readTool,
            name: 'project-a-read',
            label: 'project-a-read',
        }
        const projectPrepared = {
            ...preparedRun(),
            projectCwd: '/repo-a',
            projectPaths: ['/repo-a'],
            tools: [projectTool],
        }
        const pureChatPrepared = {
            ...preparedRun(),
            projectCwd: undefined,
            projectPaths: [],
            tools: [],
        }
        const projectConfig = {
            prepared: projectPrepared,
            codingTools: [projectTool],
            models: [model],
        }
        const pureChatConfig = {
            prepared: pureChatPrepared,
            codingTools: [],
            models: [model],
        }

        host.configure(projectConfig)
        host.setParentContext(
            { sessionId: 'project-session', runId: 'project-run' },
            projectConfig,
        )
        host.configure(pureChatConfig)
        host.setParentContext(
            { sessionId: 'pure-chat-session', runId: 'pure-chat-run' },
            pureChatConfig,
        )
        host.clearParentContext('pure-chat-session', 'pure-chat-run')

        const result = await host.spawn('inspect project A', {
            name: 'ScopedWorker',
            parentSessionId: 'project-session',
        })

        expect(result.isError).toBeFalsy()
        expect(requests).toHaveLength(1)
        expect(requests[0]?.prepared).toBe(projectPrepared)
        expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([
            'project-a-read',
        ])
        expect(requests[0]?.systemPrompt).toContain(
            'Current working directory: /repo-a',
        )
    })

    it('passes the requested catalog model into the child run', async () => {
        const replies = ['used flash']
        let seenModelId = ''
        const host = new SubAgentHost({
            generateId: () => 'agent-flash',
            now: () => 10,
            run: (request) => {
                seenModelId = request.model.id
                return scriptedRun(request, replies)
            },
        })
        host.configure({
            prepared: preparedRun(),
            codingTools: [readTool],
            models: [model, altModel],
        })
        host.setParentContext({ sessionId: 'parent', runId: 'run-1' })

        await host.spawn('solve with flash', {
            name: 'Flash',
            modelId: 'flash',
        })
        expect(seenModelId).toBe('flash')
        expect(host.get('agent-flash')?.modelId).toBe('flash')
    })

    it('sends an unknown requested model id upstream instead of the parent model', async () => {
        const replies = ['used requested']
        let seenModelId = ''
        const host = new SubAgentHost({
            generateId: () => 'agent-custom',
            now: () => 10,
            run: (request) => {
                seenModelId = request.model.id
                return scriptedRun(request, replies)
            },
        })
        host.configure({
            prepared: preparedRun(),
            codingTools: [readTool],
            models: [model, altModel],
        })
        host.setParentContext({ sessionId: 'parent', runId: 'run-1' })

        await host.spawn('use a custom slug', {
            name: 'Custom',
            modelId: 'gpt-mini',
        })
        expect(seenModelId).toBe('gpt-mini')
        expect(host.get('agent-custom')?.modelId).toBe('gpt-mini')
    })

    it('matches catalog models by label and keeps unknown ids for the wire', () => {
        expect(resolveCatalogModel([model, altModel], 'Flash', model).id).toBe('flash')
        expect(resolveCatalogModel([model, altModel], 'FLASH', model).id).toBe('flash')
        expect(resolveCatalogModel([model, altModel], 'gpt-mini', model)).toEqual({
            ...model,
            id: 'gpt-mini',
            label: 'gpt-mini',
        })
        expect(resolveCatalogModel([model, altModel], undefined, model).id).toBe(
            'parent-model',
        )
    })

    it('keeps a preferred reasoning effort when the child model advertises it', () => {
        expect(resolveChildReasoning(model, 'medium')).toBe('medium')
        expect(
            resolveChildReasoning(
                { ...model, reasoningLevels: [{ id: 'high', requestValue: 'high' }] },
                'medium',
            ),
        ).toBe('high')
        expect(
            resolveChildReasoning({ ...model, reasoningLevels: [] }, 'medium'),
        ).toBeUndefined()
    })

    it('parses model spec with reasoning effort suffix', () => {
        expect(parseModelSpec('grok-4.6:xhigh')).toEqual({
            modelId: 'grok-4.6',
            reasoningEffort: 'xhigh',
        })
        expect(parseModelSpec('gemini-3.7-flash-high:high')).toEqual({
            modelId: 'gemini-3.7-flash-high',
            reasoningEffort: 'high',
        })
        expect(parseModelSpec('gpt-5.6-luna')).toEqual({
            modelId: 'gpt-5.6-luna',
        })
        expect(parseModelSpec(undefined)).toEqual({})
        expect(parseModelSpec('')).toEqual({})
    })

    it('resolves catalog model when modelId carries a reasoning effort suffix', () => {
        const grokModel: ModelCatalogEntry = {
            id: 'grok-4.6',
            label: 'Grok 4.6',
            supportsFast: false,
            reasoningLevels: [
                { id: 'high', requestValue: 'high' },
                { id: 'xhigh', requestValue: 'xhigh' },
            ],
            input: ['text'],
            contextWindow: 500_000,
            maxTokens: 16_384,
        }
        const resolved = resolveCatalogModel([grokModel], 'grok-4.6:xhigh', model)
        expect(resolved.id).toBe('grok-4.6')
        expect(resolved.label).toBe('Grok 4.6')
        expect(resolved.reasoningLevels).toHaveLength(2)
    })

    it('prioritizes explicit child reasoning effort over parent reasoning level', () => {
        const grokModel: ModelCatalogEntry = {
            id: 'grok-4.6',
            label: 'Grok 4.6',
            supportsFast: false,
            reasoningLevels: [
                { id: 'high', requestValue: 'high' },
                { id: 'xhigh', requestValue: 'xhigh' },
            ],
            input: ['text'],
            contextWindow: 500_000,
            maxTokens: 16_384,
        }
        // Explicit 'xhigh' should win over parent's 'high'
        expect(resolveChildReasoning(grokModel, 'xhigh', 'high')).toBe('xhigh')
        // When child effort is omitted (undefined), parent's 'high' is used
        expect(resolveChildReasoning(grokModel, undefined, 'high')).toBe('high')
    })

    it('passes model and explicit reasoning effort into SubAgentRunRequest when model:thinking format is used', async () => {
        const grokModel: ModelCatalogEntry = {
            id: 'grok-4.6',
            label: 'Grok 4.6',
            supportsFast: false,
            reasoningLevels: [
                { id: 'high', requestValue: 'high' },
                { id: 'xhigh', requestValue: 'xhigh' },
            ],
            input: ['text'],
            contextWindow: 500_000,
            maxTokens: 16_384,
        }
        let capturedRequest: SubAgentRunRequest | null = null
        const host = new SubAgentHost({
            generateId: () => 'subagent-grok',
            now: () => 10,
            run: (request) => {
                capturedRequest = request
                return scriptedRun(request, ['grok completed'])
            },
        })
        host.configure({
            prepared: { ...preparedRun(), reasoningEffort: 'high' },
            codingTools: [readTool],
            models: [model, grokModel],
        })
        host.setParentContext({ sessionId: 'parent', runId: 'run-1' })

        await host.spawn('review code', {
            name: 'GrokReviewer',
            modelId: 'grok-4.6:xhigh',
        })

        expect(capturedRequest).not.toBeNull()
        const req = capturedRequest as SubAgentRunRequest | null
        expect(req?.model.id).toBe('grok-4.6')
        expect(req?.reasoningEffort).toBe('xhigh')

        const record = host.get('subagent-grok')
        expect(record?.modelId).toBe('grok-4.6')
        expect(record?.reasoningEffort).toBe('xhigh')
    })

    it('passes speed from prepared configuration into SubAgentRunRequest', async () => {
        let capturedRequest: SubAgentRunRequest | null = null
        const host = new SubAgentHost({
            generateId: () => 'subagent-fast',
            now: () => 10,
            run: (request) => {
                capturedRequest = request
                return scriptedRun(request, ['fast child completed'])
            },
        })
        host.configure({
            prepared: { ...preparedRun(), speed: 'fast' },
            codingTools: [readTool],
            models: [model],
        })
        host.setParentContext({ sessionId: 'parent', runId: 'run-fast' })

        await host.spawn('fast task', {
            name: 'FastWorker',
        })

        expect(capturedRequest).not.toBeNull()
        const req = capturedRequest as SubAgentRunRequest | null
        expect(req?.speed).toBe('fast')
    })

    it('queues send_message while running and applies it on the next turn', async () => {
        const replies = ['first', 'follow-up done']
        let releaseFirst!: () => void
        const firstTurnStarted = new Promise<void>((resolve) => {
            releaseFirst = resolve
        })
        let holdFirst = new Promise<void>(() => {
            // resolved after send_message queues
        })
        let releaseHold!: () => void
        holdFirst = new Promise<void>((resolve) => {
            releaseHold = resolve
        })
        let turn = 0
        const host = new SubAgentHost({
            generateId: (() => {
                let n = 0
                return () => `id-${++n}`
            })(),
            now: () => 1,
            run: async function* (request) {
                turn += 1
                if (turn === 1) {
                    releaseFirst()
                    await holdFirst
                }
                yield* scriptedRun(request, replies)
            },
        })
        host.configure({
            prepared: preparedRun(),
            codingTools: [readTool],
            models: [model],
        })
        host.setParentContext({ sessionId: 'parent', runId: 'run-1' })

        const spawnPromise = host.spawn('first task', { name: 'Relay' })
        await firstTurnStarted
        const agents = host.list('parent')
        expect(agents).toHaveLength(1)
        const sent = await host.sendMessage(agents[0]!.id, 'continue')
        expect(sent.content[0]).toMatchObject({
            type: 'text',
            text: 'Message sent to Relay',
        })
        releaseHold()
        const result = await spawnPromise
        expect(result.content[0]?.type).toBe('text')
        expect(String(result.content[0] && 'text' in result.content[0] ? result.content[0].text : '')).toContain(
            'follow-up done',
        )
    })

    it('emits userEntry immediately on send_message while running so sidebar displays follow-up message without delay', async () => {
        let releaseFirst!: () => void
        const firstTurnStarted = new Promise<void>((resolve) => {
            releaseFirst = resolve
        })
        let releaseHold!: () => void
        const holdFirst = new Promise<void>((resolve) => {
            releaseHold = resolve
        })
        let turn = 0
        const host = new SubAgentHost({
            generateId: (() => {
                let n = 0
                return () => `msg-id-${++n}`
            })(),
            now: () => 1,
            run: async function* (request) {
                turn += 1
                if (turn === 1) {
                    releaseFirst()
                    await holdFirst
                }
                yield* scriptedRun(request, ['step 1', 'step 2'])
            },
        })
        host.configure({
            prepared: preparedRun(),
            codingTools: [readTool],
            models: [model],
        })
        host.setParentContext({ sessionId: 'parent', runId: 'run-1' })

        const emittedUserEntries: UserEntry[] = []
        host.subscribe({
            onStateChange: () => {},
            onUserEntry: (entry) => {
                emittedUserEntries.push(entry)
            },
        })

        const spawnPromise = host.spawn('first task', { name: 'LiveWorker' })
        await firstTurnStarted
        const agent = host.list('parent')[0]!
        expect(emittedUserEntries).toHaveLength(1)
        expect(emittedUserEntries[0]?.content[0]).toMatchObject({
            type: 'text',
            text: 'first task',
        })

        // Call send_message while turn 1 is still running
        const sent = await host.sendMessage(agent.id, 'follow up while running')
        expect(sent.content[0]).toMatchObject({
            type: 'text',
            text: 'Message sent to LiveWorker',
        })

        // Verify: The second userEntry is emitted IMMEDIATELY before turn 1 completes
        expect(emittedUserEntries).toHaveLength(2)
        expect(emittedUserEntries[1]?.content[0]).toMatchObject({
            type: 'text',
            text: 'follow up while running',
        })
        expect(emittedUserEntries[1]?.sessionId).toBe(agent.sessionId)

        // Complete turn 1 and let turn 2 finish
        releaseHold()
        await spawnPromise
    })

    it('resolves sub-agent by name or bracketed identifier on send_message', async () => {
        const replies = ['spawned', 'turn by name', 'turn by bracket']
        const host = new SubAgentHost({
            generateId: (() => {
                let n = 0
                return () => `res-id-${++n}`
            })(),
            now: () => 1,
            run: (request) => scriptedRun(request, replies),
        })
        host.configure({
            prepared: preparedRun(),
            codingTools: [readTool],
            models: [model],
        })
        host.setParentContext({ sessionId: 'parent', runId: 'run-1' })
        await host.spawn('task', { name: 'MyWorker' })
        const agent = host.list('parent')[0]!

        // Send by subagent name directly
        const resByName = await host.sendMessage('MyWorker', 'do via name')
        expect(String(resByName.content[0] && 'text' in resByName.content[0] ? resByName.content[0].text : '')).toContain(
            'turn by name',
        )

        // Send by bracketed identifier format like "[Sub-agent MyWorker (res-id-1)]"
        const resByBracket = await host.sendMessage(`[Sub-agent MyWorker (${agent.id})]`, 'do via bracket')
        expect(String(resByBracket.content[0] && 'text' in resByBracket.content[0] ? resByBracket.content[0].text : '')).toContain(
            'turn by bracket',
        )
    })

    it('send_message on an idle agent waits for the new last message', async () => {
        const replies = ['spawned', 'second turn']
        const host = new SubAgentHost({
            generateId: (() => {
                let n = 0
                return () => `id-${++n}`
            })(),
            now: () => 1,
            run: (request) => scriptedRun(request, replies),
        })
        host.configure({
            prepared: preparedRun(),
            codingTools: [readTool],
            models: [model],
        })
        host.setParentContext({ sessionId: 'parent', runId: 'run-1' })
        await host.spawn('task', { name: 'Helper' })
        const agent = host.list('parent')[0]!
        const result = await host.sendMessage(agent.id, 'do more')
        expect(result.content[0]?.type).toBe('text')
        expect(String(result.content[0] && 'text' in result.content[0] ? result.content[0].text : '')).toContain(
            'second turn',
        )
    })

    it('returns a retry hint when send_message text is empty', async () => {
        const host = new SubAgentHost({
            generateId: () => 'x',
            now: () => 1,
            run: async function* () {},
        })
        const result = await host.sendMessage('any-id', '   ')
        expect(result.isError).toBe(true)
        expect(result.content[0]).toMatchObject({
            type: 'text',
            text: 'send_message requires a non-empty message. Retry send_message with the follow-up text in message; do not omit message.',
        })
    })

    it('stop aborts a running agent', async () => {
        let startedResolve!: () => void
        const started = new Promise<void>((resolve) => {
            startedResolve = resolve
        })
        const host = new SubAgentHost({
            generateId: () => 'agent-stop',
            now: () => 1,
            run: async function* (request) {
                yield {
                    type: 'agent-start',
                    runId: request.runId,
                    sessionId: request.sessionId,
                }
                startedResolve()
                await new Promise<void>((resolve) => {
                    if (request.signal.aborted) {
                        resolve()
                        return
                    }
                    request.signal.addEventListener('abort', () => resolve(), {
                        once: true,
                    })
                })
            },
        })
        host.configure({
            prepared: preparedRun(),
            codingTools: [readTool],
            models: [model],
        })
        host.setParentContext({ sessionId: 'parent', runId: 'run-1' })

        const spawnPromise = host.spawn('long task', { name: 'Beacon' })
        await started
        expect(host.get('agent-stop')?.status).toBe('running')
        const stopped = host.stop('agent-stop')
        const result = await spawnPromise
        expect(stopped.content[0]).toMatchObject({
            type: 'text',
            text: 'Stopped Beacon',
        })
        expect(result.isError).toBe(true)
        expect(host.get('agent-stop')?.status).toBe('aborted')
    })

    it('requires a model-provided name', async () => {
        const host = new SubAgentHost({
            generateId: () => 'x',
            now: () => 1,
            run: async function* () {},
        })
        const result = await host.spawn('task')
        expect(result).toMatchObject({
            isError: true,
            content: [{ type: 'text', text: 'spawn_agent requires a non-empty name' }],
        })
    })

    it('returns a retry hint when spawn prompt is empty', async () => {
        const host = new SubAgentHost({
            generateId: () => 'x',
            now: () => 1,
            run: async function* () {},
        })
        const result = await host.spawn('   ', { name: 'Reviewer' })
        expect(result.isError).toBe(true)
        expect(result.content[0]).toMatchObject({
            type: 'text',
            text: 'spawn_agent requires a non-empty prompt. Retry spawn_agent once with the complete task instructions in prompt; do not omit prompt.',
        })
    })

    it('adds a suffix when the model reuses a name in the same parent session', async () => {
        const replies = ['first', 'second']
        let nextId = 0
        const host = new SubAgentHost({
            generateId: () => `agent-${++nextId}`,
            now: () => 1,
            run: (request) => scriptedRun(request, replies),
        })
        host.configure({
            prepared: preparedRun(),
            codingTools: [readTool],
            models: [model],
        })
        host.setParentContext({ sessionId: 'parent', runId: 'run-1' })

        await host.spawn('first task', { name: 'Atlas' })
        await host.spawn('second task', { name: 'Atlas' })

        expect(host.list('parent').map((agent) => agent.name)).toEqual(['Atlas', 'Atlas 2'])
    })

    it('rejects spawn without a parent session', async () => {
        const host = new SubAgentHost({
            generateId: () => 'x',
            now: () => 1,
            run: async function* () {
                // unused
            },
        })
        const result = await host.spawn('task', { name: 'Fallback' })
        expect(result.isError).toBe(true)
    })

    it('removeUnlinkedForParent drops agents whose spawn call left history', async () => {
        let startedResolve!: () => void
        const started = new Promise<void>((resolve) => {
            startedResolve = resolve
        })
        const host = new SubAgentHost({
            generateId: () => 'agent-drop',
            now: () => 1,
            run: async function* (request) {
                yield {
                    type: 'agent-start',
                    runId: request.runId,
                    sessionId: request.sessionId,
                }
                startedResolve()
                await new Promise<void>((resolve) => {
                    if (request.signal.aborted) {
                        resolve()
                        return
                    }
                    request.signal.addEventListener('abort', () => resolve(), {
                        once: true,
                    })
                })
            },
        })
        host.configure({
            prepared: preparedRun(),
            codingTools: [readTool],
            models: [model],
        })
        host.setParentContext({ sessionId: 'parent', runId: 'run-1' })
        host.hydrate([
            {
                id: 'keep',
                name: 'Keep',
                color: '#3dd68c',
                icon: 'atom',
                parentSessionId: 'parent',
                sessionId: 'keep',
                modelId: 'parent-model',
                status: 'completed',
                createdAt: 1,
                updatedAt: 1,
                parentToolCallId: 'call-keep',
            },
            {
                id: 'other-parent',
                name: 'Other',
                color: '#9b7dff',
                icon: 'sparkle',
                parentSessionId: 'other',
                sessionId: 'other-parent',
                modelId: 'parent-model',
                status: 'completed',
                createdAt: 1,
                updatedAt: 1,
                parentToolCallId: 'call-other',
            },
        ])

        const spawnPromise = host.spawn('long task', {
            name: 'Drop',
            toolCallId: 'call-drop',
        })
        await started
        expect(host.get('agent-drop')?.status).toBe('running')

        const removed = host.removeUnlinkedForParent('parent', [
            {
                id: 'a-keep',
                sessionId: 'parent',
                createdAt: 1,
                kind: 'assistant',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call-keep',
                        name: 'spawn_agent',
                        arguments: {},
                    },
                ],
                stopReason: 'toolUse',
                status: 'done',
            },
        ])

        expect(removed.map((agent) => agent.id).sort()).toEqual(['agent-drop'])
        expect(host.get('agent-drop')).toBeUndefined()
        expect(host.get('keep')?.id).toBe('keep')
        expect(host.get('other-parent')?.id).toBe('other-parent')
        await spawnPromise
        expect(host.get('agent-drop')).toBeUndefined()
    })

    it('collects spawn_agent tool-call ids including normalized aliases', () => {
        const ids = collectSpawnAgentToolCallIds([
            {
                id: 'a1',
                sessionId: 's',
                createdAt: 1,
                kind: 'assistant',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call-1|extra',
                        name: 'spawn_agent',
                        arguments: {},
                    },
                    {
                        type: 'toolCall',
                        id: 'call-read',
                        name: 'read',
                        arguments: {},
                    },
                ],
                stopReason: 'toolUse',
                status: 'done',
            },
        ])
        expect(ids.has('call-1|extra')).toBe(true)
        expect(ids.has('call-1')).toBe(true)
        expect(ids.has('call-read')).toBe(false)
        expect(
            isLinkedSubAgent({ parentToolCallId: 'call-1' }, ids),
        ).toBe(true)
        expect(
            isLinkedSubAgent({ parentToolCallId: 'missing' }, ids),
        ).toBe(false)
    })

    it('hydrates persisted running agents and preserves their status', () => {
        const host = new SubAgentHost({
            generateId: () => 'x',
            now: () => 1,
            run: async function* () {},
        })
        host.hydrate([
            {
                id: 'old',
                name: 'Einstein',
                color: '#3dd68c',
                icon: 'atom',
                parentSessionId: 'p',
                sessionId: 'old',
                modelId: 'parent-model',
                status: 'running',
                createdAt: 1,
                updatedAt: 1,
            },
        ])
        expect(host.get('old')?.status).toBe('running')
    })

    it('inherits language from prepared run into child system prompt', async () => {
        let childSystemPrompt = ''
        const host = new SubAgentHost({
            generateId: () => 'agent-lang',
            now: () => 10,
            run: (request) => {
                childSystemPrompt = request.systemPrompt
                return scriptedRun(request, ['reply'])
            },
        })
        const prepared = {
            ...preparedRun(),
            language: 'zh-CN',
        }
        host.configure({
            prepared,
            codingTools: [readTool],
            models: [model],
        })
        host.setParentContext({ sessionId: 'parent', runId: 'run-1' })

        await host.spawn('test lang', { name: 'Atlas' })
        expect(childSystemPrompt).toContain(
            '- Respond in Simplified Chinese by default unless the user requests otherwise',
        )
    })

    it('resumes a subagent with existing entries and completes', async () => {
        let executedRequests: SubAgentRunRequest[] = []
        const host = new SubAgentHost({
            generateId: () => 'resume-id',
            now: () => 10,
            run: (request) => {
                executedRequests.push(request)
                return scriptedRun(request, ['Subagent done work'])
            },
        })
        const prepared = preparedRun()
        host.configure({
            prepared,
            codingTools: [readTool],
            models: [model],
        })
        host.setParentContext({ sessionId: 'parent', runId: 'run-1' })

        host.hydrate([
            {
                id: 'sub-1',
                name: 'Worker',
                color: '#3dd68c',
                icon: 'atom',
                parentSessionId: 'parent',
                sessionId: 'sub-1',
                modelId: 'parent-model',
                status: 'running',
                createdAt: 1,
                updatedAt: 1,
            },
        ])

        const res = await host.resumeSubAgent('sub-1', {
            entries: [
                {
                    id: 'u1',
                    sessionId: 'sub-1',
                    createdAt: 1,
                    kind: 'user',
                    content: [{ type: 'text', text: 'Original subagent task' }],
                },
            ],
        })

        expect(res.content[0].text).toContain('Worker')
        expect(res.content[0].text).toContain('Subagent done work')
        expect(host.get('sub-1')?.status).toBe('completed')
        expect(host.get('sub-1')?.lastMessage).toBe('Subagent done work')
        expect(executedRequests).toHaveLength(1)
        expect(executedRequests[0].agentId).toBe('sub-1')
    })

    it('uses the tool execution session when another run overwrites the shared parent context', async () => {
        const host = new SubAgentHost({
            generateId: () => 'isolated-subagent',
            now: () => 10,
            run: (request) => scriptedRun(request, ['Finished in the correct parent']),
        })
        const prepared = preparedRun()
        host.configure({
            prepared,
            codingTools: [readTool],
            models: [model],
        })
        host.setParentContext({ sessionId: 'other-parent', runId: 'other-run' })

        await host.spawn('Review the target session', {
            name: 'Reviewer',
            modelId: model.id,
            toolCallId: 'call-target-parent',
            parentSessionId: 'target-parent',
        })

        expect(host.list('target-parent')).toHaveLength(1)
        expect(host.list('target-parent')[0]).toMatchObject({
            id: 'isolated-subagent',
            parentSessionId: 'target-parent',
            parentToolCallId: 'call-target-parent',
        })
        expect(host.list('other-parent')).toHaveLength(0)
    })

    it('spawn reuses existing subagent matching toolCallId and awaits it without duplicating', async () => {
        let executedRequests: SubAgentRunRequest[] = []
        const host = new SubAgentHost({
            generateId: () => 'new-sub-id',
            now: () => 10,
            run: (request) => {
                executedRequests.push(request)
                return scriptedRun(request, ['Subagent finished work'])
            },
        })
        const prepared = preparedRun()
        host.configure({
            prepared,
            codingTools: [readTool],
            models: [model],
        })
        host.setParentContext({ sessionId: 'parent', runId: 'run-1' })

        host.hydrate([
            {
                id: 'existing-sub-1',
                name: 'ExistingWorker',
                color: '#3dd68c',
                icon: 'atom',
                parentSessionId: 'parent',
                sessionId: 'existing-sub-1',
                modelId: 'parent-model',
                parentToolCallId: 'call-spawn-1',
                status: 'running',
                createdAt: 1,
                updatedAt: 1,
            },
        ])

        const res = await host.spawn('Do task again', {
            name: 'AnyName',
            toolCallId: 'call-spawn-1',
        })

        expect(res.content[0].text).toContain('ExistingWorker')
        expect(res.content[0].text).toContain('Subagent finished work')
        // No duplicate agent was created in host
        expect(host.list()).toHaveLength(1)
        expect(host.get('existing-sub-1')?.status).toBe('completed')
        expect(executedRequests).toHaveLength(1)
        expect(executedRequests[0].agentId).toBe('existing-sub-1')
    })

    it('spawn immediately returns already completed subagent result for matching toolCallId', async () => {
        let ran = false
        const host = new SubAgentHost({
            generateId: () => 'new-sub-id',
            now: () => 10,
            run: (request) => {
                ran = true
                return scriptedRun(request, ['Subagent output'])
            },
        })
        const prepared = preparedRun()
        host.configure({
            prepared,
            codingTools: [readTool],
            models: [model],
        })
        host.setParentContext({ sessionId: 'parent', runId: 'run-1' })

        host.hydrate([
            {
                id: 'completed-sub-1',
                name: 'DoneWorker',
                color: '#3dd68c',
                icon: 'atom',
                parentSessionId: 'parent',
                sessionId: 'completed-sub-1',
                modelId: 'parent-model',
                parentToolCallId: 'call-done-1',
                status: 'completed',
                lastMessage: 'I already finished all the analysis.',
                createdAt: 1,
                updatedAt: 1,
            },
        ])

        const res = await host.spawn('Do task', {
            name: 'DoneWorker',
            toolCallId: 'call-done-1',
        })

        expect(res.content[0].text).toContain('DoneWorker')
        expect(res.content[0].text).toContain('I already finished all the analysis.')
        expect(ran).toBe(false)
        expect(host.list()).toHaveLength(1)
    })

    it('does not pass parent getRuntimeSettings to child run request so child is only controlled by parent arguments', async () => {
        let capturedRequest: any = null
        const host = new SubAgentHost({
            generateId: () => 'sub-agent-id',
            now: () => 10,
            run: (request) => {
                capturedRequest = request
                return scriptedRun(request, ['Subagent output'])
            },
        })

        const prepared = preparedRun()
        host.configure({
            prepared: { ...prepared, reasoningEffort: 'xhigh' },
            codingTools: [readTool],
            models: [
                model,
                {
                    id: 'child-model',
                    label: 'Child Model',
                    supportsFast: false,
                    reasoningLevels: [
                        { id: 'low', requestValue: 'low' },
                        { id: 'high', requestValue: 'high' },
                        { id: 'xhigh', requestValue: 'xhigh' },
                    ],
                    input: ['text'],
                    contextWindow: 128000,
                    maxTokens: 4096,
                },
            ],
        })
        host.setParentContext({
            sessionId: 'parent',
            runId: 'run-1',
            getRuntimeSettings: () => ({
                reasoningEffort: 'xhigh',
                reasoningLevel: 'xhigh',
            }),
        })

        await host.spawn('Analyze the issue', {
            name: 'Worker',
            modelId: 'child-model',
            reasoningEffort: 'high',
        })

        expect(capturedRequest).toBeDefined()
        expect(capturedRequest.model.id).toBe('child-model')
        // Must strictly preserve the explicit reasoningEffort from spawn_agent argument
        expect(capturedRequest.reasoningEffort).toBe('high')
        // Must NOT pass parent getRuntimeSettings to child run request
        expect(capturedRequest.getRuntimeSettings).toBeUndefined()
    })

    it('records completedAt on stop and accumulates pausedMs on resume', async () => {
        let clock = 1000
        const host = new SubAgentHost({
            generateId: () => 'sub-timing-1',
            now: () => clock,
            run: (request) => scriptedRun(request, ['First step done']),
        })
        const prepared = preparedRun()
        host.configure({
            prepared,
            codingTools: [readTool],
            models: [model],
        })
        host.setParentContext({ sessionId: 'parent', runId: 'run-1' })

        host.hydrate([
            {
                id: 'sub-timing-1',
                name: 'Worker',
                color: '#3dd68c',
                icon: 'atom',
                parentSessionId: 'parent',
                sessionId: 'sub-timing-1',
                modelId: 'parent-model',
                status: 'running',
                createdAt: 1000,
                updatedAt: 1000,
            },
        ])

        // Advance to 5000 and stop the agent
        clock = 5000
        host.stopAgent('sub-timing-1')

        const stopped = host.get('sub-timing-1')
        expect(stopped?.status).toBe('aborted')
        expect(stopped?.completedAt).toBe(5000)

        // Advance 20 seconds while stopped (from 5000 to 25000)
        clock = 25000
        await host.resumeSubAgent('sub-timing-1', {
            entries: [
                {
                    id: 'u1',
                    sessionId: 'sub-timing-1',
                    createdAt: 1000,
                    kind: 'user',
                    content: [{ type: 'text', text: 'Resume task' }],
                },
            ],
        })

        const completed = host.get('sub-timing-1')
        expect(completed?.status).toBe('completed')
        // Paused duration was 25000 - 5000 = 20000ms
        expect(completed?.pausedMs).toBe(20000)
        expect(completed?.completedAt).toBe(25000)
    })

    it('finalizes runtime entries with streaming status upon subagent completion', async () => {
        const host = new SubAgentHost({
            generateId: () => 'sub-finalize-1',
            now: () => 30000,
            run: async function* (request) {
                yield {
                    type: 'assistant-end',
                    entry: {
                        id: 'a1',
                        sessionId: request.sessionId,
                        kind: 'assistant',
                        content: [{ type: 'text', text: 'All done' }],
                        status: 'streaming',
                        stopReason: 'pending',
                        createdAt: 10000,
                    },
                }
            },
        })
        const prepared = preparedRun()
        host.configure({
            prepared,
            codingTools: [readTool],
            models: [model],
        })
        host.setParentContext({ sessionId: 'parent', runId: 'run-1' })

        await host.spawn('Run task', { name: 'Finalizer' })
        const agent = host.get('sub-finalize-1')
        expect(agent?.status).toBe('completed')
        expect(agent?.completedAt).toBe(30000)

        const runtime = (host as any).runtimes.get('sub-finalize-1')
        expect(runtime?.entries).toHaveLength(1)
        expect(runtime?.entries[0]).toMatchObject({
            id: 'a1',
            status: 'done',
            stopReason: 'stop',
            completedAt: 30000,
        })
    })

    it('rejects spawn when subagents are disabled in settings', async () => {
        const host = new SubAgentHost({
            generateId: () => 'sub-disabled-1',
            now: () => 1000,
            run: (request) => scriptedRun(request, ['Done']),
        })
        const prepared = preparedRun()
        host.configure({
            prepared,
            codingTools: [readTool],
            models: [model],
            subagentsSettings: {
                enabled: false,
                concurrency: 10,
                maxPerSession: 3,
                maxDepth: 1,
            },
        })
        host.setParentContext({ sessionId: 'parent', runId: 'run-1' })

        const res = await host.spawn('Do work', { name: 'Worker' })
        expect(res.isError).toBe(true)
        expect(res.content[0]?.text).toContain('Subagents are disabled in settings')
    })

    it('queues subagent when exceeding maxPerSession limit and drains FIFO when slot is freed', async () => {
        let clock = 1000
        let finishFirstAgent!: () => void
        const firstAgentPromise = new Promise<void>((resolve) => {
            finishFirstAgent = resolve
        })

        const host = new SubAgentHost({
            generateId: (() => {
                let count = 0
                return () => `sub-queue-${++count}`
            })(),
            now: () => clock++,
            run: (request) => {
                if (request.agentId === 'sub-queue-1') {
                    return (async function* () {
                        await firstAgentPromise
                        yield {
                            type: 'assistant-end',
                            entry: {
                                id: 'e1',
                                sessionId: request.sessionId,
                                kind: 'assistant',
                                content: [{ type: 'text', text: 'Agent 1 done' }],
                            },
                        }
                    })()
                }
                return scriptedRun(request, ['Agent 2 done'])
            },
        })
        const prepared = preparedRun()
        host.configure({
            prepared,
            codingTools: [readTool],
            models: [model],
            subagentsSettings: {
                enabled: true,
                concurrency: 10,
                maxPerSession: 1, // Single session concurrency limit is 1
                maxDepth: 1,
            },
        })
        host.setParentContext({ sessionId: 'session-A', runId: 'run-1' })

        // 1. Spawn first subagent (takes the only slot)
        const p1 = host.spawn('Task 1', { name: 'Worker1' })
        expect(host.get('sub-queue-1')?.status).toBe('running')

        // 2. Spawn second subagent in same session (exceeds maxPerSession=1, must be queued)
        let agent2UpdateStatus = ''
        const p2 = host.spawn('Task 2', {
            name: 'Worker2',
            onUpdate: (u) => {
                if ((u?.details as any)?.status) {
                    agent2UpdateStatus = (u.details as any).status
                }
            },
        })

        expect(agent2UpdateStatus).toBe('queued')
        const queuedAgent = host.list('session-A').find((a) => a.name === 'Worker2')
        expect(queuedAgent?.status).toBe('queued')

        // 3. Complete first subagent -> releases slot and wakes up Worker2
        finishFirstAgent?.()
        const [res1, res2] = await Promise.all([p1, p2])

        expect(res1.isError).toBe(false)
        expect(res2.isError).toBe(false)
        const finalAgents = host.list('session-A')
        expect(finalAgents.find((a) => a.name === 'Worker1')?.status).toBe('completed')
        expect(finalAgents.find((a) => a.name === 'Worker2')?.status).toBe('completed')
    })

    it('queues subagents when exceeding global concurrency and drains by createdAt FIFO order', async () => {
        let clock = 1000
        let finishFirstAgent!: () => void
        const firstAgentPromise = new Promise<void>((resolve) => {
            finishFirstAgent = resolve
        })

        const host = new SubAgentHost({
            generateId: (() => {
                let count = 0
                return () => `global-sub-${++count}`
            })(),
            now: () => clock++,
            run: (request) => {
                if (request.agentId === 'global-sub-1') {
                    return (async function* () {
                        await firstAgentPromise
                        yield {
                            type: 'assistant-end',
                            entry: {
                                id: 'e1',
                                sessionId: request.sessionId,
                                kind: 'assistant',
                                content: [{ type: 'text', text: 'Global 1 done' }],
                            },
                        }
                    })()
                }
                return scriptedRun(request, ['Task done'])
            },
        })
        const prepared = preparedRun()
        host.configure({
            prepared,
            codingTools: [readTool],
            models: [model],
            subagentsSettings: {
                enabled: true,
                concurrency: 1, // Global concurrency is 1
                maxPerSession: 5,
                maxDepth: 1,
            },
        })

        // Spawn in session-1
        host.setParentContext({ sessionId: 'session-1', runId: 'run-1' })
        const p1 = host.spawn('Task 1', { name: 'Worker1' })

        // Spawn in session-2 (must be queued due to global concurrency limit)
        host.setParentContext({ sessionId: 'session-2', runId: 'run-2' })
        const p2 = host.spawn('Task 2', { name: 'Worker2' })

        const session2Agents = host.list('session-2')
        expect(session2Agents.find((a) => a.name === 'Worker2')?.status).toBe('queued')

        // Release first agent
        finishFirstAgent?.()
        const [r1, r2] = await Promise.all([p1, p2])
        expect(r1.isError).toBe(false)
        expect(r2.isError).toBe(false)
        expect(host.list('session-2').find((a) => a.name === 'Worker2')?.status).toBe('completed')
    })

    it('enforces depth limit: omits subagent tools/instructions when depth >= maxDepth', async () => {
        let childRunTools: AgentTool[] = []
        let childRunSystemPrompt = ''

        const spawnTool: AgentTool = {
            name: 'spawn_agent',
            label: 'spawn_agent',
            description: 'Spawn a subagent',
            parameters: { type: 'object', properties: {} },
            validate: (input) => (input ?? {}) as Record<string, unknown>,
            execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        }

        const host = new SubAgentHost({
            generateId: () => 'sub-depth-1',
            now: () => 1000,
            run: (request) => {
                childRunTools = [...request.tools]
                childRunSystemPrompt = request.systemPrompt
                return scriptedRun(request, ['Task done'])
            },
        })
        const prepared = preparedRun()

        // Test 1: maxDepth = 1 (default) -> spawned child (depth 1) must NOT receive spawn_agent and must NOT see subagent roles
        host.configure({
            prepared,
            codingTools: [readTool],
            allTools: [readTool, spawnTool],
            models: [model],
            subagentsSettings: {
                enabled: true,
                concurrency: 10,
                maxPerSession: 3,
                maxDepth: 1,
                roles: [
                    {
                        id: 'leaf-role',
                        name: 'Leaf Role',
                        description: 'Some role prompt.',
                        modelId: 'parent-model',
                        reasoningEffort: 'medium',
                    },
                ],
            },
        })
        host.setParentContext({ sessionId: 'session-root', runId: 'run-1' })

        await host.spawn('Run task', { name: 'ChildOne' })
        expect(childRunTools.some((t) => t.name === 'spawn_agent')).toBe(false)
        expect(childRunSystemPrompt).toContain('Do not spawn other agents.')
        expect(childRunSystemPrompt).not.toContain('<available_roles>')
        expect(childRunSystemPrompt).not.toContain('<id>leaf-role</id>')

        // Test 2: maxDepth = 2 -> spawned child (depth 1) MUST receive spawn_agent
        childRunTools = []
        childRunSystemPrompt = ''
        const host2 = new SubAgentHost({
            generateId: () => 'sub-depth-nested',
            now: () => 1000,
            run: (request) => {
                childRunTools = [...request.tools]
                childRunSystemPrompt = request.systemPrompt
                return scriptedRun(request, ['Nested task done'])
            },
        })
        host2.configure({
            prepared,
            codingTools: [readTool],
            allTools: [readTool, spawnTool],
            models: [model],
            subagentsSettings: {
                enabled: true,
                concurrency: 10,
                maxPerSession: 3,
                maxDepth: 2,
                roles: [
                    {
                        id: 'nested-role',
                        name: 'Nested Reviewer',
                        description: 'Inspect nested code.',
                        modelId: 'parent-model',
                        reasoningEffort: 'medium',
                    },
                ],
            },
        })
        host2.setParentContext({ sessionId: 'session-root', runId: 'run-1' })

        await host2.spawn('Run nested task', { name: 'ChildTwo' })
        expect(childRunTools.some((t) => t.name === 'spawn_agent')).toBe(true)
        expect(childRunSystemPrompt).not.toContain('Do not spawn other agents.')
        expect(childRunSystemPrompt).toContain('You may spawn child subagents if necessary.')
        expect(childRunSystemPrompt).toContain('<available_roles>')
        expect(childRunSystemPrompt).toContain('<id>nested-role</id>')
        expect(childRunSystemPrompt).toContain(
            'When encountering scenarios matching any of these defined roles when dispatching a sub-agent, prioritize using the user-defined subagent role rather than deciding the model, reasoning effort, or prompt on your own.'
        )
    })

    it('injects developer-level prompt at the head when spawning with a matching configured role and prioritizes role model/effort', async () => {
        let childRunSystemPrompt = ''
        let childRunDeveloperPrompt: string | undefined
        let childModel: ModelCatalogEntry | undefined
        let childReasoningEffort: string | undefined

        const roleModel: ModelCatalogEntry = {
            ...model,
            id: 'gpt-5.5',
            label: 'GPT 5.5',
            reasoningLevels: [{ id: 'high', requestValue: 'high' }],
        }

        const host = new SubAgentHost({
            generateId: () => 'sub-role-agent',
            now: () => 1000,
            run: (request) => {
                childRunSystemPrompt = request.systemPrompt
                childRunDeveloperPrompt = request.developerPrompt
                childModel = request.model
                childReasoningEffort = request.reasoningEffort
                return scriptedRun(request, ['Role task completed'])
            },
        })

        const prepared = preparedRun()
        host.configure({
            prepared,
            codingTools: [readTool],
            models: [model, roleModel],
            subagentsSettings: {
                enabled: true,
                concurrency: 10,
                maxPerSession: 3,
                maxDepth: 1,
                roles: [
                    {
                        id: 'reviewer-id',
                        name: '代码审查员',
                        description: '负责严格的代码规范审查与安全审计指令。',
                        modelId: 'gpt-5.5',
                        reasoningEffort: 'high',
                    },
                ],
            },
        })
        host.setParentContext({ sessionId: 'session-root', runId: 'run-1' })

        // Even if the caller passed parent-model, role-configured model should take precedence
        await host.spawn('请审查这个提交', {
            name: 'ReviewerBot',
            role: '代码审查员',
            modelId: 'parent-model',
        })

        // Verify developerPrompt property on request is populated as developer-level instructions
        expect(childRunDeveloperPrompt).toBeDefined()
        expect(childRunDeveloperPrompt).toContain('Role: 代码审查员')
        expect(childRunDeveloperPrompt).toContain('负责严格的代码规范审查与安全审计指令。')

        // Verify base system prompt is generated cleanly
        expect(childRunSystemPrompt).toContain('You are a sub-agent named ReviewerBot')

        // Verify role's configured model and reasoning effort take priority
        expect(childModel?.id).toBe('gpt-5.5')
        expect(childReasoningEffort).toBe('high')
    })

    it('matches configured role by unique role id and handles whitespace', async () => {
        let childRunDeveloperPrompt: string | undefined

        const host = new SubAgentHost({
            generateId: () => 'sub-role-id-agent',
            now: () => 1000,
            run: (request) => {
                childRunDeveloperPrompt = request.developerPrompt
                return scriptedRun(request, ['Done'])
            },
        })

        const prepared = preparedRun()
        host.configure({
            prepared,
            codingTools: [readTool],
            models: [model],
            subagentsSettings: {
                enabled: true,
                concurrency: 10,
                maxPerSession: 3,
                maxDepth: 1,
                roles: [
                    {
                        id: 'unique-reviewer-id',
                        name: ' Reviewer With Spaces ',
                        description: 'Special instructions for unique reviewer.',
                        modelId: 'parent-model',
                        reasoningEffort: 'medium',
                    },
                ],
            },
        })
        host.setParentContext({ sessionId: 'session-root', runId: 'run-1' })

        // Match by exact ID
        await host.spawn('Task', { name: 'Bot', role: 'unique-reviewer-id' })
        expect(childRunDeveloperPrompt).toContain('Special instructions for unique reviewer.')

        // Match by trimmed name
        await host.spawn('Task 2', { name: 'Bot2', role: 'Reviewer With Spaces' })
        expect(childRunDeveloperPrompt).toContain('Special instructions for unique reviewer.')
    })

    it('preserves role developer prompt on resumed subagent and follow-up turns', async () => {
        let lastDeveloperPrompt: string | undefined

        const host = new SubAgentHost({
            generateId: () => 'sub-turn-agent',
            now: () => 1000,
            run: (request) => {
                lastDeveloperPrompt = request.developerPrompt
                return scriptedRun(request, ['Turn done'])
            },
        })

        const prepared = preparedRun()
        host.configure({
            prepared,
            codingTools: [readTool],
            models: [model],
            subagentsSettings: {
                enabled: true,
                concurrency: 10,
                maxPerSession: 3,
                maxDepth: 1,
                roles: [
                    {
                        id: 'role-turn-id',
                        name: 'Tester Role',
                        description: 'Instructions for testing turns.',
                        modelId: 'parent-model',
                        reasoningEffort: 'medium',
                    },
                ],
            },
        })
        host.setParentContext({ sessionId: 'session-root', runId: 'run-1' })

        await host.spawn('Initial prompt', {
            name: 'TurnBot',
            role: 'role-turn-id',
        })
        expect(lastDeveloperPrompt).toContain('Instructions for testing turns.')

        const subAgentId = host.list()[0]?.id!
        lastDeveloperPrompt = undefined

        // Send follow up message
        await host.sendMessage(subAgentId, 'Follow up prompt')
        expect(lastDeveloperPrompt).toContain('Instructions for testing turns.')
    })

    it('restores depth accurately and blocks roles/tools when restored subagent reaches maxDepth', async () => {
        let childRunTools: AgentTool[] = []
        let childRunSystemPrompt = ''
        let childRunDeveloperPrompt: string | undefined

        const spawnTool: AgentTool = {
            name: 'spawn_agent',
            label: 'spawn_agent',
            description: 'Spawn a subagent',
            parameters: { type: 'object', properties: {} },
            validate: (input) => (input ?? {}) as Record<string, unknown>,
            execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        }

        const host = new SubAgentHost({
            generateId: () => 'sub-restored-turn',
            now: () => 1000,
            run: (request) => {
                childRunTools = [...request.tools]
                childRunSystemPrompt = request.systemPrompt
                childRunDeveloperPrompt = request.developerPrompt
                return scriptedRun(request, ['Nested task finished'])
            },
        })

        const prepared = preparedRun()
        host.configure({
            prepared,
            codingTools: [readTool],
            allTools: [readTool, spawnTool],
            models: [model],
            subagentsSettings: {
                enabled: true,
                concurrency: 10,
                maxPerSession: 3,
                maxDepth: 2,
                roles: [
                    {
                        id: 'nested-role-id',
                        name: 'Nested Specialist',
                        description: 'Specialist prompt for nested tasks.',
                        modelId: 'parent-model',
                        reasoningEffort: 'medium',
                    },
                ],
            },
        })
        host.setParentContext({ sessionId: 'session-root', runId: 'run-1' })

        // Hydrate a restored depth-2 subagent (at maxDepth = 2, so cannot spawn child subagents)
        host.hydrate([
            {
                id: 'child-depth-2',
                name: 'NestedChild',
                color: '#3dd68c',
                icon: 'atom',
                parentSessionId: 'session-root',
                sessionId: 'child-depth-2',
                modelId: 'parent-model',
                status: 'completed',
                depth: 2,
                parentAgentId: 'parent-agent-id',
                roleId: 'nested-role-id',
                roleName: 'Nested Specialist',
                rolePrompt: 'Specialist prompt for nested tasks.',
                createdAt: 1000,
                updatedAt: 1000,
            },
        ])

        // Resume / send message to the restored depth-2 subagent
        await host.sendMessage('child-depth-2', 'Continue work')

        // Verify: It cannot spawn child agents because depth 2 >= maxDepth 2
        expect(childRunTools.some((t) => t.name === 'spawn_agent')).toBe(false)
        expect(childRunSystemPrompt).toContain('Do not spawn other agents.')
        expect(childRunSystemPrompt).not.toContain('<available_roles>')
        expect(childRunSystemPrompt).not.toContain('<id>nested-role-id</id>')

        // Verify: Developer prompt is still injected properly
        expect(childRunDeveloperPrompt).toContain('Specialist prompt for nested tasks.')
    })

    it('injects <git> section into subagent system prompt when prepared.gitSettings are present', async () => {
        let childSystemPrompt = ''
        const replies = ['done']
        const host = new SubAgentHost({
            generateId: () => 'subagent-git-1',
            now: () => 1000,
            run: (request) => {
                childSystemPrompt = request.systemPrompt
                return scriptedRun(request, replies)
            },
        })

        const preparedWithGit = {
            ...preparedRun(),
            gitSettings: {
                mergeMethod: 'merge' as const,
                alwaysForcePush: true,
                createDraftPr: false,
                commitInstructions: 'Prefix with subagent task ID',
                prInstructions: 'List changes clearly',
            },
        }

        host.configure({
            prepared: preparedWithGit,
            codingTools: [readTool],
            models: [model],
        })
        host.setParentContext({ sessionId: 'session-1', runId: 'run-1' })

        await host.spawn('Do git operations', {
            name: 'git-subagent',
            modelId: 'parent-model',
        })

        expect(childSystemPrompt).toContain('<git>')
        expect(childSystemPrompt).toContain('Use the "merge" method when merging pull requests.')
        expect(childSystemPrompt).not.toContain('Pull request merge method:')
        expect(childSystemPrompt).toContain('When pushing branches to the remote repository, always use force push with lease (e.g. "git push --force-with-lease").')
        expect(childSystemPrompt).not.toContain('Always force push:')
        expect(childSystemPrompt).toContain('Do not create pull requests as draft by default (create regular, ready-for-review pull requests).')
        expect(childSystemPrompt).not.toContain('Create draft pull requests:')
        expect(childSystemPrompt).toContain('Commit instructions: Prefix with subagent task ID')
        expect(childSystemPrompt).toContain('Pull request instructions: List changes clearly')
        expect(childSystemPrompt).toContain('</git>')
    })
})
