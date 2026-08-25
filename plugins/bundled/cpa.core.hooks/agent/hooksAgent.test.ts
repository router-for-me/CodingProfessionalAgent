import { describe, it, expect } from 'vitest'
import { matchesMatcher, validateMatcherPattern } from './matcher.js'
import { computeHookHash } from './hash.js'
import { parseHookCommandOutput, applyAdditionalContextLimit } from './outputParser.js'
import { HookEngine } from './hookEngine.js'
import { loadUserHooks, convertConfigFileToMetadata } from './discovery.js'
import { FakeNativeBridge } from './testUtils.js'
import type { HooksConfigFile } from './types.js'
import { hooksAgentEntry } from './index.js'
import type { HookContribution, PluginContext } from '@cpa/plugin-api'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import manifest from '../manifest.json'

describe('Hook Matcher', () => {
    it('matches everything when matcher is null, undefined, or empty', () => {
        expect(matchesMatcher(null, 'bash')).toBe(true)
        expect(matchesMatcher(undefined, 'bash')).toBe(true)
        expect(matchesMatcher('', 'bash')).toBe(true)
        expect(matchesMatcher('   ', 'bash')).toBe(true)
    })

    it('matches regex pattern against tool names', () => {
        expect(matchesMatcher('bash|edit', 'bash')).toBe(true)
        expect(matchesMatcher('bash|edit', 'edit')).toBe(true)
        expect(matchesMatcher('bash|edit', 'read')).toBe(false)
        expect(matchesMatcher('^bash$', 'bash')).toBe(true)
        expect(matchesMatcher('^bash$', 'bash_extra')).toBe(false)
    })

    it('validates regex patterns correctly', () => {
        expect(validateMatcherPattern('bash|edit').valid).toBe(true)
        expect(validateMatcherPattern('[').valid).toBe(false)
    })
})

describe('Hook Output Parser', () => {
    it('parses valid JSON output with hookSpecificOutput', () => {
        const stdout = JSON.stringify({
            continue: true,
            systemMessage: 'All checks passed',
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                additionalContext: 'Context from hook',
            },
        })
        const parsed = parseHookCommandOutput(stdout, '', 0)
        expect(parsed.success).toBe(true)
        expect(parsed.data.continue).toBe(true)
        expect(parsed.data.systemMessage).toBe('All checks passed')
        expect((parsed.data as any).hookSpecificOutput?.permissionDecision).toBe('allow')
        expect((parsed.data as any).hookSpecificOutput?.additionalContext).toBe('Context from hook')
        expect(parsed.entries.length).toBeGreaterThan(0)
    })

    it('handles non-zero exit code and error stderr', () => {
        const parsed = parseHookCommandOutput('', 'Error in script', 1)
        expect(parsed.success).toBe(false)
        expect(parsed.data.continue).toBe(false)
        expect(parsed.entries).toContainEqual({
            kind: 'error',
            text: 'Error in script',
        })
    })

    it('applies additional context limit', () => {
        const longText = 'a'.repeat(20000)
        const res = applyAdditionalContextLimit(longText, 500)
        expect(res.truncated).toBe(true)
        expect(res.text.length).toBeLessThan(longText.length)
    })
})

describe('Hook Hash', () => {
    it('computes stable hash for identical configurations', async () => {
        const hash1 = await computeHookHash('PreToolUse', 'bash', {
            type: 'command',
            command: 'echo "test"',
            timeout: 30,
        })
        const hash2 = await computeHookHash('PreToolUse', 'bash', {
            type: 'command',
            command: 'echo "test"',
            timeout: 30,
        })
        expect(hash1).toBe(hash2)
    })

    it('loads user hooks and converts to metadata', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setRuntimeInfo({
            platform: 'darwin',
            homeDir: '/test/home',
            userConfigDir: '/test/home/.config',
            tempDir: '/tmp',
        })

        const userHooksFile: HooksConfigFile = {
            hooks: {
                PreToolUse: [
                    {
                        matcher: 'bash',
                        hooks: [
                            {
                                type: 'command',
                                command: 'check-bash.sh',
                                timeout: 10,
                            },
                        ],
                    },
                ],
            },
            state: {},
        }

        await bridge.mkdirAll('/test/home/.coding-professional-agent')
        await bridge.writeFile(
            '/test/home/.coding-professional-agent/hooks.json',
            new TextEncoder().encode(JSON.stringify(userHooksFile)),
        )

        const userRes = await loadUserHooks(bridge)
        expect(userRes.file.hooks?.PreToolUse?.length).toBe(1)
        const meta = await convertConfigFileToMetadata(userRes.file, 'user', userRes.path)
        expect(meta.length).toBe(1)
        expect(meta[0].eventName).toBe('PreToolUse')
    })
})

