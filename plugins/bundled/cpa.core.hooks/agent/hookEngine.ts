/**
 * Central execution engine for the Hook system.
 * Dispatches lifecycle events to configured hooks, enforces matchers and timeouts,
 * handles async/background hooks, and combines structured outcomes.
 */

import type { HookContribution, HookInput } from '@cpa/plugin-api'
import type { NativeBridge } from './types.js'
import { runHookCommand } from './commandRunner.js'
import { discoverAllHooks } from './discovery.js'
import { matchesMatcher } from './matcher.js'
import { parseHookCommandOutput } from './outputParser.js'
import type {
    HookEventName,
    HookMetadata,
    HookRunSummary,
    PermissionRequestInput,
    PermissionRequestOutcome,
    PermissionRequestOutput,
    PostCompactInput,
    PostCompactOutcome,
    PostToolUseInput,
    PostToolUseOutcome,
    PostToolUseOutput,
    PreCompactInput,
    PreCompactOutcome,
    PreToolUseInput,
    PreToolUseOutcome,
    PreToolUseOutput,
    SessionEndInput,
    SessionStartInput,
    SessionStartOutcome,
    SessionStartOutput,
    StatelessHookOutput,
    StopInput,
    StopOutcome,
    SubagentStartInput,
    SubagentStartOutcome,
    SubagentStartOutput,
    SubagentStopInput,
    SubagentStopOutcome,
    UserPromptSubmitInput,
    UserPromptSubmitOutcome,
    UserPromptSubmitOutput,
} from './types.js'

export type HookLifecycleListener = (summary: HookRunSummary) => void

export interface HookEngineOptions {
    bridge: NativeBridge
    cwd?: string
    hooks?: readonly HookContribution[]
    pluginConfigs?: Array<{
        pluginId: string
        manifestPath: string
        hooks: import('./types.js').HookEventsConfig
    }>
    onHookStart?: HookLifecycleListener
    onHookComplete?: HookLifecycleListener
}

async function runSingleHookContribution(
    hook: HookContribution,
    input: HookInput,
): Promise<{ continue: boolean; message?: string; error?: Error }> {
    try {
        const result = await hook.execute(input)
        return {
            continue: result?.continue ?? true,
            message: result?.message,
        }
    } catch (err) {
        if (hook.failureMode === 'closed') {
            throw err instanceof Error ? err : new Error(String(err))
        }
        return {
            continue: true,
            error: err instanceof Error ? err : new Error(String(err)),
        }
    }
}

async function executeContributions(
    event: HookEventName,
    input: HookInput,
    hooks?: readonly HookContribution[],
): Promise<{ continue: boolean; message?: string; errors: Error[] }> {
    if (!hooks || hooks.length === 0) {
        return { continue: true, errors: [] }
    }

    const errors: Error[] = []
    for (const hook of hooks) {
        if (hook.event !== event) continue
        const res = await runSingleHookContribution(hook, input)
        if (res.error) {
            errors.push(res.error)
        }
        if (res.continue === false) {
            return {
                continue: false,
                message: res.message,
                errors,
            }
        }
    }

    return { continue: true, errors }
}

export class HookEngine {
    private readonly bridge: NativeBridge
    private cwd: string
    private hooks?: readonly HookContribution[]
    private pluginConfigs?: HookEngineOptions['pluginConfigs']
    private readonly onHookStart?: HookLifecycleListener
    private readonly onHookComplete?: HookLifecycleListener
    private cachedHooks: HookMetadata[] | null = null

    constructor(options: HookEngineOptions) {
        this.bridge = options.bridge
        this.cwd = options.cwd ?? ''
        this.hooks = options.hooks
        this.pluginConfigs = options.pluginConfigs
        this.onHookStart = options.onHookStart
        this.onHookComplete = options.onHookComplete
    }

    public setHooks(hooks?: readonly HookContribution[]): void {
        this.hooks = hooks
    }

    public setCwd(cwd: string): void {
        if (this.cwd !== cwd) {
            this.cwd = cwd
            this.cachedHooks = null
        }
    }

    public invalidateCache(): void {
        this.cachedHooks = null
    }

    public async getActiveHooks(): Promise<HookMetadata[]> {
        if (!this.cachedHooks) {
            const discovered = await discoverAllHooks(
                this.bridge,
                this.cwd || null,
                this.pluginConfigs,
            )
            this.cachedHooks = discovered.allHooks.filter((h) => h.enabled)
        }
        return this.cachedHooks
    }

