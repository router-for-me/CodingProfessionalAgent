/**
 * HookProvider: unified agent lifecycle hook contribution execution and failure policies.
 * Dispatches hook events across all lifecycle points with configurable failure modes ('open' | 'closed'),
 * chaining input modifications, aggregating additional contexts, and managing permission decisions.
 */

import type {
    HookContribution,
    HookEventName,
    HookInput,
    HookResult,
} from '@cpa/plugin-api'
import {
    rendererRegistry,
    type RendererRegistry,
} from '@/plugins/platform/rendererRegistry'
import {
    agentRegistry,
} from '@/plugins/platform/AgentPluginRuntimeHost'

export type {
    HookContribution,
    HookEventName,
    HookInput,
    HookResult,
}

export interface HookExecutionResult {
    continue: boolean
    shouldStop?: boolean
    message?: string
    stopReason?: string
    additionalContexts: string[]
    additionalContext?: string
    updatedInput?: unknown
    systemMessage?: string
    decision?: 'allow' | 'deny' | 'ask'
    permissionMode?: 'allow' | 'deny' | 'ask'
    errors: Error[]
}

export interface HookProviderContext {
    extensionRegistry?: RendererRegistry
    hooks?: readonly HookContribution[]
}

/**
 * Execute a single hook contribution according to its failureMode ('open' vs 'closed').
 * If failureMode is 'closed' and execution throws, the error is re-thrown (fail-closed).
 * If failureMode is 'open' and execution throws, the error is captured and execution continues (fail-open).
 */
export async function runHook(
    hook: HookContribution,
    input: HookInput = { event: hook.event, sessionId: 'default-session', payload: {} }
): Promise<HookExecutionResult> {
    try {
        const result = await hook.execute(input)
        const additionalContexts: string[] = []
        if (result?.additionalContexts && Array.isArray(result.additionalContexts)) {
            additionalContexts.push(...result.additionalContexts.filter(Boolean))
        } else if (typeof result?.additionalContext === 'string' && result.additionalContext.trim()) {
            additionalContexts.push(result.additionalContext)
        }

        const shouldContinue = result?.continue ?? true

        return {
            continue: shouldContinue,
            shouldStop: !shouldContinue,
            message: result?.message ?? result?.stopReason,
            stopReason: result?.stopReason ?? result?.message,
            additionalContexts,
            additionalContext: additionalContexts.length > 0 ? additionalContexts.join('\n\n') : undefined,
            updatedInput: result?.updatedInput,
            systemMessage: result?.systemMessage,
            decision: result?.decision,
            permissionMode: result?.permissionMode,
            errors: [],
        }
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        if (hook.failureMode === 'closed') {
            throw error
        }
        return {
            continue: true,
            shouldStop: false,
            additionalContexts: [],
            errors: [error],
        }
    }
}

/**
 * Run all matching hook contributions for a specific lifecycle event.
 * Chaining rules:
 * - Hooks are executed in order (sorted by order ASC).
 * - Contexts are accumulated across hooks.
 * - Updated inputs are passed to subsequent hooks in payload.
 * - Any hook returning continue: false or decision: 'deny' halts further processing.
 */
export async function executeHookContributions(
    event: HookEventName,
    input: HookInput,
    context: HookProviderContext = {}
): Promise<HookExecutionResult> {
    const registry = context.extensionRegistry ?? agentRegistry
    let allHooks = context.hooks ?? registry.getHookContributions(event)
    if (allHooks.length === 0 && registry !== rendererRegistry) {
        allHooks = rendererRegistry.getHookContributions(event)
    }
    const matchingHooks = allHooks
        .filter((hook) => hook.event === event)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

    const errors: Error[] = []
    const additionalContexts: string[] = []
    let currentPayload = { ...(input.payload ?? {}) }
    let lastUpdatedInput: unknown = undefined
    let lastSystemMessage: string | undefined = undefined
    let lastDecision: 'allow' | 'deny' | 'ask' | undefined = undefined
    let lastPermissionMode: 'allow' | 'deny' | 'ask' | undefined = undefined

    for (const hook of matchingHooks) {
        const currentInput: HookInput = {
            ...input,
            event,
            payload: currentPayload,
        }

        const res = await runHook(hook, currentInput)

        if (res.errors.length > 0) {
            errors.push(...res.errors)
        }

        if (res.additionalContexts && res.additionalContexts.length > 0) {
            additionalContexts.push(...res.additionalContexts)
        }

        if (res.systemMessage) {
            lastSystemMessage = res.systemMessage
        }

        if (res.decision) {
            if (res.decision === 'deny' || !lastDecision) {
                lastDecision = res.decision
            }
        }

        if (res.permissionMode) {
            if (res.permissionMode === 'deny' || !lastPermissionMode) {
                lastPermissionMode = res.permissionMode
            }
        }

        if (res.updatedInput !== undefined) {
            lastUpdatedInput = res.updatedInput
            if (event === 'UserPromptSubmit' && typeof res.updatedInput === 'string') {
                currentPayload = { ...currentPayload, prompt: res.updatedInput }
            } else if (
                (event === 'PreToolUse' || event === 'PermissionRequest' || event === 'PostToolUse') &&
                typeof res.updatedInput === 'object' &&
                res.updatedInput !== null
            ) {
                currentPayload = {
                    ...currentPayload,
                    tool_input: res.updatedInput as Record<string, unknown>,
                }
            }
        }

        if (res.continue === false || res.decision === 'deny') {
            return {
                continue: false,
                shouldStop: true,
                message: res.message ?? res.stopReason,
                stopReason: res.stopReason ?? res.message,
                additionalContexts,
                additionalContext:
                    additionalContexts.length > 0 ? additionalContexts.join('\n\n') : undefined,
                updatedInput: lastUpdatedInput,
                systemMessage: lastSystemMessage,
                decision: lastDecision ?? res.decision,
                permissionMode: lastPermissionMode ?? res.permissionMode,
                errors,
            }
        }
    }

    return {
        continue: true,
        shouldStop: false,
        additionalContexts,
        additionalContext:
            additionalContexts.length > 0 ? additionalContexts.join('\n\n') : undefined,
        updatedInput: lastUpdatedInput,
        systemMessage: lastSystemMessage,
        decision: lastDecision,
        permissionMode: lastPermissionMode,
        errors,
    }
}

/**
 * Facade class for HookProvider.
 */
export class HookProvider {
    static runHook = runHook
    static execute = executeHookContributions
}
