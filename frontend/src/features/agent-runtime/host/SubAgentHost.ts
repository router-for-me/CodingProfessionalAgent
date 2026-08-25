/**
 * In-process sub-agent manager for the CPA Host Agent Runtime.
 * Spawns child AgentLoop runs, tracks inbox/stop, and coordinates session isolation.
 */

import {
    normalizeToolCallId,
    type AgentTool,
    type ConversationEntry,
    type ModelCatalogEntry,
    type SubAgentAppearance,
    type SubAgentIconId,
    type SubAgentRecord,
    type SubAgentStatus,
    type SubagentsSettings,
    type UserEntry,
} from '@cpa/plugin-api'
import { buildSystemPrompt } from '../context/systemPrompt'
import { formatWorktreeModePrompt } from '../context/worktreeMode'
import { HookProvider } from '../providers/HookProvider'
import { resolveDynamicReasoningEffort } from '../agent/agentLoop'

const DEFAULT_SUBAGENT_SETTINGS: SubagentsSettings = {
    enabled: true,
    concurrency: 10,
    maxPerSession: 3,
    maxDepth: 1,
}

export {
    normalizeToolCallId,
    type SubAgentAppearance,
    type SubAgentIconId,
    type SubAgentRecord,
    type SubAgentStatus,
    type SubagentsSettings,
}

export const SUBAGENT_APPEARANCES: readonly SubAgentAppearance[] = [
    { color: '#9b7dff', icon: 'sparkle' },
    { color: '#3dd68c', icon: 'atom' },
    { color: '#f778ba', icon: 'flower' },
    { color: '#8b7cff', icon: 'hexagon' },
    { color: '#f5c518', icon: 'sun' },
    { color: '#7c8cff', icon: 'orbit' },
    { color: '#63b3ed', icon: 'atom' },
    { color: '#f687b3', icon: 'flame' },
    { color: '#b794f4', icon: 'sparkle' },
    { color: '#68d391', icon: 'brain' },
    { color: '#f6ad55', icon: 'sun' },
    { color: '#fc8181', icon: 'hexagon' },
    { color: '#4fd1c5', icon: 'orbit' },
    { color: '#d6bcfa', icon: 'flower' },
    { color: '#90cdf4', icon: 'flame' },
    { color: '#9ae6b4', icon: 'atom' },
]

export function pickSubAgentAppearance(index: number): SubAgentAppearance {
    const normalizedIndex = Math.max(0, Math.floor(index))
    return SUBAGENT_APPEARANCES[normalizedIndex % SUBAGENT_APPEARANCES.length]!
}

export function normalizeAgentName(value: string | undefined): string {
    if (typeof value !== 'string') return ''
    return value
        .replace(/[\u0000-\u001F\u007F]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 32)
}

function makeUniqueAgentName(name: string, usedNames: ReadonlySet<string>): string {
    if (!usedNames.has(name)) return name
    let suffix = 2
    let candidate = `${name} ${suffix}`
    while (usedNames.has(candidate)) {
        suffix += 1
        candidate = `${name} ${suffix}`
    }
    return candidate
}

export function lastAssistantText(entries: readonly ConversationEntry[]): string {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i]
        if (!entry || entry.kind !== 'assistant') continue
        const text = entry.content
            .filter((block: any): block is { type: 'text'; text: string } => block.type === 'text')
            .map((block: any) => block.text)
            .join('')
            .trim()
        if (text.length > 0) {
            return text
        }
    }
    return ''
}

export function collectSpawnAgentToolCallIds(
    entries: readonly ConversationEntry[],
): Set<string> {
    const ids = new Set<string>()
    for (const entry of entries) {
        if (entry.kind !== 'assistant') continue
        for (const block of entry.content) {
            if ((block as any).type !== 'toolCall' || (block as any).name !== 'spawn_agent') {
                continue
            }
            ids.add((block as any).id)
            const normalized = normalizeToolCallId((block as any).id)
            if (normalized) ids.add(normalized)
        }
    }
    return ids
}

export function isLinkedSubAgent(
    agent: Pick<SubAgentRecord, 'parentToolCallId'>,
    keepToolCallIds: ReadonlySet<string>,
): boolean {
    const id = agent.parentToolCallId
    if (!id) return false
    if (keepToolCallIds.has(id)) return true
    return keepToolCallIds.has(normalizeToolCallId(id))
}