    private selectHooks(
        allHooks: HookMetadata[],
        eventName: HookEventName,
        matcherInput?: string | null,
    ): HookMetadata[] {
        return allHooks
            .filter((h) => h.eventName === eventName && h.enabled)
            .filter((h) => matchesMatcher(h.matcher, matcherInput))
    }

    private createSummary(hook: HookMetadata): HookRunSummary {
        return {
            id: `hook_run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            eventName: hook.eventName,
            handlerType: hook.handler.type,
            executionMode:
                hook.handler.type === 'command' && hook.handler.async ? 'async' : 'sync',
            sourcePath: hook.sourcePath,
            source: hook.source,
            displayOrder: hook.displayOrder,
            status: 'running',
            statusMessage: hook.statusMessage ?? undefined,
            startedAt: Date.now(),
            entries: [],
        }
    }

    private async executeSingleHook<T>(
        hook: HookMetadata,
        inputJson: string,
        signal?: AbortSignal,
    ): Promise<{ output: T; summary: HookRunSummary }> {
        const summary = this.createSummary(hook)
        this.onHookStart?.(summary)

        const startTime = Date.now()

        if (hook.handler.type !== 'command') {
            if (hook.handler.type === 'mcp_tool') {
                summary.status = 'failed'
                summary.entries.push({
                    kind: 'error',
                    text: 'MCP tool hooks are not supported without an MCP executor',
                })
                summary.completedAt = Date.now()
                summary.durationMs = summary.completedAt - startTime
                this.onHookComplete?.(summary)
                return {
                    output: {
                        continue: false,
                        stopReason: 'MCP tool hooks are not supported without an MCP executor',
                    } as unknown as T,
                    summary,
                }
            }

            summary.status = 'completed'
            summary.completedAt = Date.now()
            summary.durationMs = summary.completedAt - startTime
            this.onHookComplete?.(summary)
            return {
                output: { continue: true } as unknown as T,
                summary,
            }
        }

        const handler = hook.handler

        if (handler.async) {
            void runHookCommand(
                this.bridge,
                handler,
                inputJson,
                this.cwd,
                { HOOK_EVENT_NAME: hook.eventName },
                signal,
            )
                .then((res) => {
                    const parsed = parseHookCommandOutput<T>(
                        res.stdout,
                        res.stderr,
                        res.exitCode,
                        hook.additionalContextLimit,
                    )
                    summary.status = parsed.success ? 'completed' : 'failed'
                    summary.entries = parsed.entries
                    summary.completedAt = Date.now()
                    summary.durationMs = res.durationMs
                    this.onHookComplete?.(summary)
                })
                .catch((err) => {
                    summary.status = 'failed'
                    summary.entries.push({
                        kind: 'error',
                        text: err instanceof Error ? err.message : String(err),
                    })
                    summary.completedAt = Date.now()
                    summary.durationMs = Date.now() - startTime
                    this.onHookComplete?.(summary)
                })

            summary.status = 'completed'
            summary.completedAt = Date.now()
            summary.durationMs = 0
            this.onHookComplete?.(summary)
            return {
                output: { continue: true } as unknown as T,
                summary,
            }
        }

        try {
            const res = await runHookCommand(
                this.bridge,
                handler,
                inputJson,
                this.cwd,
                { HOOK_EVENT_NAME: hook.eventName },
                signal,
            )

            const parsed = parseHookCommandOutput<T>(
                res.stdout,
                res.stderr,
                res.exitCode,
                hook.additionalContextLimit,
            )

            summary.status = parsed.success ? 'completed' : 'failed'
            summary.entries = parsed.entries
            summary.completedAt = Date.now()
            summary.durationMs = res.durationMs
            this.onHookComplete?.(summary)

            return {
                output: parsed.data,
                summary,
            }
        } catch (err) {
            summary.status = 'failed'
            summary.entries.push({
                kind: 'error',
                text: err instanceof Error ? err.message : String(err),
            })
            summary.completedAt = Date.now()
            summary.durationMs = Date.now() - startTime
            this.onHookComplete?.(summary)

            return {
                output: { continue: false } as unknown as T,
                summary,
            }
        }
    }

    public async executePreToolUse(
        input: PreToolUseInput,
        signal?: AbortSignal,
    ): Promise<PreToolUseOutcome> {
        let shouldStop = false
        let stopReason: string | undefined
        let decision: 'approve' | 'block' = 'approve'
        let blockReason: string | undefined
        let permissionDecision: 'allow' | 'deny' | 'ask' | undefined
        let permissionDecisionReason: string | undefined
        let updatedInput: unknown = undefined
        const additionalContexts: string[] = []
        const systemMessages: string[] = []
        const hookSummaries: HookRunSummary[] = []

        const pluginRes = await executeContributions(
            'PreToolUse',
            {
                event: 'PreToolUse',
                sessionId: input.session_id,
                payload: { ...input },
            },
            this.hooks,
        )

        if (!pluginRes.continue) {
            shouldStop = true
            decision = 'block'
            blockReason = pluginRes.message ?? 'Blocked by plugin hook'
            stopReason = pluginRes.message
            return {
                shouldStop,
                stopReason,
                decision,
                blockReason,
                permissionDecision,
                permissionDecisionReason,
                updatedInput,
                additionalContexts,
                systemMessages,
                hookSummaries,
            }
        }

        const hooks = await this.getActiveHooks()
        const matching = this.selectHooks(hooks, 'PreToolUse', input.tool_name)
        const inputJson = JSON.stringify(input)

        for (const hook of matching) {
            const { output, summary } = await this.executeSingleHook<PreToolUseOutput>(
                hook,
                inputJson,
                signal,
            )
            hookSummaries.push(summary)

            if (output.continue === false) {
                shouldStop = true
            }
            if (output.stopReason) {
                shouldStop = true
                stopReason = output.stopReason
            }
            if (output.systemMessage) {
                systemMessages.push(output.systemMessage)
            }
            if (output.decision === 'block') {
                decision = 'block'
                if (output.reason) {
                    blockReason = output.reason
                }
            }

            const hookSpecific = output.hookSpecificOutput
            if (hookSpecific) {
                if (hookSpecific.permissionDecision) {
                    permissionDecision = hookSpecific.permissionDecision
                }
                if (hookSpecific.permissionDecisionReason) {
                    permissionDecisionReason = hookSpecific.permissionDecisionReason
                }
                if (hookSpecific.updatedInput !== undefined && hookSpecific.updatedInput !== null) {
                    updatedInput = hookSpecific.updatedInput
                }
                if (hookSpecific.additionalContext) {
                    additionalContexts.push(hookSpecific.additionalContext)
                }
            }

            if (shouldStop) {
                break
            }
        }

        return {
            shouldStop,
            stopReason,
            decision,
            blockReason,
            permissionDecision,
            permissionDecisionReason,
            updatedInput,
            additionalContexts,
            systemMessages,
            hookSummaries,
        }
    }

    public async executePostToolUse(
        input: PostToolUseInput,
        signal?: AbortSignal,
    ): Promise<PostToolUseOutcome> {
        let shouldStop = false
        let stopReason: string | undefined
        const additionalContexts: string[] = []
        const systemMessages: string[] = []
        const hookSummaries: HookRunSummary[] = []

        const pluginRes = await executeContributions(
            'PostToolUse',
            {
                event: 'PostToolUse',
                sessionId: input.session_id,
                payload: { ...input },
            },
            this.hooks,
        )

        if (!pluginRes.continue) {
            shouldStop = true
            stopReason = pluginRes.message ?? 'Stopped by plugin hook'
            return {
                shouldStop,
                stopReason,
                additionalContexts,
                systemMessages,
                hookSummaries,
            }
        }

        const hooks = await this.getActiveHooks()
        const matching = this.selectHooks(hooks, 'PostToolUse', input.tool_name)
        const inputJson = JSON.stringify(input)

        for (const hook of matching) {
            const { output, summary } = await this.executeSingleHook<PostToolUseOutput>(
                hook,
                inputJson,
                signal,
            )
            hookSummaries.push(summary)

            if (output.continue === false) {
                shouldStop = true
            }
            if (output.stopReason) {
                shouldStop = true
                stopReason = output.stopReason
            }
            if (output.systemMessage) {
                systemMessages.push(output.systemMessage)
            }

            const hookSpecific = output.hookSpecificOutput
            if (hookSpecific?.additionalContext) {
                additionalContexts.push(hookSpecific.additionalContext)
            }

            if (shouldStop) {
                break
            }
        }

        return {
            shouldStop,
            stopReason,
            additionalContexts,
            systemMessages,
            hookSummaries,
        }
    }

    public async executePermissionRequest(
        input: PermissionRequestInput,
        signal?: AbortSignal,
    ): Promise<PermissionRequestOutcome> {
        let shouldStop = false
        let stopReason: string | undefined
        let decision: 'allow' | 'deny' | 'ask' = 'ask'
        let decisionReason: string | undefined
        const systemMessages: string[] = []
        const hookSummaries: HookRunSummary[] = []

        const pluginRes = await executeContributions(
            'PermissionRequest',
            {
                event: 'PermissionRequest',
                sessionId: input.session_id,
                payload: { ...input },
            },
            this.hooks,
        )

        if (!pluginRes.continue) {
            shouldStop = true
            decision = 'deny'
            decisionReason = pluginRes.message ?? 'Denied by plugin hook'
            stopReason = pluginRes.message
            return {
                shouldStop,
                stopReason,
                decision,
                decisionReason,
                systemMessages,
                hookSummaries,
            }
        }

        const hooks = await this.getActiveHooks()
        const matching = this.selectHooks(hooks, 'PermissionRequest', input.tool_name)
        const inputJson = JSON.stringify(input)

        for (const hook of matching) {
            const { output, summary } = await this.executeSingleHook<PermissionRequestOutput>(
                hook,
                inputJson,
                signal,
            )
            hookSummaries.push(summary)

            if (output.continue === false) {
                shouldStop = true
            }
            if (output.stopReason) {
                shouldStop = true
                stopReason = output.stopReason
            }
            if (output.systemMessage) {
                systemMessages.push(output.systemMessage)
            }
            if (output.decision) {
                decision = output.decision
                decisionReason = output.reason
            }

            if (shouldStop) {
                break
            }
        }

        return {
            shouldStop,
            stopReason,
            decision,
            decisionReason,
            systemMessages,
            hookSummaries,
        }
    }

    public async executeSessionStart(
        input: SessionStartInput,
        signal?: AbortSignal,
    ): Promise<SessionStartOutcome> {
        let shouldStop = false
        let stopReason: string | undefined
        const additionalContexts: string[] = []
        const systemMessages: string[] = []
        const hookSummaries: HookRunSummary[] = []

        const pluginRes = await executeContributions(
            'SessionStart',
            {
                event: 'SessionStart',
                sessionId: input.session_id,
                payload: { ...input },
            },
            this.hooks,
        )

        if (!pluginRes.continue) {
            shouldStop = true
            stopReason = pluginRes.message ?? 'Stopped by plugin hook'
            return {
                shouldStop,
                stopReason,
                additionalContexts,
                systemMessages,
                hookSummaries,
            }
        }

        const hooks = await this.getActiveHooks()
        const matching = this.selectHooks(hooks, 'SessionStart', input.source)
        const inputJson = JSON.stringify(input)

        for (const hook of matching) {
            const { output, summary } = await this.executeSingleHook<SessionStartOutput>(
                hook,
                inputJson,
                signal,
            )
            hookSummaries.push(summary)

            if (output.continue === false) {
                shouldStop = true
            }
            if (output.stopReason) {
                shouldStop = true
                stopReason = output.stopReason
            }
            if (output.systemMessage) {
                systemMessages.push(output.systemMessage)
            }

            const hookSpecific = output.hookSpecificOutput
            if (hookSpecific?.additionalContext) {
                additionalContexts.push(hookSpecific.additionalContext)
            }

            if (shouldStop) {
                break
            }
        }

        return {
            shouldStop,
            stopReason,
            additionalContexts,
            systemMessages,
            hookSummaries,
        }
    }

    public async executeSessionEnd(input: SessionEndInput, signal?: AbortSignal): Promise<void> {
        const hooks = await this.getActiveHooks()
        const matching = this.selectHooks(hooks, 'SessionEnd', input.reason)
        const inputJson = JSON.stringify(input)

        for (const hook of matching) {
            void this.executeSingleHook(hook, inputJson, signal)
        }
    }

    public async executeUserPromptSubmit(
        input: UserPromptSubmitInput,
        signal?: AbortSignal,
    ): Promise<UserPromptSubmitOutcome> {
        let shouldStop = false
        let stopReason: string | undefined
        const additionalContexts: string[] = []
        const systemMessages: string[] = []
        const hookSummaries: HookRunSummary[] = []

        const pluginRes = await executeContributions(
            'UserPromptSubmit',
            {
                event: 'UserPromptSubmit',
                sessionId: input.session_id,
                payload: { ...input },
            },
            this.hooks,
        )

        if (!pluginRes.continue) {
            shouldStop = true
            stopReason = pluginRes.message ?? 'Stopped by plugin hook'
            return {
                shouldStop,
                stopReason,
                additionalContexts,
                systemMessages,
                hookSummaries,
            }
        }

        const hooks = await this.getActiveHooks()
        const matching = this.selectHooks(hooks, 'UserPromptSubmit', null)
        const inputJson = JSON.stringify(input)

        for (const hook of matching) {
            const { output, summary } = await this.executeSingleHook<UserPromptSubmitOutput>(
                hook,
                inputJson,
                signal,
            )
            hookSummaries.push(summary)

            if (output.continue === false) {
                shouldStop = true
            }
            if (output.stopReason) {
                shouldStop = true
                stopReason = output.stopReason
            }
            if (output.systemMessage) {
                systemMessages.push(output.systemMessage)
            }

            const hookSpecific = output.hookSpecificOutput
            if (hookSpecific?.additionalContext) {
                additionalContexts.push(hookSpecific.additionalContext)
            }

            if (shouldStop) {
                break
            }
        }

        return {
            shouldStop,
            stopReason,
            additionalContexts,
            systemMessages,
            hookSummaries,
        }
    }

    public async executePreCompact(
        input: PreCompactInput,
        signal?: AbortSignal,
    ): Promise<PreCompactOutcome> {
        let shouldStop = false
        let stopReason: string | undefined
        const systemMessages: string[] = []
        const hookSummaries: HookRunSummary[] = []

        const pluginRes = await executeContributions(
            'PreCompact',
            {
                event: 'PreCompact',
                sessionId: input.session_id,
                payload: { ...input },
            },
            this.hooks,
        )

        if (!pluginRes.continue) {
            shouldStop = true
            stopReason = pluginRes.message ?? 'Stopped by plugin hook'
            return {
                shouldStop,
                stopReason,
                systemMessages,
                hookSummaries,
            }
        }

        const hooks = await this.getActiveHooks()
        const matching = this.selectHooks(hooks, 'PreCompact', input.trigger)
        const inputJson = JSON.stringify(input)

        for (const hook of matching) {
            const { output, summary } = await this.executeSingleHook<StatelessHookOutput>(
                hook,
                inputJson,
                signal,
            )
            hookSummaries.push(summary)

            if (output.continue === false) {
                shouldStop = true
            }
            if (output.stopReason) {
                shouldStop = true
                stopReason = output.stopReason
            }
            if (output.systemMessage) {
                systemMessages.push(output.systemMessage)
            }

            if (shouldStop) {
                break
            }
        }

        return {
            shouldStop,
            stopReason,
            systemMessages,
            hookSummaries,
        }
    }

    public async executePostCompact(
        input: PostCompactInput,
        signal?: AbortSignal,
    ): Promise<PostCompactOutcome> {
        let shouldStop = false
        let stopReason: string | undefined
        const systemMessages: string[] = []
        const hookSummaries: HookRunSummary[] = []

        const pluginRes = await executeContributions(
            'PostCompact',
            {
                event: 'PostCompact',
                sessionId: input.session_id,
                payload: { ...input },
            },
            this.hooks,
        )

        if (!pluginRes.continue) {
            shouldStop = true
            stopReason = pluginRes.message ?? 'Stopped by plugin hook'
            return {
                shouldStop,
                stopReason,
                systemMessages,
                hookSummaries,
            }
        }

        const hooks = await this.getActiveHooks()
        const matching = this.selectHooks(hooks, 'PostCompact', input.trigger)
        const inputJson = JSON.stringify(input)

        for (const hook of matching) {
            const { output, summary } = await this.executeSingleHook<StatelessHookOutput>(
                hook,
                inputJson,
                signal,
            )
            hookSummaries.push(summary)

            if (output.continue === false) {
                shouldStop = true
            }
            if (output.stopReason) {
                shouldStop = true
                stopReason = output.stopReason
            }
            if (output.systemMessage) {
                systemMessages.push(output.systemMessage)
            }

            if (shouldStop) {
                break
            }
        }

        return {
            shouldStop,
            stopReason,
            systemMessages,
            hookSummaries,
        }
    }

    public async executeSubagentStart(
        input: SubagentStartInput,
        signal?: AbortSignal,
    ): Promise<SubagentStartOutcome> {
        let shouldStop = false
        let stopReason: string | undefined
        const additionalContexts: string[] = []
        const systemMessages: string[] = []
        const hookSummaries: HookRunSummary[] = []

        const pluginRes = await executeContributions(
            'SubagentStart',
            {
                event: 'SubagentStart',
                sessionId: input.session_id,
                payload: { ...input },
            },
            this.hooks,
        )

        if (!pluginRes.continue) {
            shouldStop = true
            stopReason = pluginRes.message ?? 'Stopped by plugin hook'
            return {
                shouldStop,
                stopReason,
                additionalContexts,
                systemMessages,
                hookSummaries,
            }
        }

        const hooks = await this.getActiveHooks()
        const matching = this.selectHooks(hooks, 'SubagentStart', input.agent_type)
        const inputJson = JSON.stringify(input)

        for (const hook of matching) {
            const { output, summary } = await this.executeSingleHook<SubagentStartOutput>(
                hook,
                inputJson,
                signal,
            )
            hookSummaries.push(summary)

            if (output.continue === false) {
                shouldStop = true
            }
            if (output.stopReason) {
                shouldStop = true
                stopReason = output.stopReason
            }
            if (output.systemMessage) {
                systemMessages.push(output.systemMessage)
            }

            const hookSpecific = output.hookSpecificOutput
            if (hookSpecific?.additionalContext) {
                additionalContexts.push(hookSpecific.additionalContext)
            }

            if (shouldStop) {
                break
            }
        }

        return {
            shouldStop,
            stopReason,
            additionalContexts,
            systemMessages,
            hookSummaries,
        }
    }

    public async executeSubagentStop(
        input: SubagentStopInput,
        signal?: AbortSignal,
    ): Promise<SubagentStopOutcome> {
        let shouldStop = false
        let stopReason: string | undefined
        const systemMessages: string[] = []
        const hookSummaries: HookRunSummary[] = []

        const pluginRes = await executeContributions(
            'SubagentStop',
            {
                event: 'SubagentStop',
                sessionId: input.session_id,
                payload: { ...input },
            },
            this.hooks,
        )

        if (!pluginRes.continue) {
            shouldStop = true
            stopReason = pluginRes.message ?? 'Stopped by plugin hook'
            return {
                shouldStop,
                stopReason,
                systemMessages,
                hookSummaries,
            }
        }

        const hooks = await this.getActiveHooks()
        const matching = this.selectHooks(hooks, 'SubagentStop', input.agent_type)
        const inputJson = JSON.stringify(input)

        for (const hook of matching) {
            const { output, summary } = await this.executeSingleHook<StatelessHookOutput>(
                hook,
                inputJson,
                signal,
            )
            hookSummaries.push(summary)

            if (output.continue === false) {
                shouldStop = true
            }
            if (output.stopReason) {
                shouldStop = true
                stopReason = output.stopReason
            }
            if (output.systemMessage) {
                systemMessages.push(output.systemMessage)
            }

            if (shouldStop) {
                break
            }
        }

        return {
            shouldStop,
            stopReason,
            systemMessages,
            hookSummaries,
        }
    }

    public async executeStop(
        input: StopInput,
        signal?: AbortSignal,
    ): Promise<StopOutcome> {
        const hooks = await this.getActiveHooks()
        const matching = this.selectHooks(hooks, 'Stop', null)

        let shouldStop = false
        let stopReason: string | undefined
        const systemMessages: string[] = []
        const hookSummaries: HookRunSummary[] = []

        const inputJson = JSON.stringify(input)

        for (const hook of matching) {
            const { output, summary } = await this.executeSingleHook<StatelessHookOutput>(
                hook,
                inputJson,
                signal,
            )
            hookSummaries.push(summary)

            if (output.continue === false) {
                shouldStop = true
            }
            if (output.stopReason) {
                shouldStop = true
                stopReason = output.stopReason
            }
            if (output.systemMessage) {
                systemMessages.push(output.systemMessage)
            }

            if (shouldStop) {
                break
            }
        }

        return {
            shouldStop,
            stopReason,
            systemMessages,
            hookSummaries,
        }
    }
}
