import { describe, expect, it } from 'vitest'
import { FakeNativeBridge } from './testUtils.js'
import type { ProcessStartInput } from './types.js'
import { createPwshTool, validatePwshArgs } from './pwsh.js'
import type { ToolExecutionContext, ToolResult } from './types.js'
import { UTF8_OUTPUT_PREFIX } from './shell.js'

function toolContext(
    signal?: AbortSignal,
    onUpdate?: (partial: ToolResult) => void,
): ToolExecutionContext {
    return { signal, cwd: '/repo', onUpdate }
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n')
}

function prepareWindowsPwsh(bridge: FakeNativeBridge): void {
    bridge.setRuntimeInfo({ platform: 'win32' })
    bridge.setLookPath('pwsh.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')
}

type FakeClock = {
    now: () => number
    advance: (ms: number) => void
    schedule: (fn: () => void, delayMs: number) => number
    cancelSchedule: (handle: unknown) => void
}

function createFakeClock(): FakeClock {
    let nowMs = 0
    let nextId = 1
    const timers = new Map<number, { at: number; fn: () => void }>()

    const runDue = (): void => {
        let progressed = true
        while (progressed) {
            progressed = false
            for (const [id, timer] of [...timers.entries()]) {
                if (timer.at <= nowMs) {
                    timers.delete(id)
                    timer.fn()
                    progressed = true
                }
            }
        }
    }

    return {
        now: () => nowMs,
        advance(ms: number) {
            nowMs += ms
            runDue()
        },
        schedule(fn: () => void, delayMs: number) {
            const id = nextId
            nextId += 1
            timers.set(id, { at: nowMs + delayMs, fn })
            return id
        },
        cancelSchedule(handle: unknown) {
            if (typeof handle === 'number') {
                timers.delete(handle)
            }
        },
    }
}

async function waitForStartProcess(
    bridge: FakeNativeBridge,
    attempts = 50,
): Promise<ProcessStartInput> {
    for (let i = 0; i < attempts; i += 1) {
        const start = bridge.calls.find((call) => call.method === 'startProcess')
        if (start) {
            return start.args[0] as ProcessStartInput
        }
        await Promise.resolve()
    }
    throw new Error('startProcess was not called')
}

describe('validatePwshArgs', () => {
    it('accepts command and optional timeout without mutating input', () => {
        const input = { command: 'Get-ChildItem', timeout: 15 }
        const snapshot = { ...input }
        expect(validatePwshArgs(input)).toEqual({ command: 'Get-ChildItem', timeout: 15 })
        expect(input).toEqual(snapshot)
    })

    it('rejects empty/non-string command and unknown keys', () => {
        expect(() => validatePwshArgs({ command: '' })).toThrow(/command/i)
        expect(() => validatePwshArgs({ command: 123 })).toThrow(/command/i)
        expect(() => validatePwshArgs({ command: 'dir', extra: true })).toThrow(/unknown/i)
    })

    it('rejects invalid timeouts', () => {
        expect(() => validatePwshArgs({ command: 'dir', timeout: 0 })).toThrow(/timeout/i)
        expect(() => validatePwshArgs({ command: 'dir', timeout: -5 })).toThrow(/timeout/i)
    })
})

describe('createPwshTool', () => {
    it('validates construction bounds', () => {
        const bridge = new FakeNativeBridge()
        expect(() => createPwshTool('/repo', bridge, { maxLines: 0 })).toThrow(/maxLines/)
        expect(() => createPwshTool('/repo', bridge, { maxBytes: -1 })).toThrow(/maxBytes/)
    })

    it('exposes tool definition properties with pwsh name and description', () => {
        const bridge = new FakeNativeBridge()
        const tool = createPwshTool('/repo', bridge)
        expect(tool.name).toBe('pwsh')
        expect(tool.label).toBe('pwsh')
        expect(tool.description).toContain('PowerShell/pwsh')
        expect(tool.parameters).toHaveProperty('type', 'object')
    })

    it('executes pwsh commands on Windows prepending UTF8 prefix', async () => {
        const bridge = new FakeNativeBridge()
        prepareWindowsPwsh(bridge)

        bridge.queueProcess({
            chunks: ['hello from powershell\r\n'],
            exitCode: 0,
            fullOutputPath: '/tmp/pwsh-out.log',
        })

        const tool = createPwshTool('/repo', bridge)
        const result = await tool.execute('call-1', { command: 'Write-Output "hello from powershell"' }, toolContext())

        expect(textOf(result)).toContain('hello from powershell')

        const startInput = await waitForStartProcess(bridge)
        expect(startInput.executable).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
        expect(startInput.args).toContain(`${UTF8_OUTPUT_PREFIX}Write-Output "hello from powershell"`)
    })

    it('handles non-zero exit code as error with status diagnostic', async () => {
        const bridge = new FakeNativeBridge()
        prepareWindowsPwsh(bridge)

        bridge.queueProcess({
            chunks: ['Command not recognized\r\n'],
            exitCode: 1,
            fullOutputPath: '/tmp/pwsh-err.log',
        })

        const tool = createPwshTool('/repo', bridge)
        await expect(
            tool.execute('call-2', { command: 'invalid-command' }, toolContext()),
        ).rejects.toThrow(/Command exited with code 1/)
    })

    it('handles timeout correctly', async () => {
        const bridge = new FakeNativeBridge()
        prepareWindowsPwsh(bridge)

        const clock = createFakeClock()
        bridge.queueProcess({
            chunks: ['starting long task...\n'],
            exitCode: 0,
            fullOutputPath: '/tmp/timeout.log',
            hold: true,
        })

        const tool = createPwshTool('/repo', bridge, {
            now: clock.now,
            schedule: clock.schedule,
            cancelSchedule: clock.cancelSchedule,
        })

        const runPromise = tool.execute(
            'call-timeout',
            { command: 'Start-Sleep 10', timeout: 5 },
            toolContext(),
        )

        await waitForStartProcess(bridge)
        clock.advance(5500)

        await expect(runPromise).rejects.toThrow(/Command timed out after 5 seconds/)
    })

    it('handles user abort signal', async () => {
        const bridge = new FakeNativeBridge()
        prepareWindowsPwsh(bridge)

        const controller = new AbortController()
        bridge.queueProcess({
            chunks: ['working...\n'],
            exitCode: 0,
            fullOutputPath: '/tmp/abort.log',
            hold: true,
        })

        const tool = createPwshTool('/repo', bridge)
        const runPromise = tool.execute(
            'call-abort',
            { command: 'long-running' },
            toolContext(controller.signal),
        )

        await waitForStartProcess(bridge)
        controller.abort()

        await expect(runPromise).rejects.toThrow(/Command aborted/)
    })

    it('emits live streamed output via onUpdate', async () => {
        const bridge = new FakeNativeBridge()
        prepareWindowsPwsh(bridge)

        const updates: string[] = []

        bridge.queueProcess({
            chunks: ['line 1\n', 'line 2\n'],
            exitCode: 0,
            fullOutputPath: '/tmp/stream.log',
        })

        const tool = createPwshTool('/repo', bridge)

        const result = await tool.execute(
            'call-stream',
            { command: 'Get-Process' },
            toolContext(undefined, (partial) => {
                const text = textOf(partial)
                if (text) updates.push(text)
            }),
        )

        expect(textOf(result)).toContain('line 1\nline 2')
    })
})