export function buildSubAgentSystemPrompt(
    prepared: any,
    codingTools: readonly AgentTool[],
    agentName: string,
    options?: {
        extensionRegistry?: any
        promptGuidelines?: readonly string[]
        allowSubagents?: boolean
    },
): string {
    const registry = options?.extensionRegistry
    const pluginPrompts = registry?.getSystemPrompts ? registry.getSystemPrompts('subagent') : []
    const pluginGuidelines = (pluginPrompts || [])
        .map((p: any) => p.guideline)
        .filter((g: any): g is string => typeof g === 'string' && g.trim().length > 0)
    const pluginContents = (pluginPrompts || [])
        .map((p: any) => p.content)
        .filter((c: any): c is string => typeof c === 'string' && c.trim().length > 0)

    const appendParts: string[] = []
    if (prepared?.snapshot?.appendSystem?.content) {
        appendParts.push(prepared.snapshot.appendSystem.content)
    }
    if (options?.allowSubagents) {
        appendParts.push(
            `You are a sub-agent named ${agentName}. Complete the assigned task thoroughly. ` +
                'When finished, provide a clear final answer. You may spawn child subagents if necessary.',
        )
    } else {
        appendParts.push(
            `You are a sub-agent named ${agentName}. Complete the assigned task thoroughly. ` +
                'When finished, provide a clear final answer. Do not spawn other agents.',
        )
    }
    for (const content of pluginContents) {
        appendParts.push(content)
    }

    const effectiveGuidelines = [
        ...(options?.promptGuidelines ?? []),
        ...pluginGuidelines,
    ]

    const systemPrompt = buildSystemPrompt({
        cwd: prepared?.projectCwd,
        tools: codingTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
        })),
        contextFiles: (prepared?.snapshot?.contextFiles ?? []).map((file: any) => ({
            path: file.path,
            content: file.content,
        })),
        customPrompt: prepared?.snapshot?.system?.content,
        appendSystemPrompt: appendParts.join('\n\n'),
        promptGuidelines: effectiveGuidelines,
        language: prepared?.language,
        personality: prepared?.personality,
    })

    return prepared?.worktreePolicy
        ? `${systemPrompt}\n${formatWorktreeModePrompt(prepared.worktreePolicy)}`
        : systemPrompt
}

export function isSubAgentToolName(name?: string): boolean {
    if (!name) return false
    return (
        name === 'spawn_agent' ||
        name === 'send_message' ||
        name === 'stop_agent' ||
        name === 'send_input'
    )
}

export function codingToolsOnly(tools: readonly AgentTool[]): AgentTool[] {
    return tools.filter(
        (tool) =>
            !isSubAgentToolName(tool.name) &&
            tool.name !== 'title' &&
            tool.name !== 'set_session_title' &&
            tool.targetAgent !== 'main',
    )
}

export interface SubAgentHostListener {
    onStateChange(agents: readonly SubAgentRecord[]): void
    onEvent?(event: any): void
    onUserEntry?(entry: UserEntry): void
}

export interface SubAgentRunRequest {
    agentId: string
    sessionId: string
    runId: string
    entries: readonly ConversationEntry[]
    userEntry: UserEntry
    model: ModelCatalogEntry
    reasoningEffort?: string
    speed?: 'standard' | 'fast' | string
    systemPrompt: string
    tools: readonly AgentTool[]
    signal: AbortSignal
    getRuntimeSettings?: () => {
        reasoningEffort?: string
        reasoningLevel?: string
        speed?: string
    } | undefined
}

export interface SubAgentHostConfig {
    prepared: any
    codingTools: readonly AgentTool[]
    allTools?: readonly AgentTool[]
    subagentsSettings?: SubagentsSettings
    models: readonly ModelCatalogEntry[]
    extensionRegistry?: any
    hookEngine?: any
    getEntries?: (sessionId: string) => Promise<ConversationEntry[]> | ConversationEntry[]
}

export interface SubAgentParentContext {
    sessionId: string
    runId: string
    getRuntimeSettings?: () => {
        reasoningEffort?: string
        reasoningLevel?: string
        speed?: string
    } | undefined
}

export interface SubAgentHostDependencies {
    generateId: () => string
    now: () => number
    run: (request: SubAgentRunRequest) => AsyncIterable<any>
}

interface ChildRuntime {
    controller: AbortController
    inbox: string[]
    entries: ConversationEntry[]
    running: boolean
    runChain: Promise<void>
}

function formatAgentResult(name: string, agentId: string, body: string): string {
    return `[sub-agent ${name} id=${agentId}]\n${body}`
}

function textResult(text: string, isError = false) {
    return {
        content: [{ type: 'text' as const, text }],
        isError,
    }
}

function cloneRecord(record: SubAgentRecord): SubAgentRecord {
    return { ...record }
}

const KNOWN_REASONING_EFFORTS: ReadonlySet<string> = new Set([
    'off',
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
])

/**
 * Parse a model spec which may be formatted as:
 * - "grok-4.6:xhigh" -> { modelId: "grok-4.6", reasoningEffort: "xhigh" }
 * - "grok-4.6" -> { modelId: "grok-4.6" }
 */
export function parseModelSpec(spec: string | undefined): {
    modelId?: string
    reasoningEffort?: string
} {
    if (!spec || typeof spec !== 'string') return {}
    const trimmed = spec.trim()
    if (!trimmed) return {}

    const colonIndex = trimmed.lastIndexOf(':')
    if (colonIndex > 0) {
        const modelId = trimmed.slice(0, colonIndex).trim()
        const reasoningEffort = trimmed.slice(colonIndex + 1).trim()
        if (
            modelId &&
            reasoningEffort &&
            KNOWN_REASONING_EFFORTS.has(reasoningEffort.toLowerCase())
        ) {
            return { modelId, reasoningEffort }
        }
    }

    return { modelId: trimmed }
}

/**
 * Resolve the reasoning effort a child model should send upstream.
 * An explicitly specified effort is matched first; if none or unmatched,
 * the preferred parent effort is checked; otherwise the child model's
 * first advertised level is used.
 */
