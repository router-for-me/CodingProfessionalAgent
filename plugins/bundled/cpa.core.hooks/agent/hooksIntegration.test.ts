import { describe, expect, it } from 'vitest'
import { HookEngine } from './hookEngine.js'
import { FakeNativeBridge } from './testUtils.js'
import type { HookContribution } from '@cpa/plugin-api'

describe('cpa.core.hooks integration', () => {
    it('dispatches lifecycle events to plugin hook contributions and command hooks in order', async () => {
        const bridge = new FakeNativeBridge()
        const order: string[] = []

        const pluginHook: HookContribution = {
            id: 'test.plugin.pre-tool',
            event: 'PreToolUse',
            order: 10,
            failureMode: 'open',
            execute: async (_input) => {
                order.push('plugin-hook')
                return { continue: true }
            },
        }

        const engine = new HookEngine({
            bridge,
            cwd: '/test/project',
            hooks: [pluginHook],
        })

        const outcome = await engine.executePreToolUse({
            hook_event_name: 'PreToolUse',
            session_id: 'session-1',
            cwd: '/test/project',
            model: 'gpt-4o',
            permission_mode: 'default',
            tool_name: 'read',
            tool_input: { path: 'a.txt' },
            tool_use_id: 'call-1',
        })

        expect(order).toEqual(['plugin-hook'])
        expect(outcome.shouldStop).toBe(false)
        expect(outcome.decision).toBe('approve')
    })

    it('isolates fail-open hook contribution errors', async () => {
        const bridge = new FakeNativeBridge()
        const failingHook: HookContribution = {
            id: 'test.failing.hook',
            event: 'SessionStart',
            order: 10,
            failureMode: 'open',
            execute: async () => {
                throw new Error('plugin hook exploded')
            },
        }

        const engine = new HookEngine({
            bridge,
            cwd: '/test/project',
            hooks: [failingHook],
        })

        const outcome = await engine.executeSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-1',
            cwd: '/test/project',
            model: 'gpt-4o',
            permission_mode: 'default',
            source: 'startup',
        })

        // Fail-open does not stop execution
        expect(outcome.shouldStop).toBe(false)
    })

    it('stops execution when a plugin hook returns continue: false', async () => {
        const bridge = new FakeNativeBridge()
        const blockingHook: HookContribution = {
            id: 'test.blocking.hook',
            event: 'PreToolUse',
            order: 10,
            failureMode: 'closed',
            execute: async () => {
                return { continue: false, message: 'Action disallowed by governance policy' }
            },
        }

        const engine = new HookEngine({
            bridge,
            cwd: '/test/project',
            hooks: [blockingHook],
        })

        const outcome = await engine.executePreToolUse({
            hook_event_name: 'PreToolUse',
            session_id: 'session-1',
            cwd: '/test/project',
            model: 'gpt-4o',
            permission_mode: 'default',
            tool_name: 'bash',
            tool_input: { command: 'drop database' },
            tool_use_id: 'call-2',
        })

        expect(outcome.shouldStop).toBe(true)
        expect(outcome.decision).toBe('block')
        expect(outcome.blockReason).toBe('Action disallowed by governance policy')
    })
})