describe('Hook Engine', () => {
    it('executes pre-tool-use hook and modifies decision or input', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setRuntimeInfo({
            platform: 'darwin',
            homeDir: '/test/home',
            userConfigDir: '/test/home/.config',
            tempDir: '/tmp',
        })

        const userHooksFile: HooksConfigFile = {
            hooks: {
                PreToolUse: [
                    {
                        matcher: 'bash',
                        hooks: [
                            {
                                type: 'command',
                                command: 'check-bash.sh',
                                timeout: 10,
                            },
                        ],
                    },
                ],
            },
            state: {},
        }

        await bridge.mkdirAll('/test/home/.coding-professional-agent')
        await bridge.writeFile(
            '/test/home/.coding-professional-agent/hooks.json',
            new TextEncoder().encode(JSON.stringify(userHooksFile)),
        )

        bridge.queueProcess({
            chunks: [
                JSON.stringify({
                    continue: true,
                    decision: 'approve',
                    hookSpecificOutput: {
                        permissionDecision: 'allow',
                        additionalContext: 'Injected environment context',
                    },
                }),
            ],
            exitCode: 0,
        })

        const engine = new HookEngine({ bridge, cwd: '/test/project' })
        const activeHooks = await engine.getActiveHooks()
        expect(activeHooks.length).toBe(1)
        expect(activeHooks[0].eventName).toBe('PreToolUse')

        const outcome = await engine.executePreToolUse({
            hook_event_name: 'PreToolUse',
            session_id: 'session-1',
            cwd: '/test/project',
            model: 'gpt-4o',
            permission_mode: 'default',
            tool_name: 'bash',
            tool_input: { command: 'ls' },
            tool_use_id: 'tool-1',
        })

        expect(outcome.shouldStop).toBe(false)
        expect(outcome.decision).toBe('approve')
        expect(outcome.permissionDecision).toBe('allow')
        expect(outcome.additionalContexts).toContain('Injected environment context')
    })

    it('blocks tool when hook returns decision block or continue false', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setRuntimeInfo({
            platform: 'darwin',
            homeDir: '/test/home',
            userConfigDir: '/test/home/.config',
            tempDir: '/tmp',
        })

        const userHooksFile: HooksConfigFile = {
            hooks: {
                PreToolUse: [
                    {
                        matcher: 'bash',
                        hooks: [
                            {
                                type: 'command',
                                command: 'block-bash.sh',
                            },
                        ],
                    },
                ],
            },
        }

        await bridge.mkdirAll('/test/home/.coding-professional-agent')
        await bridge.writeFile(
            '/test/home/.coding-professional-agent/hooks.json',
            new TextEncoder().encode(JSON.stringify(userHooksFile)),
        )

        bridge.queueProcess({
            chunks: [
                JSON.stringify({
                    continue: true,
                    decision: 'block',
                    reason: 'Dangerous command blocked by policy',
                }),
            ],
            exitCode: 0,
        })

        const engine = new HookEngine({ bridge, cwd: '/test/project' })
        const outcome = await engine.executePreToolUse({
            hook_event_name: 'PreToolUse',
            session_id: 'session-1',
            cwd: '/test/project',
            model: 'gpt-4o',
            permission_mode: 'default',
            tool_name: 'bash',
            tool_input: { command: 'rm -rf /' },
            tool_use_id: 'tool-2',
        })

        expect(outcome.decision).toBe('block')
        expect(outcome.blockReason).toBe('Dangerous command blocked by policy')
    })

    it('executes session-start hook and collects additional context', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setRuntimeInfo({
            platform: 'darwin',
            homeDir: '/test/home',
            userConfigDir: '/test/home/.config',
            tempDir: '/tmp',
        })

        const userHooksFile: HooksConfigFile = {
            hooks: {
                SessionStart: [
                    {
                        matcher: 'startup|resume',
                        hooks: [
                            {
                                type: 'command',
                                command: 'startup-hook.sh',
                            },
                        ],
                    },
                ],
            },
        }

        await bridge.mkdirAll('/test/home/.coding-professional-agent')
        await bridge.writeFile(
            '/test/home/.coding-professional-agent/hooks.json',
            new TextEncoder().encode(JSON.stringify(userHooksFile)),
        )

        bridge.queueProcess({
            chunks: [
                JSON.stringify({
                    continue: true,
                    hookSpecificOutput: {
                        hookEventName: 'SessionStart',
                        additionalContext: 'Session startup initialized',
                    },
                }),
            ],
            exitCode: 0,
        })

        const engine = new HookEngine({ bridge, cwd: '/test/project' })
        const outcome = await engine.executeSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-1',
            cwd: '/test/project',
            model: 'gpt-4o',
            permission_mode: 'default',
            source: 'startup',
        })

        expect(outcome.shouldStop).toBe(false)
        expect(outcome.additionalContexts).toContain('Session startup initialized')
    })

    it('executes post-tool-use and user-prompt-submit hooks', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setRuntimeInfo({
            platform: 'darwin',
            homeDir: '/test/home',
            userConfigDir: '/test/home/.config',
            tempDir: '/tmp',
        })

        const userHooksFile: HooksConfigFile = {
            hooks: {
                PostToolUse: [
                    {
                        matcher: 'read',
                        hooks: [
                            {
                                type: 'command',
                                command: 'post-read.sh',
                            },
                        ],
                    },
                ],
                UserPromptSubmit: [
                    {
                        hooks: [
                            {
                                type: 'command',
                                command: 'on-prompt.sh',
                            },
                        ],
                    },
                ],
            },
        }

        await bridge.mkdirAll('/test/home/.coding-professional-agent')
        await bridge.writeFile(
            '/test/home/.coding-professional-agent/hooks.json',
            new TextEncoder().encode(JSON.stringify(userHooksFile)),
        )

        bridge.queueProcess({
            chunks: [
                JSON.stringify({
                    continue: true,
                    hookSpecificOutput: {
                        hookEventName: 'PostToolUse',
                        additionalContext: 'Post-read advisory',
                    },
                }),
            ],
            exitCode: 0,
        })

        bridge.queueProcess({
            chunks: [
                JSON.stringify({
                    continue: true,
                    hookSpecificOutput: {
                        hookEventName: 'UserPromptSubmit',
                        additionalContext: 'Prompt augmentation',
                    },
                }),
            ],
            exitCode: 0,
        })

        const engine = new HookEngine({ bridge, cwd: '/test/project' })

        const postToolOutcome = await engine.executePostToolUse({
            hook_event_name: 'PostToolUse',
            session_id: 'session-1',
            cwd: '/test/project',
            model: 'gpt-4o',
            permission_mode: 'default',
            tool_name: 'read',
            tool_input: { path: 'a.txt' },
            tool_output: 'hello world',
            tool_use_id: 'tool-read-1',
        })
        expect(postToolOutcome.additionalContexts).toContain('Post-read advisory')

        const promptOutcome = await engine.executeUserPromptSubmit({
            hook_event_name: 'UserPromptSubmit',
            session_id: 'session-1',
            cwd: '/test/project',
            model: 'gpt-4o',
            permission_mode: 'default',
            prompt: 'Explain the repo structure',
        })
        expect(promptOutcome.additionalContexts).toContain('Prompt augmentation')
    })
})