export function resolveChildReasoning(
    model: ModelCatalogEntry,
    preferred?: string,
    fallbackPreferred?: string,
): string | undefined {
    const levels = model.reasoningLevels ?? []
    if (levels.length === 0) {
        return undefined
    }
    if (preferred) {
        const normalizedPreferred = preferred.toLowerCase()
        const match = levels.find(
            (option) =>
                option.requestValue?.toLowerCase() === normalizedPreferred ||
                option.id?.toLowerCase() === normalizedPreferred,
        )
        if (match) return match.requestValue ?? match.id
    }
    if (fallbackPreferred) {
        const normalizedFallback = fallbackPreferred.toLowerCase()
        const fallbackMatch = levels.find(
            (option) =>
                option.requestValue?.toLowerCase() === normalizedFallback ||
                option.id?.toLowerCase() === normalizedFallback,
        )
        if (fallbackMatch) return fallbackMatch.requestValue ?? fallbackMatch.id
    }
    return levels[0]?.requestValue ?? levels[0]?.id
}

export function resolveCatalogModel(
    models: readonly ModelCatalogEntry[],
    modelId: string | undefined,
    fallback: ModelCatalogEntry,
): ModelCatalogEntry {
    const raw = typeof modelId === 'string' ? modelId.trim() : ''
    if (!raw) return fallback

    const { modelId: parsedId } = parseModelSpec(raw)
    const requested = parsedId || raw

    const lowered = requested.toLowerCase()
    const match = models.find(
        (entry) =>
            entry.id === requested ||
            entry.id.toLowerCase() === lowered ||
            entry.label.toLowerCase() === lowered,
    )
    if (match) return match

    return {
        ...fallback,
        id: requested,
        label: requested,
    }
}

export class SubAgentHost {
    private readonly generateId: () => string
    private readonly now: () => number
    private readonly runChild: (request: SubAgentRunRequest) => AsyncIterable<any>

    private readonly agents = new Map<string, SubAgentRecord>()
    private readonly runtimes = new Map<string, ChildRuntime>()
    private readonly listeners = new Set<SubAgentHostListener>()
    private readonly slotWaiters: Array<{
        agentId: string
        parentSessionId: string
        createdAt: number
        signal?: AbortSignal
        resolve: () => void
        reject: (error: any) => void
    }> = []

    private config: SubAgentHostConfig | null = null
    private parent: SubAgentParentContext | null = null

    constructor(deps: SubAgentHostDependencies) {
        this.generateId = deps.generateId
        this.now = deps.now
        this.runChild = deps.run
    }

    private getLimits(): {
        enabled: boolean
        maxGlobal: number
        maxSession: number
        maxDepth: number
    } {
        const s = this.config?.subagentsSettings ?? DEFAULT_SUBAGENT_SETTINGS
        return {
            enabled: s.enabled ?? true,
            maxGlobal: typeof s.concurrency === 'number' && s.concurrency > 0 ? s.concurrency : 10,
            maxSession: typeof s.maxPerSession === 'number' && s.maxPerSession > 0 ? s.maxPerSession : 3,
            maxDepth: typeof s.maxDepth === 'number' && s.maxDepth > 0 ? s.maxDepth : 1,
        }
    }

    private getRunningCounts(parentSessionId: string): { runningGlobal: number; runningSession: number } {
        let runningGlobal = 0
        let runningSession = 0
        for (const record of this.agents.values()) {
            if (record.status === 'running') {
                runningGlobal += 1
                if (record.parentSessionId === parentSessionId) {
                    runningSession += 1
                }
            }
        }
        return { runningGlobal, runningSession }
    }

    private async waitForSlot(agentId: string, parentSessionId: string, signal?: AbortSignal): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const waiter = {
                agentId,
                parentSessionId,
                createdAt: this.agents.get(agentId)?.createdAt ?? this.now(),
                signal,
                resolve: () => {
                    this.patch(agentId, { status: 'running' })
                    resolve()
                },
                reject,
            }

            if (signal) {
                const onAbort = () => {
                    const idx = this.slotWaiters.indexOf(waiter)
                    if (idx !== -1) {
                        this.slotWaiters.splice(idx, 1)
                    }
                    this.patch(agentId, { status: 'aborted', completedAt: this.now() })
                    reject(new Error('Subagent aborted while queued'))
                }
                if (signal.aborted) {
                    onAbort()
                    return
                }
                signal.addEventListener('abort', onAbort, { once: true })
            }

