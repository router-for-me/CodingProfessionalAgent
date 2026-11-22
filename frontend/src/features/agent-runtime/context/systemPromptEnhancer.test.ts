import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
    AgentStreamEvent,
    ProtocolClient,
    ProtocolStreamInput,
    ProtocolStreamOptions,
} from '@cpa/plugin-api'
import type { ModelCatalogEntry } from '@/features/models/types'
import { RendererRegistry } from '@/plugins/platform/rendererRegistry'
import { resourcesAgentEntry } from '../../../../../plugins/bundled/cpa.core.resources/agent/index'
import { FakeNativeBridge } from '../native/fakeNativeBridge'
import { loadResourcesFromProviders } from '../providers/ResourceProvider'
import { AgentPreflightError } from '@/features/agent/types'
import {
    pickTargetPromptLanguage,
    resolveEnhancementModel,
    synthesizeEnhancedSystemPrompt,
    validateEnhancedCorePrompt,
} from './systemPromptEnhancer'

const AGENT = '/config/coding-professional-agent/agent'
const REPO = '/workspace/app'
const HOME = '/home/user'

function makeModel(id: string, reasoningIds: string[] = ['low', 'medium', 'high']): ModelCatalogEntry {
    return {
        id,
        label: id,
        contextWindow: 200_000,
        maxTokens: 8_192,
        input: ['text'],
        supportsFast: false,
        reasoningLevels: reasoningIds.map((r) => ({ id: r, label: r, requestValue: r })),
    }
}

function makeStreamingClient(
    responder: (req: ProtocolStreamInput, opts?: ProtocolStreamOptions) => string | Error,
): { client: ProtocolClient; calls: Array<{ req: ProtocolStreamInput; opts?: ProtocolStreamOptions }> } {
    const calls: Array<{ req: ProtocolStreamInput; opts?: ProtocolStreamOptions }> = []
    const client: ProtocolClient = {
        async *stream(req, opts): AsyncGenerator<AgentStreamEvent, void, void> {
            calls.push({ req, opts })
            const outcome = responder(req, opts)
            if (outcome instanceof Error) {
                throw outcome
            }
            yield { type: 'text-delta', contentIndex: 0, delta: outcome, partial: req.seed }
            yield { type: 'done', reason: 'stop', message: req.seed }
        },
    }
    return { client, calls }
}

function activateResourcesEntry(entry: any, registry: RendererRegistry): void {
    entry.activate({
        register: (contrib: any) => {
            if (contrib.kind === 'resource-provider') {
                registry.registerResourceProvider(contrib.value)
            }
        },
        getService: () => undefined,
    } as any)
}