describe('cpa.core.hooks agent entry & manifest contract', () => {
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

    it('declares all 11 hook lifecycle events in manifest contributes.hook', () => {
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes.hook).toBeDefined()
        expect(manifest.contributes.hook).toEqual(expect.arrayContaining(ALL_11_EVENTS))
        expect(manifest.contributes.hook).toHaveLength(11)
    })

    it('registers all 11 HookContribution instances on activate', async () => {
        const registered = new Map<string, HookContribution>()
        const fakeContext: Partial<PluginContext> = {
            register: ((contrib: any) => {
                if (contrib.kind === 'hook') {
                    registered.set(contrib.id, contrib.value)
                }
            }) as any,
        }

        await hooksAgentEntry.activate(fakeContext as PluginContext)

        for (const eventName of ALL_11_EVENTS) {
            expect(registered.has(eventName)).toBe(true)
            const hook = registered.get(eventName)!
            expect(hook.event).toBe(eventName)
            expect(typeof hook.execute).toBe('function')
            expect(typeof hook.order).toBe('number')
            expect(hook.failureMode).toBe('open')
        }
    })

    it('cleans up all 11 registered contributions on deactivate via test harness', async () => {
        const harness = createPluginTestHarness(hooksAgentEntry, {
            manifest: manifest as any,
        })

        await harness.activate()
        const hooks = harness.getRegistered<HookContribution>('hook')
        expect(hooks).toHaveLength(11)

        await harness.deactivate()
        const afterDeactivate = harness.getRegistered<HookContribution>('hook')
        expect(afterDeactivate).toHaveLength(0)
    })

    it('executes real handlers for all 11 lifecycle events through registered HookContributions', async () => {
        const harness = createPluginTestHarness(hooksAgentEntry, {
            manifest: manifest as any,
        })
        await harness.activate()

        const hooksByEvent = new Map<string, HookContribution>()
        for (const reg of harness.getRegistered<HookContribution>('hook')) {
            hooksByEvent.set(reg.value.event, reg.value)
        }

        // 1. SessionStart
        const resStart = await hooksByEvent.get('SessionStart')!.execute({
            event: 'SessionStart',
            sessionId: 'sess-test',
            payload: { hook_event_name: 'SessionStart', session_id: 'sess-test', cwd: '/test', model: 'gpt-4o', permission_mode: 'default', source: 'startup' },
        })
        expect(resStart.continue).toBe(true)

        // 2. UserPromptSubmit
        const resPrompt = await hooksByEvent.get('UserPromptSubmit')!.execute({
            event: 'UserPromptSubmit',
            sessionId: 'sess-test',
            payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess-test', cwd: '/test', model: 'gpt-4o', permission_mode: 'default', prompt: 'hello' },
        })
        expect(resPrompt.continue).toBe(true)

        // 3. PreToolUse
        const resPreTool = await hooksByEvent.get('PreToolUse')!.execute({
            event: 'PreToolUse',
            sessionId: 'sess-test',
            payload: { hook_event_name: 'PreToolUse', session_id: 'sess-test', cwd: '/test', model: 'gpt-4o', permission_mode: 'default', tool_name: 'read', tool_input: { path: 'a.txt' }, tool_use_id: 't-1' },
        })
        expect(resPreTool.continue).toBe(true)

        // 4. PermissionRequest
        const resPerm = await hooksByEvent.get('PermissionRequest')!.execute({
            event: 'PermissionRequest',
            sessionId: 'sess-test',
            payload: { hook_event_name: 'PermissionRequest', session_id: 'sess-test', cwd: '/test', model: 'gpt-4o', permission_mode: 'default', tool_name: 'bash', tool_input: { command: 'ls' }, tool_use_id: 't-2' },
        })
        expect(resPerm.continue).toBe(true)

        // 5. PostToolUse
        const resPostTool = await hooksByEvent.get('PostToolUse')!.execute({
            event: 'PostToolUse',
            sessionId: 'sess-test',
            payload: { hook_event_name: 'PostToolUse', session_id: 'sess-test', cwd: '/test', model: 'gpt-4o', permission_mode: 'default', tool_name: 'read', tool_input: { path: 'a.txt' }, tool_output: 'ok', tool_use_id: 't-3' },
        })
        expect(resPostTool.continue).toBe(true)

        // 6. PreCompact
        const resPreCompact = await hooksByEvent.get('PreCompact')!.execute({
            event: 'PreCompact',
            sessionId: 'sess-test',
            payload: { hook_event_name: 'PreCompact', session_id: 'sess-test', cwd: '/test', trigger: 'manual' },
        })
        expect(resPreCompact.continue).toBe(true)

        // 7. PostCompact
        const resPostCompact = await hooksByEvent.get('PostCompact')!.execute({
            event: 'PostCompact',
            sessionId: 'sess-test',
            payload: { hook_event_name: 'PostCompact', session_id: 'sess-test', cwd: '/test', trigger: 'manual' },
        })
        expect(resPostCompact.continue).toBe(true)

        // 8. SubagentStart
        const resSubStart = await hooksByEvent.get('SubagentStart')!.execute({
            event: 'SubagentStart',
            sessionId: 'sess-test',
            payload: { hook_event_name: 'SubagentStart', session_id: 'sess-test', cwd: '/test', subagent_id: 'sub-1', name: 'child', task: 'analyze' },
        })
        expect(resSubStart.continue).toBe(true)

        // 9. SubagentStop
        const resSubStop = await hooksByEvent.get('SubagentStop')!.execute({
            event: 'SubagentStop',
            sessionId: 'sess-test',
            payload: { hook_event_name: 'SubagentStop', session_id: 'sess-test', cwd: '/test', subagent_id: 'sub-1', name: 'child', outcome: 'success' },
        })
        expect(resSubStop.continue).toBe(true)

        // 10. Stop
        const resStop = await hooksByEvent.get('Stop')!.execute({
            event: 'Stop',
            sessionId: 'sess-test',
            payload: { hook_event_name: 'Stop', session_id: 'sess-test', cwd: '/test', reason: 'user_cancel' },
        })
        expect(resStop.continue).toBe(true)

        // 11. SessionEnd
        const resEnd = await hooksByEvent.get('SessionEnd')!.execute({
            event: 'SessionEnd',
            sessionId: 'sess-test',
            payload: { hook_event_name: 'SessionEnd', session_id: 'sess-test', cwd: '/test', reason: 'closed' },
        })
        expect(resEnd.continue).toBe(true)
    })
})

