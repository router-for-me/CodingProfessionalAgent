import { describe, it, expect } from 'vitest'
import type {
    HookContribution,
    HookResult,
} from '@cpa/plugin-api'
import { RendererRegistry } from '@/plugins/platform/rendererRegistry'
import {
    executeHookContributions,
    HookProvider,
    runHook,
} from './HookProvider'

describe('HookProvider & Hook Contributions', () => {
    it('executes a basic hook contribution returning continue true', async () => {
        const hook: HookContribution = {
            id: 'test-hook',
            event: 'PreToolUse',
            order: 10,
            failureMode: 'open',
            execute: async (): Promise<HookResult> => {
                return { continue: true }
            },
        }

        const res = await runHook(hook, {
            event: 'PreToolUse',
            sessionId: 's-1',
            payload: { tool: 'bash' },
        })

        expect(res.continue).toBe(true)
        expect(res.errors).toHaveLength(0)
    })

    it('fails closed only for a security hook', async () => {
        const securityHook: HookContribution = {
            id: 'sec-hook',
            event: 'PreToolUse',
            order: 10,
            failureMode: 'closed',
            execute: async () => {
                throw new Error('Security hook rejected')
            },
        }

        const telemetryHook: HookContribution = {
            id: 'telemetry-hook',
            event: 'PreToolUse',
            order: 20,
            failureMode: 'open',
            execute: async () => {
                throw new Error('Telemetry hook failed')
            },
        }

        await expect(runHook(securityHook)).rejects.toThrow('Security hook rejected')
        await expect(runHook(telemetryHook)).resolves.toMatchObject({
            continue: true,
            errors: [expect.anything()],
        })
    })

    it('executes hooks in order and stops when continue is false', async () => {
        const registry = new RendererRegistry()
        const orderOfExecution: string[] = []

        const firstHook: HookContribution = {
            id: 'first',
            event: 'SessionStart',
            order: 10,
            failureMode: 'open',
            execute: async () => {
                orderOfExecution.push('first')
                return { continue: true }
            },
        }

        const blockingHook: HookContribution = {
            id: 'second',
            event: 'SessionStart',
            order: 20,
            failureMode: 'open',
            execute: async () => {
                orderOfExecution.push('second')
                return { continue: false, message: 'Blocked by policy' }
            },
        }

        const thirdHook: HookContribution = {
            id: 'third',
            event: 'SessionStart',
            order: 30,
            failureMode: 'open',
            execute: async () => {
                orderOfExecution.push('third')
                return { continue: true }
            },
        }

        registry.registerHook(thirdHook)
        registry.registerHook(firstHook)
        registry.registerHook(blockingHook)

        const outcome = await executeHookContributions(
            'SessionStart',
            {
                event: 'SessionStart',
                sessionId: 'session-123',
                payload: {},
            },
            { extensionRegistry: registry },
        )

        expect(orderOfExecution).toEqual(['first', 'second'])
        expect(outcome.continue).toBe(false)
        expect(outcome.message).toBe('Blocked by policy')
    })

    it('unregisters hook contributions correctly', async () => {
        const registry = new RendererRegistry()
        const executed: string[] = []

        const hook: HookContribution = {
            id: 'removable-hook',
            event: 'UserPromptSubmit',
            order: 10,
            failureMode: 'open',
            execute: async () => {
                executed.push('ran')
                return { continue: true }
            },
        }

        const unregister = registry.registerHook(hook)
        expect(registry.getHookContributions('UserPromptSubmit')).toHaveLength(1)

        unregister()
        expect(registry.getHookContributions('UserPromptSubmit')).toHaveLength(0)

        await executeHookContributions(
            'UserPromptSubmit',
            { event: 'UserPromptSubmit', sessionId: 's-1', payload: {} },
            { extensionRegistry: registry },
        )
        expect(executed).toHaveLength(0)
    })

    it('continues execution when an open-mode hook throws, accumulating errors', async () => {
        const registry = new RendererRegistry()
        const seen: string[] = []

        const errorHook: HookContribution = {
            id: 'error-hook',
            event: 'UserPromptSubmit',
            order: 5,
            failureMode: 'open',
            execute: async () => {
                throw new Error('Non-fatal metric failure')
            },
        }

        const nextHook: HookContribution = {
            id: 'next-hook',
            event: 'UserPromptSubmit',
            order: 10,
            failureMode: 'open',
            execute: async () => {
                seen.push('next')
                return { continue: true }
            },
        }

        registry.registerHook(errorHook)
        registry.registerHook(nextHook)

        const outcome = await executeHookContributions(
            'UserPromptSubmit',
            {
                event: 'UserPromptSubmit',
                sessionId: 'session-123',
                payload: { prompt: 'hello' },
            },
            { extensionRegistry: registry },
        )

        expect(seen).toEqual(['next'])
        expect(outcome.continue).toBe(true)
        expect(outcome.errors).toHaveLength(1)
        expect(outcome.errors[0].message).toBe('Non-fatal metric failure')
    })

    it('chains input transformations across multiple hooks for UserPromptSubmit and PreToolUse', async () => {
        const registry = new RendererRegistry()

        const promptTransform1: HookContribution = {
            id: 'prompt-transform-1',
            event: 'UserPromptSubmit',
            order: 10,
            failureMode: 'open',
            execute: async (input) => {
                const p = String(input.payload.prompt)
                return { continue: true, updatedInput: `${p} [step 1]` }
            },
        }

        const promptTransform2: HookContribution = {
            id: 'prompt-transform-2',
            event: 'UserPromptSubmit',
            order: 20,
            failureMode: 'open',
            execute: async (input) => {
                const p = String(input.payload.prompt)
                return { continue: true, updatedInput: `${p} [step 2]`, additionalContext: 'Added context from hook 2' }
            },
        }

        registry.registerHook(promptTransform1)
        registry.registerHook(promptTransform2)

        const promptOutcome = await executeHookContributions(
            'UserPromptSubmit',
            {
                event: 'UserPromptSubmit',
                sessionId: 'session-123',
                payload: { prompt: 'Initial prompt' },
            },
            { extensionRegistry: registry },
        )

        expect(promptOutcome.updatedInput).toBe('Initial prompt [step 1] [step 2]')
        expect(promptOutcome.additionalContexts).toEqual(['Added context from hook 2'])
        expect(promptOutcome.additionalContext).toBe('Added context from hook 2')
    })

    it('accumulates additionalContexts across multiple hook contributions', async () => {
        const registry = new RendererRegistry()

        const hookA: HookContribution = {
            id: 'ctx-a',
            event: 'SessionStart',
            order: 10,
            failureMode: 'open',
            execute: async () => ({
                continue: true,
                additionalContexts: ['Context A1', 'Context A2'],
            }),
        }

        const hookB: HookContribution = {
            id: 'ctx-b',
            event: 'SessionStart',
            order: 20,
            failureMode: 'open',
            execute: async () => ({
                continue: true,
                additionalContext: 'Context B',
            }),
        }

        registry.registerHook(hookA)
        registry.registerHook(hookB)

        const outcome = await executeHookContributions(
            'SessionStart',
            { event: 'SessionStart', sessionId: 's-1', payload: {} },
            { extensionRegistry: registry },
        )

        expect(outcome.additionalContexts).toEqual(['Context A1', 'Context A2', 'Context B'])
        expect(outcome.additionalContext).toBe('Context A1\n\nContext A2\n\nContext B')
    })

    it('enforces deny precedence for PermissionRequest', async () => {
        const registry = new RendererRegistry()

        const allowHook: HookContribution = {
            id: 'allow-hook',
            event: 'PermissionRequest',
            order: 10,
            failureMode: 'open',
            execute: async () => ({ continue: true, decision: 'allow' }),
        }

        const denyHook: HookContribution = {
            id: 'deny-hook',
            event: 'PermissionRequest',
            order: 20,
            failureMode: 'open',
            execute: async () => ({ continue: false, decision: 'deny', stopReason: 'Security deny' }),
        }

        registry.registerHook(allowHook)
        registry.registerHook(denyHook)

        const outcome = await executeHookContributions(
            'PermissionRequest',
            { event: 'PermissionRequest', sessionId: 's-1', payload: { tool_name: 'bash' } },
            { extensionRegistry: registry },
        )

        expect(outcome.continue).toBe(false)
        expect(outcome.decision).toBe('deny')
        expect(outcome.stopReason).toBe('Security deny')
    })

    it('dispatches all 11 lifecycle hook points via HookProvider facade', async () => {
        const registry = new RendererRegistry()
        const eventsSeen: string[] = []

        const ALL_11_EVENTS = [
            'SessionStart',
            'UserPromptSubmit',
            'PreToolUse',
            'PermissionRequest',
            'PostToolUse',
            'PreCompact',
            'PostCompact',
            'SubagentStart',
            'SubagentStop',
            'Stop',
            'SessionEnd',
        ] as const

        for (let i = 0; i < ALL_11_EVENTS.length; i++) {
            const ev = ALL_11_EVENTS[i]
            registry.registerHook({
                id: `hook-${ev}`,
                event: ev,
                order: i,
                failureMode: 'open',
                execute: async (input) => {
                    eventsSeen.push(input.event)
                    return { continue: true }
                },
            })
        }

        for (const ev of ALL_11_EVENTS) {
            const res = await HookProvider.execute(
                ev,
                { event: ev, sessionId: 's-1', payload: {} },
                { extensionRegistry: registry },
            )
            expect(res.continue).toBe(true)
        }

        expect(eventsSeen).toEqual(ALL_11_EVENTS)
    })

    it('exposes facade methods on HookProvider class', async () => {
        expect(typeof HookProvider.runHook).toBe('function')
        expect(typeof HookProvider.execute).toBe('function')
    })
})