describe('systemPromptEnhancer', () => {
    let bridge: FakeNativeBridge
    let registry: RendererRegistry

    beforeEach(() => {
        bridge = new FakeNativeBridge()
        registry = new RendererRegistry()
        activateResourcesEntry(resourcesAgentEntry, registry)
    })

    it('separates mutableCoreSystemPrompt from verbatimContextPrompt without <project_context> tags while keeping default snapshot.systemPrompt intact', async () => {
        bridge.setFile(`${AGENT}/AGENTS.md`, 'GLOBAL_RAW_<tag>&copy;')
        bridge.setFile(`${REPO}/AGENTS.md`, 'PROJECT_RAW_LINE_1\nPROJECT_RAW_LINE_2')
        bridge.setFile(`${AGENT}/APPEND_SYSTEM.md`, 'EXTRA_APPEND_RULE')

        registry.registerSystemPrompt({
            id: 'cpa.core.memories',
            content: '## Memory\n\nUse memories_search.',
            targetAgent: 'main',
            order: 15,
        })

        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            projectPaths: [REPO],
            agentDir: AGENT,
            homeDir: HOME,
            bridge,
            agentTarget: 'main',
            tools: [
                { name: 'read', description: 'Read files' },
                { name: 'bash', description: 'Run commands' },
                { name: 'title', description: 'Set title' },
                { name: 'spawn_agent', description: 'Spawn sub-agent' },
            ],
            language: 'zh-CN',
            gitSettings: {
                mergeMethod: 'merge',
                alwaysForcePush: false,
                createDraftPr: true,
            },
            extensionRegistry: registry,
        })

        // Backward compatibility: default systemPrompt preserves <project_context> XML wrapper
        expect(snapshot.systemPrompt).toContain('<project_context>')
        expect(snapshot.systemPrompt).toContain('<project_instructions')

        // mutableCoreSystemPrompt includes tools, append, plugin prompt, git, cwd, conditional title/subagent wording, and ZERO AGENTS.md content
        expect(snapshot.mutableCoreSystemPrompt).toContain('EXTRA_APPEND_RULE')
        expect(snapshot.mutableCoreSystemPrompt).toContain('Use memories_search.')
        expect(snapshot.mutableCoreSystemPrompt).toContain('Current working directory: /workspace/app')
        expect(snapshot.mutableCoreSystemPrompt).toContain('merge')
        expect(snapshot.mutableCoreSystemPrompt).toContain('Simplified Chinese')
        expect(snapshot.mutableCoreSystemPrompt).toMatch(/delegated sub-task|present in the declared tool set|only when/i)
        expect(snapshot.mutableCoreSystemPrompt).not.toContain('GLOBAL_RAW_<tag>')
        expect(snapshot.mutableCoreSystemPrompt).not.toContain('PROJECT_RAW_LINE_1')
        expect(snapshot.mutableCoreSystemPrompt).not.toContain('<project_context>')

        // verbatimContextPrompt preserves raw bytes unescaped and without XML wrapper
        expect(snapshot.verbatimContextPrompt).toBe('GLOBAL_RAW_<tag>&copy;\n\nPROJECT_RAW_LINE_1\nPROJECT_RAW_LINE_2')
    })

    it('resolveEnhancementModel respects modelSettings.enableAll=false and falls back to enabled default model', () => {
        const models = [
            makeModel('disabled-m'),
            makeModel('enabled-default'),
            makeModel('other-enabled'),
        ]
        const modelSettings = {
            enableAll: false,
            models: {
                'disabled-m': { enabled: false },
                'enabled-default': { enabled: true },
                'other-enabled': { enabled: true },
            },
            modelOrder: ['disabled-m', 'other-enabled', 'enabled-default'],
        }

        const resolved = resolveEnhancementModel(
            models,
            {
                enabled: true,
                multilingualEnabled: false,
                allowedLanguages: ['en'],
                modelId: 'disabled-m',
            },
            'enabled-default',
            modelSettings,
        )
        expect(resolved?.id).toBe('enabled-default')

        const allDisabled = resolveEnhancementModel(
            models,
            { enabled: true, multilingualEnabled: false, allowedLanguages: ['en'], modelId: '' },
            'enabled-default',
            {
                enableAll: false,
                models: {
                    'disabled-m': { enabled: false },
                    'enabled-default': { enabled: false },
                    'other-enabled': { enabled: false },
                },
                modelOrder: [],
            },
        )
        expect(allDisabled).toBeNull()
    })

    it('picks English when multilingualEnabled is false and samples from allowedLanguages when true', () => {
        expect(
            pickTargetPromptLanguage(
                {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['ja', 'de'],
                    modelId: '',
                },
                () => 0.9,
            ),
        ).toBe('en')

        expect(
            pickTargetPromptLanguage(
                {
                    enabled: true,
                    multilingualEnabled: true,
                    allowedLanguages: ['ja', 'de', 'es'],
                    modelId: '',
                },
                () => 0.5,
            ),
        ).toBe('de')
    })

    it('validateEnhancedCorePrompt strips outer fences and rejects residual fingerprints or missing tool names', () => {
        const badFence = validateEnhancedCorePrompt(
            '```markdown\nAvailable Tools:\n- read\n```',
            { requiredToolNames: ['read', 'bash'], requiredCwd: '/workspace/app' },
        )
        expect(badFence.ok).toBe(false)
        if (!badFence.ok) {
            expect(badFence.reasons.some((r) => r.includes('available tools:'))).toBe(true)
            expect(badFence.reasons.some((r) => r.includes('bash'))).toBe(true)
            expect(badFence.reasons.some((r) => r.includes('/workspace/app'))).toBe(true)
        }

        const good = validateEnhancedCorePrompt(
            '```markdown\nDu bist ein Entwicklungsassistent. Nutze read und bash im Pfad /workspace/app. Antworte auf Simplified Chinese.\n```',
            { requiredToolNames: ['read', 'bash'], requiredCwd: '/workspace/app' },
        )
        expect(good).toEqual({
            ok: true,
            cleaned: 'Du bist ein Entwicklungsassistent. Nutze read und bash im Pfad /workspace/app. Antworte auf Simplified Chinese.',
        })
    })

    it('strips outer markdown fences, retries with violation feedback on residual fingerprints, and appends verbatim AGENTS.md', async () => {
        let attempt = 0
        const { client, calls } = makeStreamingClient((req) => {
            attempt += 1
            if (attempt === 1) {
                return '```markdown\nAvailable tools:\n- read\n```'
            }
            // Retry prompt should include feedback about violations
            const reqText = JSON.stringify(req.entries)
            expect(reqText).toContain('bash')
            return '```\nNutze die Werkzeuge read und bash im Arbeitsverzeichnis /workspace/app und antworte auf Simplified Chinese.\n```'
        })

        const result = await synthesizeEnhancedSystemPrompt({
            client,
            model: makeModel('gpt-6-astra'),
            mutableCorePrompt: 'You are Coding Professional Agent (CPA). Available tools: read, bash. Current working directory: /workspace/app',
            verbatimContextPrompt: 'GLOBAL_RAW_<tag>\n\nPROJECT_RAW',
            enhancement: {
                enabled: true,
                multilingualEnabled: true,
                allowedLanguages: ['de'],
                modelId: 'gpt-6-astra',
            },
            requiredToolNames: ['read', 'bash'],
            requiredCwd: '/workspace/app',
            sleep: vi.fn(async () => undefined),
            generateId: () => `id-${Math.random()}`,
            now: () => 1000,
        })

        expect(calls).toHaveLength(2)
        expect(calls[0]?.opts?.connectionMode).toBe('isolated')
        expect(calls[0]?.req.tools).toEqual([])
        expect(result).toBe(
            'Nutze die Werkzeuge read und bash im Arbeitsverzeichnis /workspace/app und antworte auf Simplified Chinese.\n\nGLOBAL_RAW_<tag>\n\nPROJECT_RAW',
        )
    })

    it('fails closed with AgentPreflightError(system_prompt_enhancement_failed) after 3 failed attempts and never leaks mutableCorePrompt', async () => {
        const { client, calls } = makeStreamingClient(() => 'Rewritten <Skill_Names> read bash /workspace/app')

        await expect(
            synthesizeEnhancedSystemPrompt({
                client,
                model: makeModel('gpt-6-astra'),
                mutableCorePrompt: 'RAW_CORE_PROMPT',
                verbatimContextPrompt: 'RAW_AGENTS',
                enhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: 'gpt-6-astra',
                },
                requiredToolNames: ['read', 'bash'],
                requiredCwd: '/workspace/app',
                sleep: vi.fn(async () => undefined),
                generateId: () => 'cache-key',
                now: () => 1000,
            }),
        ).rejects.toMatchObject({
            name: 'AgentPreflightError',
            code: 'system_prompt_enhancement_failed',
        })

        expect(calls).toHaveLength(3)
        expect(new AgentPreflightError('system_prompt_enhancement_failed', 'failed').code).toBe(
            'system_prompt_enhancement_failed',
        )
    })

    it('rejects deformed/attributed XML fingerprint tags and substring tool collisions like thread matching read', () => {
        const withDeformedTag = validateEnhancedCorePrompt(
            'Use read in /workspace/app <Skill_Names > list skills',
            { requiredToolNames: ['read'], requiredCwd: '/workspace/app' },
        )
        expect(withDeformedTag.ok).toBe(false)

        const withAttributedTag = validateEnhancedCorePrompt(
            'Use read in /workspace/app <available_roles id="roles"> list',
            { requiredToolNames: ['read'], requiredCwd: '/workspace/app' },
        )
        expect(withAttributedTag.ok).toBe(false)

        const withRoleTag = validateEnhancedCorePrompt(
            'Use read in /workspace/app <Role>Reviewer</Role>',
            { requiredToolNames: ['read'], requiredCwd: '/workspace/app' },
        )
        expect(withRoleTag.ok).toBe(false)

        const withSubstringToolCollision = validateEnhancedCorePrompt(
            'Use thread execution in /workspace/app to inspect files thoroughly.',
            { requiredToolNames: ['read'], requiredCwd: '/workspace/app' },
        )
        expect(withSubstringToolCollision.ok).toBe(false)
    })

    it('rejects truncated (stopReason=length) or error/incomplete synthesis streams even when text-delta chunks arrived', async () => {
        const truncatedClient: ProtocolClient = {
            async *stream(req): AsyncGenerator<AgentStreamEvent, void, void> {
                yield {
                    type: 'text-delta',
                    contentIndex: 0,
                    delta: 'Use read and bash in /workspace/app ',
                    partial: req.seed,
                }
                yield {
                    type: 'done',
                    reason: 'length',
                    message: { ...req.seed, stopReason: 'length' },
                }
            },
        }

        await expect(
            synthesizeEnhancedSystemPrompt({
                client: truncatedClient,
                model: makeModel('gpt-6-astra'),
                mutableCorePrompt: 'CORE',
                verbatimContextPrompt: 'AGENTS',
                enhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: 'gpt-6-astra',
                },
                requiredToolNames: ['read', 'bash'],
                requiredCwd: '/workspace/app',
                sleep: vi.fn(async () => undefined),
                generateId: () => 'cache-key',
                now: () => 1000,
            }),
        ).rejects.toMatchObject({
            name: 'AgentPreflightError',
            code: 'system_prompt_enhancement_failed',
        })
    })
    it('rejects identifier-only output and retries with substance feedback before failing closed', async () => {
        const { client, calls } = makeStreamingClient(() => 'title read bash edit write /workspace/app')
        await expect(synthesizeEnhancedSystemPrompt({
            client, model: makeModel('builder'),
            mutableCorePrompt: 'Inspect files before editing. Preserve language rules and all safety constraints. '.repeat(20),
            verbatimContextPrompt: '',
            enhancement: { enabled: true, multilingualEnabled: false, allowedLanguages: ['en'], modelId: '' },
            requiredToolNames: ['title', 'read', 'bash', 'edit', 'write'], requiredCwd: '/workspace/app',
            sleep: async () => {},
        })).rejects.toMatchObject({ code: 'system_prompt_enhancement_failed' })
        expect(calls).toHaveLength(3)
        expect(JSON.stringify(calls[1]?.req.entries)).toMatch(/substance|too short/i)
    })

    it.each(['Guidelines:', '  GuIdElInEs :', '## Memory', '# MEMORY facts', ' ## Local Memory', '## retrieval', '## recording', '## using memory facts'])(
        'rejects template heading %s', (heading) => {
            expect(validateEnhancedCorePrompt(`${heading}\nInspect files with read before editing and preserve the requested reply language.`, {
                requiredToolNames: ['read'],
            }).ok).toBe(false)
        },
    )

    it.each(['error', 'abort', 'throw'] as const)('closes synthesis generator on %s before retry or cancellation', async (failure) => {
        const cleanup = vi.fn()
        const controller = new AbortController()
        const client: ProtocolClient = {
            async *stream(req) {
                try {
                    if (failure === 'abort') controller.abort()
                    if (failure === 'throw') throw new Error('transport failed')
                    yield { type: 'error', reason: 'error', error: { ...req.seed, errorMessage: 'upstream failed' } }
                } finally {
                    cleanup()
                }
            },
        }
        await expect(synthesizeEnhancedSystemPrompt({
            client, model: makeModel('builder'), mutableCorePrompt: 'source', verbatimContextPrompt: '',
            enhancement: { enabled: true, multilingualEnabled: false, allowedLanguages: ['en'], modelId: '' },
            requiredToolNames: [], signal: controller.signal,
            sleep: async () => { expect(cleanup).toHaveBeenCalled() },
        })).rejects.toMatchObject({ code: failure === 'abort' ? 'aborted' : 'system_prompt_enhancement_failed' })
        expect(cleanup).toHaveBeenCalledTimes(failure === 'abort' ? 1 : 3)
    })

    it('collects multi-block text-end streams without text-delta and prefers full finalEntry.content blocks', async () => {
        const multiBlockClient: ProtocolClient = {
            async *stream(req) {
                yield {
                    type: 'text-end',
                    contentIndex: 0,
                    content: 'Inspect files carefully before editing.',
                    partial: req.seed,
                }
                yield {
                    type: 'text-end',
                    contentIndex: 1,
                    content: ' Always use read and bash inside /workspace/app and reply in English.',
                    partial: req.seed,
                }
                yield {
                    type: 'done',
                    reason: 'stop',
                    message: { ...req.seed, stopReason: 'stop' },
                }
            },
        }

        const fromTextEnds = await synthesizeEnhancedSystemPrompt({
            client: multiBlockClient,
            model: makeModel('gpt-6-astra'),
            mutableCorePrompt: 'Use read and bash in /workspace/app.',
            verbatimContextPrompt: '',
            enhancement: {
                enabled: true,
                multilingualEnabled: false,
                allowedLanguages: ['en'],
                modelId: 'gpt-6-astra',
            },
            requiredToolNames: ['read', 'bash'],
            requiredCwd: '/workspace/app',
            sleep: vi.fn(async () => undefined),
            generateId: () => 'multi-end',
            now: () => 1000,
        })
        expect(fromTextEnds).toContain('Inspect files carefully before editing.')
        expect(fromTextEnds).toContain('/workspace/app')

        // Also prefer finalEntry.content when it contains additional blocks not present in deltas
        const finalEntryPreferredClient: ProtocolClient = {
            async *stream(req) {
                yield {
                    type: 'text-delta',
                    contentIndex: 0,
                    delta: 'Partial intro without required tools.',
                    partial: req.seed,
                }
                yield {
                    type: 'done',
                    reason: 'stop',
                    message: {
                        ...req.seed,
                        stopReason: 'stop',
                        content: [
                            { type: 'text', text: 'Full intro: ' },
                            { type: 'text', text: 'Use read and bash in /workspace/app carefully and accurately.' },
                        ],
                    },
                }
            },
        }

        const fromFinal = await synthesizeEnhancedSystemPrompt({
            client: finalEntryPreferredClient,
            model: makeModel('gpt-6-astra'),
            mutableCorePrompt: 'Use read and bash in /workspace/app.',
            verbatimContextPrompt: '',
            enhancement: {
                enabled: true,
                multilingualEnabled: false,
                allowedLanguages: ['en'],
                modelId: 'gpt-6-astra',
            },
            requiredToolNames: ['read', 'bash'],
            requiredCwd: '/workspace/app',
            sleep: vi.fn(async () => undefined),
            generateId: () => 'final-pref',
            now: () => 1000,
        })
        expect(fromFinal).toBe('Full intro: Use read and bash in /workspace/app carefully and accurately.')
    })

    it('enforces Code Mode Promise.all, tools., and text() identifiers when source prompt includes them with exec', async () => {
        const sourceWithExec = [
            'You are CPA.',
            'Available tools:',
            '- exec: Prefer one exec call with Promise.all whenever 2 or more eligible tool calls are needed. Await tools.<name>(input). Example: const [a, b] = await Promise.all([tools.tool_a({}), tools.tool_b({})]); text({ a, b });',
            'Current working directory: /workspace/app',
        ].join('\n')

        const missingPromiseAll = validateEnhancedCorePrompt(
            'Always run exec in /workspace/app using tools.read and return output via text(result). '.repeat(2),
            {
                requiredToolNames: ['exec'],
                requiredCwd: '/workspace/app',
                mutableCorePrompt: sourceWithExec,
            },
        )
        expect(missingPromiseAll.ok).toBe(false)
        if (!missingPromiseAll.ok) {
            expect(missingPromiseAll.reasons.some((r) => r.includes('Promise.all'))).toBe(true)
        }

        const missingToolsPrefix = validateEnhancedCorePrompt(
            'Always run exec in /workspace/app using Promise.all and return output via text(result). '.repeat(2),
            {
                requiredToolNames: ['exec'],
                requiredCwd: '/workspace/app',
                mutableCorePrompt: sourceWithExec,
            },
        )
        expect(missingToolsPrefix.ok).toBe(false)
        if (!missingToolsPrefix.ok) {
            expect(missingToolsPrefix.reasons.some((r) => r.includes('tools.<name>'))).toBe(true)
        }

        const missingTextCall = validateEnhancedCorePrompt(
            'Always run exec in /workspace/app with Promise.all([tools.read({ path: "a" })]). '.repeat(2),
            {
                requiredToolNames: ['exec'],
                requiredCwd: '/workspace/app',
                mutableCorePrompt: sourceWithExec,
            },
        )
        expect(missingTextCall.ok).toBe(false)
        if (!missingTextCall.ok) {
            expect(missingTextCall.reasons.some((r) => r.includes('text(...)'))).toBe(true)
        }

        const validCodeMode = validateEnhancedCorePrompt(
            'In /workspace/app, prioritize consolidating 2+ eligible tool calls into one exec call using Promise.all([tools.read({ path: "a" }), tools.bash({ command: "ls" })]) and emit results via text({ out }).',
            {
                requiredToolNames: ['exec'],
                requiredCwd: '/workspace/app',
                mutableCorePrompt: sourceWithExec,
            },
        )
        expect(validCodeMode.ok).toBe(true)
    })

    it('instructs builder model to prioritize parallel exec and retries if draft drops Promise.all', async () => {
        const capturedUserPrompts: string[] = []
        let callIndex = 0
        const client: ProtocolClient = {
            async *stream(input) {
                const firstEntry = input.entries[0]
                const userText =
                    firstEntry && 'content' in firstEntry && Array.isArray(firstEntry.content)
                        ? firstEntry.content.find((b) => b.type === 'text')
                        : undefined
                if (userText && userText.type === 'text') {
                    capturedUserPrompts.push(userText.text)
                }
                const draft =
                    callIndex++ === 0
                        ? 'Operate in /workspace/app using exec with tools.read and output via text(res). Prefer single calls.'
                        : 'Operate in /workspace/app: batch 2+ independent calls into one exec via Promise.all([tools.read({ path: "a" }), tools.bash({ command: "ls" })]) and output via text(res).'
                yield {
                    type: 'done',
                    reason: 'stop',
                    message: {
                        id: `m-${callIndex}`,
                        sessionId: 's',
                        createdAt: 1000,
                        kind: 'assistant',
                        model: 'gpt-6-astra',
                        content: [{ type: 'text', text: draft }],
                        status: 'done',
                        stopReason: 'stop',
                    },
                }
            },
        }

        const result = await synthesizeEnhancedSystemPrompt({
            client,
            model: makeModel('gpt-6-astra'),
            mutableCorePrompt:
                'Use exec in /workspace/app. Batch calls with Promise.all([tools.read({}), tools.bash({})]) and return via text(out).',
            verbatimContextPrompt: '',
            enhancement: {
                enabled: true,
                multilingualEnabled: false,
                allowedLanguages: ['en'],
                modelId: 'gpt-6-astra',
            },
            requiredToolNames: ['exec'],
            requiredCwd: '/workspace/app',
            sleep: vi.fn(async () => undefined),
            generateId: () => 'code-mode-synth',
            now: () => 1000,
        })

        expect(capturedUserPrompts).toHaveLength(2)
        expect(capturedUserPrompts[0]).toContain('Code Mode orchestration priority')
        expect(capturedUserPrompts[0]).toContain('Promise.all')
        expect(capturedUserPrompts[1]).toContain('Promise.all')
        expect(result).toContain('Promise.all')
    })

    it('retries code-only synthesis when a draft says update progress without explicit todo API operations', async () => {
        const capturedUserPrompts: string[] = []
        let callIndex = 0
        const client: ProtocolClient = {
            async *stream(input) {
                const firstEntry = input.entries[0]
                const userText =
                    firstEntry && 'content' in firstEntry && Array.isArray(firstEntry.content)
                        ? firstEntry.content.find((b) => b.type === 'text')
                        : undefined
                if (userText && userText.type === 'text') {
                    capturedUserPrompts.push(userText.text)
                }
                const draft =
                    callIndex++ === 0
                        ? 'In /workspace/app, batch calls in exec via Promise.all([tools.read({ path: "a" })]) and emit text(res). Proactively use tools.todo to plan tasks and update progress.'
                        : 'In /workspace/app, batch calls in exec via Promise.all([tools.read({ path: "a" })]) and emit text(res). Proactively use todo via tools.todo to plan tasks upfront and show live progress. Prefer operation: "update" with updates, add, or removeIds; reserve operation: "write" for initial plans or full restructuring.'
                yield {
                    type: 'done',
                    reason: 'stop',
                    message: {
                        id: `m-todo-${callIndex}`,
                        sessionId: 's',
                        createdAt: 1000,
                        kind: 'assistant',
                        model: 'gpt-6-astra',
                        content: [{ type: 'text', text: draft }],
                        status: 'done',
                        stopReason: 'stop',
                    },
                }
            },
        }

        const result = await synthesizeEnhancedSystemPrompt({
            client,
            model: makeModel('gpt-6-astra'),
            mutableCorePrompt:
                'Use exec in /workspace/app with Promise.all([tools.read({})]) and text(out). When todo is present (directly or via tools.todo in Code Mode), proactively plan tasks and show live progress. Prefer operation: "update" over operation: "write" for incremental changes.',
            verbatimContextPrompt: '',
            enhancement: {
                enabled: true,
                multilingualEnabled: false,
                allowedLanguages: ['en'],
                modelId: 'gpt-6-astra',
            },
            requiredToolNames: ['exec'],
            requiredCwd: '/workspace/app',
            sleep: vi.fn(async () => undefined),
            generateId: () => 'todo-code-only-synth',
            now: () => 1000,
        })

        expect(capturedUserPrompts).toHaveLength(2)
        expect(capturedUserPrompts[0]).toContain('Proactive `todo` task planning and live progress reporting preservation')
        expect(capturedUserPrompts[0]).toContain('incremental `operation: "update"` with `updates`, `add`, or `removeIds` over repeated full replacements')
        expect(capturedUserPrompts[0]).toContain('reserve `operation: "write"` for initial plan creation or full restructuring')
        expect(capturedUserPrompts[0]).toContain('Keep the verbatim API identifiers `write`, `update`, and `updates`')
        expect(capturedUserPrompts[1]).toContain('Missing required incremental todo update operation identifier: "update"')
        expect(capturedUserPrompts[1]).toContain('Missing required todo full-list replacement operation identifier: "write"')
        expect(capturedUserPrompts[1]).not.toContain('Missing required nested todo planning identifier: "todo"')
        expect(result).toContain('tools.todo')
        expect(result).toContain('Prefer operation: "update" with updates, add, or removeIds')
        expect(result).toContain('reserve operation: "write" for initial plans or full restructuring')
    })

    it.each([
        ['活用 todo。作業の進行中は `updates` で差分を反映し、初回や構成の変更には `write` を利用してください。', true],
        ['Usa todo para documentar el plan: operation: update en los cambios y operation: write al reemplazarlo por completo.', true],
        ['使用 todo 规划任务。增量改动采用「update」对应的 `updates` 参数，首次创建或重排才使用 "write"。', true],
        ['Use todo for planning and apply `update` for incremental changes; write the full list if planning changes.', false],
        ['Use tools.todo to share progress updates. Use the "write" tool for editing files.', false],
    ] as const)('validates multilingual API syntax without relying on English prose (%s)', (candidate, ok) => {
        const validation = validateEnhancedCorePrompt(candidate, {
            requiredToolNames: ['todo'], mutableCorePrompt: 'Use todo with operation: "update" for incremental changes.',
        })
        expect(validation.ok).toBe(ok)
    })

    it('enforces sub-agent context threshold policy preservation in synthesis prompt and validation', async () => {
        const sourceWithSubagentPolicy = [
            'You help users with spawn_agent and send_message in /workspace/app.',
            'When a sub-agent finishes and returns and a follow-up step needs a related sub-agent, check context_tokens and max_context_tokens: if context_tokens is less than 150,000 (150K) AND usage is less than 30%, MUST use send_message; if context_tokens exceeds 200,000 (200K) OR usage exceeds 75%, MUST use spawn_agent and MUST NOT use send_message.',
        ].join('\n')

        const missingThresholds = validateEnhancedCorePrompt(
            'Work in /workspace/app. Delegate with spawn_agent and continue related tasks using send_message based on context size when appropriate.',
            {
                requiredToolNames: ['spawn_agent', 'send_message'],
                requiredCwd: '/workspace/app',
                mutableCorePrompt: sourceWithSubagentPolicy,
            },
        )
        expect(missingThresholds.ok).toBe(false)
        if (!missingThresholds.ok) {
            expect(missingThresholds.reasons.some((r) => r.includes('150K'))).toBe(true)
            expect(missingThresholds.reasons.some((r) => r.includes('30%'))).toBe(true)
            expect(missingThresholds.reasons.some((r) => r.includes('200K'))).toBe(true)
            expect(missingThresholds.reasons.some((r) => r.includes('75%'))).toBe(true)
        }

        const falseSubstringThresholds = validateEnhancedCorePrompt(
            'Work in /workspace/app with spawn_agent and send_message. Unrelated metrics: 1150K, 150,000,000, 130%, 0.30%, 1200K, 200,000,000, 275%, 0.75%, 一百十五万, 百分之三十一, 一百二十万, 百分之七十五点五 must not satisfy threshold checks.',
            {
                requiredToolNames: ['spawn_agent', 'send_message'],
                requiredCwd: '/workspace/app',
                mutableCorePrompt: sourceWithSubagentPolicy,
            },
        )
        expect(falseSubstringThresholds.ok).toBe(false)
        if (!falseSubstringThresholds.ok) {
            expect(falseSubstringThresholds.reasons.some((r) => r.includes('150K'))).toBe(true)
            expect(falseSubstringThresholds.reasons.some((r) => r.includes('30%'))).toBe(true)
            expect(falseSubstringThresholds.reasons.some((r) => r.includes('200K'))).toBe(true)
            expect(falseSubstringThresholds.reasons.some((r) => r.includes('75%'))).toBe(true)
        }

        const localizedValid = validateEnhancedCorePrompt(
            '在 /workspace/app 协作时，当子代理执行完成返回后若后续需要相关子代理：上下文小于十五万且占用小于百分之三十时必须用 send_message；若超过二十万或占用大于百分之七十五则必须用 spawn_agent 派发新子代理且不得复用。',
            {
                requiredToolNames: ['spawn_agent', 'send_message'],
                requiredCwd: '/workspace/app',
                mutableCorePrompt: sourceWithSubagentPolicy,
            },
        )
        expect(localizedValid.ok).toBe(true)

        const capturedUserPrompts: string[] = []
        let callIndex = 0
        const client: ProtocolClient = {
            async *stream(input) {
                const firstEntry = input.entries[0]
                const userText =
                    firstEntry && 'content' in firstEntry && Array.isArray(firstEntry.content)
                        ? firstEntry.content.find((b) => b.type === 'text')
                        : undefined
                if (userText && userText.type === 'text') {
                    capturedUserPrompts.push(userText.text)
                }
                const draft =
                    callIndex++ === 0
                        ? 'Work in /workspace/app with spawn_agent and send_message. Reuse sub-agents when context is small and spawn new ones when large.'
                        : 'Work in /workspace/app with spawn_agent and send_message. After a sub-agent returns for related follow-up work: if context_tokens < 150,000 (150K) and < 30% of max_context_tokens, you MUST use send_message; if > 200,000 (200K) or > 75%, you MUST use spawn_agent and never send_message.'
                yield {
                    type: 'done',
                    reason: 'stop',
                    message: {
                        id: `m-sub-${callIndex}`,
                        sessionId: 's',
                        createdAt: 1000,
                        kind: 'assistant',
                        model: 'gpt-6-astra',
                        content: [{ type: 'text', text: draft }],
                        status: 'done',
                        stopReason: 'stop',
                    },
                }
            },
        }

        const result = await synthesizeEnhancedSystemPrompt({
            client,
            model: makeModel('gpt-6-astra'),
            mutableCorePrompt: sourceWithSubagentPolicy,
            verbatimContextPrompt: '',
            enhancement: {
                enabled: true,
                multilingualEnabled: false,
                allowedLanguages: ['en'],
                modelId: 'gpt-6-astra',
            },
            requiredToolNames: ['spawn_agent', 'send_message'],
            requiredCwd: '/workspace/app',
            sleep: vi.fn(async () => undefined),
            generateId: () => 'subagent-policy-synth',
            now: () => 1000,
        })

        expect(capturedUserPrompts).toHaveLength(2)
        expect(capturedUserPrompts[0]).toContain('Sub-agent context threshold reuse/respawn policy preservation')
        expect(capturedUserPrompts[0]).toContain('150K')
        expect(capturedUserPrompts[0]).toContain('30%')
        expect(capturedUserPrompts[0]).toContain('200K')
        expect(capturedUserPrompts[0]).toContain('75%')
        expect(capturedUserPrompts[1]).toContain('150K')
        expect(result).toContain('150,000')
        expect(result).toContain('75%')
    })

})
