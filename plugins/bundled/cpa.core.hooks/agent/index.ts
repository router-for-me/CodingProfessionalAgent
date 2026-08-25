import {
    createCapabilityNativeAdapter,
    definePluginEntry,
} from '@cpa/plugin-sdk'
import type {
    HookContribution,
    PluginContext,
} from '@cpa/plugin-api'
import { HookEngine } from './hookEngine.js'
import {
    discoverAllHooks,
    loadUserHooks,
    saveUserHooks,
    loadProjectHooks,
    saveProjectHooks,
} from './discovery.js'
import { runHookCommand } from './commandRunner.js'
import { matchesMatcher } from './matcher.js'
import { parseHookCommandOutput } from './outputParser.js'
import { computeHookHash } from './hash.js'

export {
    HookEngine,
    discoverAllHooks,
    loadUserHooks,
    saveUserHooks,
    loadProjectHooks,
    saveProjectHooks,
    runHookCommand,
    matchesMatcher,
    parseHookCommandOutput,
    computeHookHash,
}

export const hooksAgentEntry = definePluginEntry({
    runtime: 'agent',
    activate(context: PluginContext) {
        const client =
            context.capabilityClient ??
            ((context as any).capabilities?.invoke ? (context as any).capabilities : undefined)
        const scopedBridge = client ? createCapabilityNativeAdapter(client) : undefined

        const hookEngine = new HookEngine({
            bridge: scopedBridge as any,
        })

        // 1. SessionStart
        context.register<HookContribution>({
            kind: 'hook',
            id: 'SessionStart',
            value: {
                id: 'cpa.core.hooks.session-start',
                event: 'SessionStart',
                order: 100,
                failureMode: 'open',
                execute: async (input) => {
                    const cwd = input.cwd ?? (input.payload?.cwd as string) ?? ''
                    if (cwd) hookEngine.setCwd(cwd)
                    const outcome = await hookEngine.executeSessionStart(input.payload as any, input.signal)
                    return {
                        continue: !outcome.shouldStop,
                        message: outcome.stopReason,
                        stopReason: outcome.stopReason,
                        additionalContexts: outcome.additionalContexts,
                        additionalContext: outcome.additionalContexts?.join('\n\n'),
                    }
                },
            },
        })

        // 2. UserPromptSubmit
        context.register<HookContribution>({
            kind: 'hook',
            id: 'UserPromptSubmit',
            value: {
                id: 'cpa.core.hooks.user-prompt-submit',
                event: 'UserPromptSubmit',
                order: 100,
                failureMode: 'open',
                execute: async (input) => {
                    const cwd = input.cwd ?? (input.payload?.cwd as string) ?? ''
                    if (cwd) hookEngine.setCwd(cwd)
                    const outcome = await hookEngine.executeUserPromptSubmit(input.payload as any, input.signal)
                    return {
                        continue: !outcome.shouldStop,
                        message: outcome.stopReason,
                        stopReason: outcome.stopReason,
                        updatedInput: outcome.updatedPrompt ?? outcome.updatedInput,
                        additionalContexts: outcome.additionalContexts,
                        additionalContext: outcome.additionalContexts?.join('\n\n'),
                        systemMessage: outcome.systemMessage,
                    }
                },
            },
        })

        // 3. PreToolUse
        context.register<HookContribution>({
            kind: 'hook',
            id: 'PreToolUse',
            value: {
                id: 'cpa.core.hooks.pre-tool-use',
                event: 'PreToolUse',
                order: 100,
                failureMode: 'open',
                execute: async (input) => {
                    const cwd = input.cwd ?? (input.payload?.cwd as string) ?? ''
                    if (cwd) hookEngine.setCwd(cwd)
                    const outcome = await hookEngine.executePreToolUse(input.payload as any, input.signal)
                    return {
                        continue: !outcome.shouldStop,
                        message: outcome.stopReason ?? outcome.blockReason,
                        stopReason: outcome.stopReason ?? outcome.blockReason,
                        updatedInput: outcome.updatedInput,
                        permissionMode: outcome.permissionDecision,
                    }
                },
            },
        })

        // 4. PermissionRequest
        context.register<HookContribution>({
            kind: 'hook',
            id: 'PermissionRequest',
            value: {
                id: 'cpa.core.hooks.permission-request',
                event: 'PermissionRequest',
                order: 100,
                failureMode: 'open',
                execute: async (input) => {
                    const cwd = input.cwd ?? (input.payload?.cwd as string) ?? ''
                    if (cwd) hookEngine.setCwd(cwd)
                    const outcome = await hookEngine.executePermissionRequest(input.payload as any, input.signal)
                    return {
                        continue: !outcome.shouldStop,
                        message: outcome.stopReason,
                        stopReason: outcome.stopReason,
                        decision: outcome.decision,
                    }
                },
            },
        })

        // 5. PostToolUse
        context.register<HookContribution>({
            kind: 'hook',
            id: 'PostToolUse',
            value: {
                id: 'cpa.core.hooks.post-tool-use',
                event: 'PostToolUse',
                order: 100,
                failureMode: 'open',
                execute: async (input) => {
                    const cwd = input.cwd ?? (input.payload?.cwd as string) ?? ''
                    if (cwd) hookEngine.setCwd(cwd)
                    const outcome = await hookEngine.executePostToolUse(input.payload as any, input.signal)
                    return {
                        continue: !outcome.shouldStop,
                        message: outcome.stopReason,
                        stopReason: outcome.stopReason,
                        additionalContexts: outcome.additionalContexts,
                        additionalContext: outcome.additionalContexts?.join('\n\n'),
                    }
                },
            },
        })

        // 6. PreCompact
        context.register<HookContribution>({
            kind: 'hook',
            id: 'PreCompact',
            value: {
                id: 'cpa.core.hooks.pre-compact',
                event: 'PreCompact',
                order: 100,
                failureMode: 'open',
                execute: async (input) => {
                    const cwd = input.cwd ?? (input.payload?.cwd as string) ?? ''
                    if (cwd) hookEngine.setCwd(cwd)
                    const outcome = await hookEngine.executePreCompact(input.payload as any, input.signal)
                    return {
                        continue: !outcome.shouldStop,
                        message: outcome.stopReason,
                        stopReason: outcome.stopReason,
                    }
                },
            },
        })

        // 7. PostCompact
        context.register<HookContribution>({
            kind: 'hook',
            id: 'PostCompact',
            value: {
                id: 'cpa.core.hooks.post-compact',
                event: 'PostCompact',
                order: 100,
                failureMode: 'open',
                execute: async (input) => {
                    const cwd = input.cwd ?? (input.payload?.cwd as string) ?? ''
                    if (cwd) hookEngine.setCwd(cwd)
                    const outcome = await hookEngine.executePostCompact(input.payload as any, input.signal)
                    return {
                        continue: !outcome.shouldStop,
                        message: outcome.stopReason,
                        stopReason: outcome.stopReason,
                    }
                },
            },
        })

        // 8. SubagentStart
        context.register<HookContribution>({
            kind: 'hook',
            id: 'SubagentStart',
            value: {
                id: 'cpa.core.hooks.subagent-start',
                event: 'SubagentStart',
                order: 100,
                failureMode: 'open',
                execute: async (input) => {
                    const cwd = input.cwd ?? (input.payload?.cwd as string) ?? ''
                    if (cwd) hookEngine.setCwd(cwd)
                    const outcome = await hookEngine.executeSubagentStart(input.payload as any, input.signal)
                    return {
                        continue: !outcome.shouldStop,
                        message: outcome.stopReason,
                        stopReason: outcome.stopReason,
                        additionalContexts: outcome.additionalContexts,
                        additionalContext: outcome.additionalContexts?.join('\n\n'),
                    }
                },
            },
        })

        // 9. SubagentStop
        context.register<HookContribution>({
            kind: 'hook',
            id: 'SubagentStop',
            value: {
                id: 'cpa.core.hooks.subagent-stop',
                event: 'SubagentStop',
                order: 100,
                failureMode: 'open',
                execute: async (input) => {
                    const cwd = input.cwd ?? (input.payload?.cwd as string) ?? ''
                    if (cwd) hookEngine.setCwd(cwd)
                    const outcome = await hookEngine.executeSubagentStop(input.payload as any, input.signal)
                    return {
                        continue: !outcome.shouldStop,
                        message: outcome.stopReason,
                        stopReason: outcome.stopReason,
                    }
                },
            },
        })

        // 10. Stop
        context.register<HookContribution>({
            kind: 'hook',
            id: 'Stop',
            value: {
                id: 'cpa.core.hooks.stop',
                event: 'Stop',
                order: 100,
                failureMode: 'open',
                execute: async (input) => {
                    const cwd = input.cwd ?? (input.payload?.cwd as string) ?? ''
                    if (cwd) hookEngine.setCwd(cwd)
                    const outcome = await hookEngine.executeStop(input.payload as any, input.signal)
                    return {
                        continue: !outcome.shouldStop,
                        message: outcome.stopReason,
                        stopReason: outcome.stopReason,
                    }
                },
            },
        })

        // 11. SessionEnd
        context.register<HookContribution>({
            kind: 'hook',
            id: 'SessionEnd',
            value: {
                id: 'cpa.core.hooks.session-end',
                event: 'SessionEnd',
                order: 100,
                failureMode: 'open',
                execute: async (input) => {
                    const cwd = input.cwd ?? (input.payload?.cwd as string) ?? ''
                    if (cwd) hookEngine.setCwd(cwd)
                    await hookEngine.executeSessionEnd(input.payload as any, input.signal)
                    return {
                        continue: true,
                    }
                },
            },
        })
    },
})

export const entry = hooksAgentEntry
export default hooksAgentEntry