            this.slotWaiters.push(waiter)
            this.slotWaiters.sort((a, b) => a.createdAt - b.createdAt)
        })
    }

    private drainQueue(): void {
        if (this.slotWaiters.length === 0) return
        const { maxGlobal, maxSession } = this.getLimits()

        // Clean up any aborted waiters
        for (let i = this.slotWaiters.length - 1; i >= 0; i--) {
            const waiter = this.slotWaiters[i]!
            if (waiter.signal?.aborted) {
                this.slotWaiters.splice(i, 1)
                this.patch(waiter.agentId, { status: 'aborted', completedAt: this.now() })
            }
        }

        this.slotWaiters.sort((a, b) => a.createdAt - b.createdAt)

        let i = 0
        while (i < this.slotWaiters.length) {
            const candidate = this.slotWaiters[i]!
            const { runningGlobal, runningSession } = this.getRunningCounts(candidate.parentSessionId)
            if (runningGlobal < maxGlobal && runningSession < maxSession) {
                this.slotWaiters.splice(i, 1)
                candidate.resolve()
            } else {
                i++
            }
        }
    }

    configure(config: SubAgentHostConfig): void {
        this.config = config
    }

    setParentContext(parent: SubAgentParentContext | null): void {
        this.parent = parent
    }

    subscribe(listener: SubAgentHostListener): () => void {
        this.listeners.add(listener)
        listener.onStateChange(this.list())
        return () => {
            this.listeners.delete(listener)
        }
    }

    list(parentSessionId?: string): SubAgentRecord[] {
        const records = [...this.agents.values()].map(cloneRecord)
        if (!parentSessionId) return records
        return records.filter((agent) => agent.parentSessionId === parentSessionId)
    }

    get(agentId: string): SubAgentRecord | undefined {
        const record = this.agents.get(agentId)
        return record ? cloneRecord(record) : undefined
    }

    hydrate(records: readonly SubAgentRecord[]): void {
        const activeAgents = new Map<string, SubAgentRecord>()
        for (const [id, agent] of this.agents) {
            if (
                this.runtimes.get(id)?.running ||
                agent.status === 'running' ||
                agent.status === 'queued'
            ) {
                activeAgents.set(id, agent)
            }
        }
        this.agents.clear()
        for (const record of records) {
            if (!record?.id) continue
            const active = activeAgents.get(record.id)
            if (active) {
                this.agents.set(record.id, active)
                continue
            }
            this.agents.set(record.id, {
                ...record,
                status: record.status,
            })
        }
        for (const [id, active] of activeAgents) {
            if (!this.agents.has(id)) {
                this.agents.set(id, active)
            }
        }
        this.emitState()
    }

    removeUnlinkedForParent(
        parentSessionId: string,
        keptEntries: readonly ConversationEntry[],
    ): SubAgentRecord[] {
        const keepIds = collectSpawnAgentToolCallIds(keptEntries)
        const removed: SubAgentRecord[] = []
        for (const record of [...this.agents.values()]) {
            if (record.parentSessionId !== parentSessionId) continue
            if (isLinkedSubAgent(record, keepIds)) continue
            this.teardownRuntime(record.id)
            this.agents.delete(record.id)
            removed.push(cloneRecord(record))
        }
        if (removed.length > 0) this.emitState()
        return removed
    }

    async spawn(
        prompt: string,
        options: {
            name?: string
            toolCallId?: string
            parentSessionId?: string
            callerAgentId?: string
            modelId?: string
            reasoningEffort?: string
            signal?: AbortSignal
            onUpdate?: (partial: {
                content: { type: 'text'; text: string }[]
                details?: unknown
                isError?: boolean
            }) => void
        } = {},
    ): Promise<ReturnType<typeof textResult>> {
        const trimmed = prompt.trim()
        if (!trimmed) {
            return textResult('spawn_agent requires a non-empty prompt', true)
        }
        const requestedName = normalizeAgentName(options.name)
        if (!requestedName) {
            return textResult('spawn_agent requires a non-empty name', true)
        }
        const prepared = this.config?.prepared
        const rawParentSessionId = options.parentSessionId ?? this.parent?.sessionId
        if (!prepared || !rawParentSessionId) {
            return textResult('No active parent session to spawn a sub-agent', true)
        }

        const { enabled, maxGlobal, maxSession, maxDepth } = this.getLimits()
        if (!enabled) {
            return textResult('Subagents are disabled in settings', true)
        }

        // Determine depth & parent agent
        const parentAgent = options.callerAgentId
            ? this.agents.get(options.callerAgentId)
            : this.agents.get(rawParentSessionId)
        const parentDepth = parentAgent?.depth ?? 0
        if (parentDepth >= maxDepth) {
            return textResult(`Subagent max depth of ${maxDepth} reached; nested subagents are not permitted`, true)
        }
        const depth = parentDepth + 1
        const parentSessionId = parentAgent?.parentSessionId ?? rawParentSessionId

        // Reuse existing sub-agent when replaying/resuming a tool call for this parent session
        const targetToolCallId = options.toolCallId
        const existingAgent = targetToolCallId
            ? [...this.agents.values()].find(
                  (agent) =>
                      agent.parentSessionId === parentSessionId &&
                      (agent.parentToolCallId === targetToolCallId ||
                          (agent.parentToolCallId &&
                              normalizeToolCallId(agent.parentToolCallId) ===
                                  normalizeToolCallId(targetToolCallId))),
              )
            : undefined

        if (existingAgent) {
            const existingId = existingAgent.id
            const existingName = existingAgent.name
            const runtime = this.runtimes.get(existingId)
            if (runtime?.running) {
                await runtime.runChain
                const final = this.agents.get(existingId)
                const last = final?.lastMessage?.trim() ?? ''
                return textResult(
                    formatAgentResult(
                        existingName,
                        existingId,
                        last.length > 0 ? last : `${existingName} completed`,
                    ),
                    final?.status === 'error' || final?.status === 'aborted',
                )
            }
            if (existingAgent.status === 'completed' && existingAgent.lastMessage) {
                return textResult(
                    formatAgentResult(
                        existingName,
                        existingId,
                        existingAgent.lastMessage,
                    ),
                )
            }

            options.onUpdate?.({
                content: [{ type: 'text', text: `${existingName} resumed` }],
                details: {
                    agentId: existingId,
                    name: existingName,
                    color: existingAgent.color,
                    icon: existingAgent.icon,
                    status: 'running',
                },
            })

            let childEntries: ConversationEntry[] = []
            if (this.config?.getEntries) {
                try {
                    const loaded = await this.config.getEntries(existingAgent.sessionId)
                    if (Array.isArray(loaded)) {
                        childEntries = loaded
                    }
                } catch {
                    // ignore
                }
            }

            return this.resumeSubAgent(existingId, {
                signal: options.signal,
                entries: childEntries.length > 0 ? childEntries : undefined,
                initialPrompt: trimmed,
                onUpdate: options.onUpdate,
            })
        }

        const usedNames = new Set(
            [...this.agents.values()]
                .filter((agent) => agent.parentSessionId === parentSessionId)
                .map((agent) => agent.name),
        )
        const name = makeUniqueAgentName(requestedName, usedNames)
        const appearance = pickSubAgentAppearance(usedNames.size)
        const id = this.generateId()
        const { modelId: parsedModelId, reasoningEffort: parsedEffort } = parseModelSpec(options.modelId)
        const explicitEffort = options.reasoningEffort ?? parsedEffort
        const model = this.resolveModel(parsedModelId || options.modelId)
        const dynamicParentEffort = resolveDynamicReasoningEffort(
            prepared.reasoningEffort,
            prepared.model,
            this.parent?.getRuntimeSettings,
        )
        const reasoningEffort = resolveChildReasoning(
            model,
            explicitEffort,
            dynamicParentEffort,
        )

        const { runningGlobal, runningSession } = this.getRunningCounts(parentSessionId)
        const isOverLimit =
            runningGlobal >= maxGlobal ||
            runningSession >= maxSession ||
            this.slotWaiters.length > 0

        const record: SubAgentRecord = {
            id,
            name,
            color: appearance.color,
            icon: appearance.icon,
            parentSessionId,
            sessionId: id,
            modelId: model.id,
            reasoningEffort,
            status: isOverLimit ? 'queued' : 'running',
            depth,
            parentAgentId: parentAgent?.id,
            createdAt: this.now(),
            updatedAt: this.now(),
            parentToolCallId: options.toolCallId,
        }
        this.agents.set(id, record)
        this.emitState()

        if (isOverLimit) {
            options.onUpdate?.({
                content: [{ type: 'text', text: `${name} queued` }],
                details: {
                    agentId: id,
                    name,
                    color: appearance.color,
                    icon: appearance.icon,
                    status: 'queued',
                },
            })
            try {
                await this.waitForSlot(id, parentSessionId, options.signal)
            } catch (waitError) {
                this.drainQueue()
                return textResult(errorMessageOf(waitError), true)
            }
        }

        options.onUpdate?.({
            content: [{ type: 'text', text: `${name} started` }],
            details: {
                agentId: id,
                name,
                color: appearance.color,
                icon: appearance.icon,
                status: 'running',
            },
        })

        const userEntry = this.makeUserEntry(id, trimmed)
        this.emitUserEntry(userEntry)

        const startOutcome = await HookProvider.execute(
            'SubagentStart',
            {
                event: 'SubagentStart',
                sessionId: parentSessionId,
                payload: {
                    hook_event_name: 'SubagentStart',
                    session_id: parentSessionId,
                    cwd: prepared.projectCwd ?? '',
                    model: model.id,
                    permission_mode: 'default',
                    agent_id: id,
                    agent_type: name,
                    subagent_id: id,
                    name,
                },
                signal: options.signal,
            },
            {
                hooks: prepared?.generationSnapshot?.hooks,
                extensionRegistry: this.config?.extensionRegistry,
            },
        )
        if (!startOutcome.continue) {
            this.patch(id, {
                status: 'error',
                errorMessage:
                    startOutcome.stopReason ?? 'Subagent blocked by hook',
            })
            return textResult(
                startOutcome.stopReason ?? 'Subagent blocked by hook',
                true,
            )
        }

        try {
            await this.runUntilIdle(id, userEntry, options.signal)
        } catch (error) {
            this.patch(id, {
                status: 'error',
                errorMessage: errorMessageOf(error),
            })
            await HookProvider.execute(
                'SubagentStop',
                {
                    event: 'SubagentStop',
                    sessionId: parentSessionId,
                    payload: {
                        hook_event_name: 'SubagentStop',
                        session_id: parentSessionId,
                        cwd: prepared.projectCwd ?? '',
                        model: model.id,
                        permission_mode: 'default',
                        agent_id: id,
                        agent_type: name,
                        subagent_id: id,
                        name,
                        reason: 'error',
                    },
                    signal: options.signal,
                },
                {
                    hooks: prepared?.generationSnapshot?.hooks,
                    extensionRegistry: this.config?.extensionRegistry,
                },
            )
            return textResult(errorMessageOf(error), true)
        } finally {
            this.drainQueue()
        }

        const final = this.agents.get(id)
        await HookProvider.execute(
            'SubagentStop',
            {
                event: 'SubagentStop',
                sessionId: parentSessionId,
                payload: {
                    hook_event_name: 'SubagentStop',
                    session_id: parentSessionId,
                    cwd: prepared.projectCwd ?? '',
                    model: model.id,
                    permission_mode: 'default',
                    agent_id: id,
                    agent_type: name,
                    subagent_id: id,
                    name,
                    reason: final?.status ?? 'completed',
                },
                signal: options.signal,
            },
            {
                hooks: prepared?.generationSnapshot?.hooks,
                extensionRegistry: this.config?.extensionRegistry,
            },
        )
        const last = final?.lastMessage?.trim() ?? ''
        if (final?.status === 'aborted') {
            return textResult(
                formatAgentResult(
                    name,
                    id,
                    last.length > 0 ? last : `${name} was stopped`,
                ),
                true,
            )
        }
        if (final?.status === 'error') {
            return textResult(
                formatAgentResult(
                    name,
                    id,
                    last.length > 0
                        ? last
                        : (final.errorMessage ?? `${name} failed`),
                ),
                true,
            )
        }
        return textResult(
            formatAgentResult(
                name,
                id,
                last.length > 0 ? last : `${name} finished without a text reply`,
            ),
        )
    }

    async sendMessage(
        agentId: string,
        message: string,
        signal?: AbortSignal,
    ): Promise<ReturnType<typeof textResult>> {
        const trimmed = message.trim()
        if (!trimmed) {
            return textResult('send_message requires a non-empty message', true)
        }
        const record = this.agents.get(agentId)
        if (!record) {
            return textResult(`Unknown sub-agent: ${agentId}`, true)
        }
        const runtime = this.runtimes.get(agentId)
        if (runtime?.running) {
            runtime.inbox.push(trimmed)
            return textResult(`Message sent to ${record.name}`)
        }

        const userEntry = this.makeUserEntry(record.sessionId, trimmed)
        this.emitUserEntry(userEntry)
        try {
            await this.runUntilIdle(agentId, userEntry, signal)
        } catch (error) {
            this.patch(agentId, {
                status: 'error',
                errorMessage: errorMessageOf(error),
            })
            return textResult(errorMessageOf(error), true)
        }
        const final = this.agents.get(agentId)
        const last = final?.lastMessage?.trim() ?? ''
        if (final?.status === 'aborted') {
            return textResult(
                formatAgentResult(
                    record.name,
                    agentId,
                    last.length > 0 ? last : `${record.name} was stopped`,
                ),
                true,
            )
        }
        return textResult(
            formatAgentResult(
                record.name,
                agentId,
                last.length > 0
                    ? last
                    : `${record.name} finished without a text reply`,
            ),
        )
    }

    stop(agentId: string): ReturnType<typeof textResult> {
        const record = this.agents.get(agentId)
        if (!record) {
            return textResult(`Unknown sub-agent: ${agentId}`, true)
        }
        const waiterIdx = this.slotWaiters.findIndex((w) => w.agentId === agentId)
        if (waiterIdx !== -1) {
            const waiter = this.slotWaiters.splice(waiterIdx, 1)[0]!
            this.patch(agentId, { status: 'aborted', completedAt: this.now() })
            waiter.reject(new Error('Subagent stopped'))
            this.drainQueue()
            return textResult(`Stopped ${record.name}`)
        }
        const runtime = this.runtimes.get(agentId)
        if (runtime?.running) {
            runtime.inbox.length = 0
            runtime.controller.abort()
        }
        if (record.status === 'running' || record.status === 'queued') {
            this.patch(agentId, { status: 'aborted', completedAt: this.now() })
            this.drainQueue()
            return textResult(`Stopped ${record.name}`)
        }
        if (!runtime?.running) {
            return textResult(`${record.name} is not running`)
        }
        this.patch(agentId, { status: 'aborted', completedAt: this.now() })
        this.drainQueue()
        return textResult(`Stopped ${record.name}`)
    }

    stopAgent(agentId: string): ReturnType<typeof textResult> {
        return this.stop(agentId)
    }

    abortAllForParent(parentSessionId: string): void {
        for (let i = this.slotWaiters.length - 1; i >= 0; i--) {
            const waiter = this.slotWaiters[i]!
            if (waiter.parentSessionId === parentSessionId) {
                this.slotWaiters.splice(i, 1)
                this.patch(waiter.agentId, { status: 'aborted', completedAt: this.now() })
                waiter.reject(new Error('Subagent aborted'))
            }
        }
        for (const record of this.agents.values()) {
            if (record.parentSessionId !== parentSessionId) continue
            const runtime = this.runtimes.get(record.id)
            if (runtime?.running) {
                runtime.inbox.length = 0
                runtime.controller.abort()
            }
            if (record.status === 'running' || record.status === 'queued') {
                this.patch(record.id, { status: 'aborted', completedAt: this.now() })
            }
        }
        this.drainQueue()
    }

    abortAll(): void {
        for (let i = this.slotWaiters.length - 1; i >= 0; i--) {
            const waiter = this.slotWaiters[i]!
            this.slotWaiters.splice(i, 1)
            this.patch(waiter.agentId, { status: 'aborted', completedAt: this.now() })
            waiter.reject(new Error('Subagent aborted'))
        }
        for (const record of this.agents.values()) {
            const runtime = this.runtimes.get(record.id)
            if (runtime?.running) {
                runtime.inbox.length = 0
                runtime.controller.abort()
            }
            if (record.status === 'running' || record.status === 'queued') {
                this.patch(record.id, { status: 'aborted', completedAt: this.now() })
            }
        }
        this.drainQueue()
    }

    async resumeSubAgent(
        agentId: string,
        options: {
            signal?: AbortSignal
            entries?: readonly ConversationEntry[]
            initialPrompt?: string
            onUpdate?: (partial: {
                content: { type: 'text'; text: string }[]
                details?: unknown
                isError?: boolean
            }) => void
        } = {},
    ): Promise<ReturnType<typeof textResult>> {
        const record = this.agents.get(agentId)
        if (!record) {
            return textResult(`Unknown sub-agent: ${agentId}`, true)
        }
        const existing = this.runtimes.get(agentId)
        if (existing?.running) {
            await existing.runChain
            const final = this.agents.get(agentId)
            const last = final?.lastMessage?.trim() ?? ''
            return textResult(
                formatAgentResult(
                    record.name,
                    agentId,
                    last.length > 0 ? last : `${record.name} completed`,
                ),
                final?.status === 'error' || final?.status === 'aborted',
            )
        }

        let entries: ConversationEntry[] = options.entries ? [...options.entries] : []
        if (entries.length === 0 && this.config?.getEntries) {
            try {
                const loaded = await this.config.getEntries(record.sessionId)
                if (Array.isArray(loaded)) {
                    entries = [...loaded]
                }
            } catch {
                // ignore
            }
        }

        let userEntry = entries.find((e): e is UserEntry => e.kind === 'user')
        if (!userEntry) {
            if (options.initialPrompt) {
                userEntry = this.makeUserEntry(record.sessionId, options.initialPrompt)
                this.emitUserEntry(userEntry)
                entries.push(userEntry)
            } else {
                this.patch(agentId, { status: 'completed' })
                return textResult(`Sub-agent ${record.name} has no user prompt to resume`)
            }
        }

        const controller = new AbortController()
        const unlink = linkAbortSignals(options.signal, controller)
        const runtime: ChildRuntime = {
            controller,
            inbox: [],
            entries: entries,
            running: true,
            runChain: Promise.resolve(),
        }
        this.runtimes.set(agentId, runtime)

        const now = this.now()
        let pauseDelta = 0
        if (record.status !== 'running') {
            const stopTimestamp =
                typeof record.completedAt === 'number' && Number.isFinite(record.completedAt)
                    ? record.completedAt
                    : record.updatedAt
            pauseDelta = Math.max(0, now - stopTimestamp)
        }
        const currentPaused =
            typeof record.pausedMs === 'number' && Number.isFinite(record.pausedMs) && record.pausedMs > 0
                ? record.pausedMs
                : 0
        const nextPausedMs = currentPaused + pauseDelta

        this.patch(agentId, {
            status: 'running',
            completedAt: undefined,
            ...(nextPausedMs > 0 ? { pausedMs: nextPausedMs } : {}),
        })

        const work = (async () => {
            let nextUser: UserEntry | undefined = userEntry
            try {
                while (nextUser && !controller.signal.aborted) {
                    await this.runOneTurn(agentId, runtime, nextUser)
                    const queued = runtime.inbox.shift()
                    nextUser = queued
                        ? this.makeUserEntry(this.agents.get(agentId)?.sessionId ?? agentId, queued)
                        : undefined
                    if (nextUser) {
                        this.emitUserEntry(nextUser)
                    }
                }
                if (controller.signal.aborted) {
                    this.patch(agentId, { status: 'aborted', completedAt: this.now() })
                } else {
                    this.patch(agentId, { status: 'completed', completedAt: this.now() })
                }
            } catch (error) {
                if (controller.signal.aborted || isAbortError(error)) {
                    this.patch(agentId, { status: 'aborted', completedAt: this.now() })
                    return
                }
                this.patch(agentId, {
                    status: 'error',
                    errorMessage: errorMessageOf(error),
                    completedAt: this.now(),
                })
                throw error
            } finally {
                unlink()
                runtime.running = false
            }
        })()

        runtime.runChain = work
        try {
            await work
        } catch (error) {
            return textResult(errorMessageOf(error), true)
        } finally {
            this.drainQueue()
        }

        const final = this.agents.get(agentId)
        const last = final?.lastMessage?.trim() ?? ''
        if (final?.status === 'aborted') {
            return textResult(
                formatAgentResult(
                    record.name,
                    agentId,
                    last.length > 0 ? last : `${record.name} was stopped`,
                ),
                true,
            )
        }
        if (final?.status === 'error') {
            return textResult(
                formatAgentResult(
                    record.name,
                    agentId,
                    last.length > 0
                        ? last
                        : (final.errorMessage ?? `${record.name} failed`),
                ),
                true,
            )
        }
        return textResult(
            formatAgentResult(
                record.name,
                agentId,
                last.length > 0 ? last : `${record.name} completed`,
            ),
        )
    }

    private teardownRuntime(agentId: string): void {
        const runtime = this.runtimes.get(agentId)
        if (runtime?.running) {
            runtime.inbox.length = 0
            runtime.controller.abort()
        }
        this.runtimes.delete(agentId)
    }

    private isTrackedSession(sessionId: string): boolean {
        if (this.agents.has(sessionId)) return true
        for (const record of this.agents.values()) {
            if (record.sessionId === sessionId) return true
        }
        return false
    }

    private async runUntilIdle(
        agentId: string,
        firstUser: UserEntry,
        outerSignal?: AbortSignal,
    ): Promise<void> {
        const existing = this.runtimes.get(agentId)
        if (existing?.running) {
            existing.inbox.push(userText(firstUser))
            await existing.runChain
            return
        }

        const controller = new AbortController()
        const unlink = linkAbortSignals(outerSignal, controller)
        const runtime: ChildRuntime = {
            controller,
            inbox: [],
            entries: this.runtimes.get(agentId)?.entries.slice() ?? [],
            running: true,
            runChain: Promise.resolve(),
        }
        this.runtimes.set(agentId, runtime)
        this.patch(agentId, { status: 'running' })

        const work = (async () => {
            let nextUser: UserEntry | undefined = firstUser
            try {
                while (nextUser && !controller.signal.aborted) {
                    await this.runOneTurn(agentId, runtime, nextUser)
                    const queued = runtime.inbox.shift()
                    nextUser = queued
                        ? this.makeUserEntry(this.agents.get(agentId)?.sessionId ?? agentId, queued)
                        : undefined
                    if (nextUser) {
                        this.emitUserEntry(nextUser)
                    }
                }
                if (controller.signal.aborted) {
                    this.patch(agentId, { status: 'aborted', completedAt: this.now() })
                } else {
                    this.patch(agentId, { status: 'completed', completedAt: this.now() })
                }
            } catch (error) {
                if (controller.signal.aborted || isAbortError(error)) {
                    this.patch(agentId, { status: 'aborted', completedAt: this.now() })
                    return
                }
                this.patch(agentId, {
                    status: 'error',
                    errorMessage: errorMessageOf(error),
                    completedAt: this.now(),
                })
                throw error
            } finally {
                unlink()
                runtime.running = false
            }
        })()

        runtime.runChain = work
        await work
    }

    private async runOneTurn(
        agentId: string,
        runtime: ChildRuntime,
        userEntry: UserEntry,
    ): Promise<void> {
        const record = this.agents.get(agentId)
        const config = this.config
        if (!record || !config) {
            throw new Error('Sub-agent runtime is not configured')
        }
        const model = this.resolveModel(record.modelId)
        const { enabled, maxDepth } = this.getLimits()
        const currentDepth = record.depth ?? 1
        const canSpawnChildren = enabled && currentDepth < maxDepth

        const effectiveTools = canSpawnChildren
            ? (config.allTools && config.allTools.length > 0 ? config.allTools : config.codingTools)
            : codingToolsOnly(config.codingTools)

        const request: SubAgentRunRequest = {
            agentId,
            sessionId: record.sessionId,
            runId: this.generateId(),
            entries: runtime.entries.slice(),
            userEntry,
            model,
            reasoningEffort: record.reasoningEffort,
            speed: config.prepared.speed,
            systemPrompt: buildSubAgentSystemPrompt(
                config.prepared,
                effectiveTools,
                record.name,
                {
                    extensionRegistry: config.extensionRegistry,
                    allowSubagents: canSpawnChildren,
                },
            ),
            tools: effectiveTools,
            signal: runtime.controller.signal,
            // Sub-agents are strictly controlled by the parent agent's parameters,
            // and must not be overridden by the user UI's dynamic runtime settings.
        }

        for await (const event of this.runChild(request)) {
            this.emitEvent(event)
            if (event.type === 'assistant-end') {
                runtime.entries = upsertEntry(runtime.entries, event.entry)
            }
            if (event.type === 'agent-end' && event.entries) {
                runtime.entries = event.entries.map((entry: any) => ({ ...entry }))
            }
        }

        const last = lastAssistantText(runtime.entries)
        this.patch(agentId, {
            lastMessage: last.length > 0 ? last : undefined,
        })
    }

    private resolveModel(modelId?: string): ModelCatalogEntry {
        const config = this.config
        if (!config) {
            throw new Error('Sub-agent runtime is not configured')
        }
        return resolveCatalogModel(config.models, modelId, config.prepared.model)
    }

    private makeUserEntry(sessionId: string, text: string): UserEntry {
        return {
            id: this.generateId(),
            sessionId,
            createdAt: this.now(),
            kind: 'user',
            content: [{ type: 'text', text }],
        }
    }

    private patch(
        agentId: string,
        patch: Partial<Pick<SubAgentRecord, 'status' | 'lastMessage' | 'errorMessage' | 'completedAt' | 'pausedMs'>>,
    ): void {
        const current = this.agents.get(agentId)
        if (!current) return
        const next: SubAgentRecord = {
            ...current,
            ...patch,
            updatedAt: this.now(),
        }
        if (patch.completedAt === undefined && 'completedAt' in patch) {
            delete next.completedAt
        }
        this.agents.set(agentId, next)
        this.emitState()
    }

    private emitState(): void {
        const snapshot = this.list()
        for (const listener of this.listeners) {
            listener.onStateChange(snapshot)
        }
    }

    private emitEvent(event: any): void {
        if (!this.isTrackedSession(event.sessionId)) return
        for (const listener of this.listeners) {
            listener.onEvent?.(event)
        }
    }

    private emitUserEntry(entry: UserEntry): void {
        if (!this.isTrackedSession(entry.sessionId)) return
        for (const listener of this.listeners) {
            listener.onUserEntry?.(entry)
        }
    }
}

function userText(entry: UserEntry): string {
    return entry.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('')
}

function upsertEntry(
    entries: ConversationEntry[],
    entry: ConversationEntry,
): ConversationEntry[] {
    const index = entries.findIndex((item) => item.id === entry.id)
    if (index === -1) {
        return [...entries, entry]
    }
    const next = entries.slice()
    next[index] = entry
    return next
}

function errorMessageOf(error: unknown): string {
    if (error instanceof Error && error.message) return error.message
    return String(error ?? 'sub-agent error')
}

function linkAbortSignals(
    outer: AbortSignal | undefined,
    inner: AbortController,
): () => void {
    if (!outer) return () => {}
    if (outer.aborted) {
        inner.abort()
        return () => {}
    }
    const onAbort = (): void => {
        inner.abort()
    }
    outer.addEventListener('abort', onAbort)
    return () => {
        outer.removeEventListener('abort', onAbort)
    }
}

function isAbortError(error: unknown): boolean {
    if (!error) return false
    if (error instanceof DOMException && error.name === 'AbortError') return true
    if (error instanceof Error) {
        return error.name === 'AbortError' || /abort/i.test(error.message)
    }
    return false
}
