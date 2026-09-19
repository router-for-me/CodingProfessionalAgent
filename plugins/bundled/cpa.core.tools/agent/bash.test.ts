import { describe, expect, it, vi } from 'vitest'
import { FakeNativeBridge } from './testUtils.js'
import type { ProcessStartInput } from './types.js'
import { createBashTool, validateBashArgs } from './bash.js'
import type { ToolExecutionContext, ToolResult } from './types.js'

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

function prepareUnixBash(bridge: FakeNativeBridge): void {
    bridge.setRuntimeInfo({ platform: 'linux' })
    bridge.setFile('/bin/bash', '')
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

describe('validateBashArgs', () => {
    it('accepts command and optional timeout without mutating input', () => {
        const input = { command: 'echo hi', timeout: 12 }
        const snapshot = { ...input }
        expect(validateBashArgs(input)).toEqual({ command: 'echo hi', timeout: 12 })
        expect(input).toEqual(snapshot)
    })

    it('rejects empty/non-string command and unknown keys', () => {
        expect(() => validateBashArgs({ command: '' })).toThrow(/command/i)
        expect(() => validateBashArgs({ command: 1 })).toThrow(/command/i)
        expect(() => validateBashArgs({ command: 'x', extra: true })).toThrow(/unknown/i)
    })

    it('rejects non-finite, non-positive, and oversize timeouts', () => {
        expect(() => validateBashArgs({ command: 'x', timeout: 0 })).toThrow(/timeout/i)
        expect(() => validateBashArgs({ command: 'x', timeout: -1 })).toThrow(/timeout/i)
        expect(() => validateBashArgs({ command: 'x', timeout: Number.NaN })).toThrow(/timeout/i)
        expect(() => validateBashArgs({ command: 'x', timeout: Number.POSITIVE_INFINITY })).toThrow(
            /timeout/i,
        )
        // JS timer max is 2_147_483_647 ms
        expect(() =>
            validateBashArgs({ command: 'x', timeout: 2_147_483_647 / 1000 + 1 }),
        ).toThrow(/timeout/i)
        expect(validateBashArgs({ command: 'x', timeout: 2_147_483_647 / 1000 })).toEqual({
            command: 'x',
            timeout: 2_147_483_647 / 1000,
        })
    })

    it('schema declares command minLength 1 and timeout exclusiveMinimum/maximum', () => {
        const tool = createBashTool('/repo', new FakeNativeBridge())
        const schema = tool.parameters as {
            properties: {
                command: { minLength?: number }
                timeout: { exclusiveMinimum?: number; maximum?: number }
            }
        }
        expect(schema.properties.command.minLength).toBe(1)
        expect(schema.properties.timeout.exclusiveMinimum).toBe(0)
        expect(schema.properties.timeout.maximum).toBe(2_147_483_647 / 1000)
    })
})

describe('createBashTool', () => {
    it('preserves head and tail complete lines and exposes the full output path when truncated', async () => {
        const bridge = new FakeNativeBridge()
        prepareUnixBash(bridge)
        bridge.queueProcess({
            chunks: ['line1\nline2\n', 'line3\n'],
            exitCode: 0,
            fullOutputPath: '/tmp/full.log',
        })
        const result = await createBashTool('/repo', bridge, {
            maxLines: 2,
            maxBytes: 1024,
        }).execute('call', { command: 'test' }, toolContext())
        const text = textOf(result)
        expect(text).toContain('line1')
        expect(text).toContain('line3')
        expect(text).toContain('1 line truncated')
        expect((result.details as { fullOutputPath?: string }).fullOutputPath).toBe('/tmp/full.log')
        // Truncated output keeps the path (no delete).
        expect(bridge.calls.some((call) => call.method === 'removeFile')).toBe(false)
    })

    it('invokes the resolved shell with -c and cwd without quoting the command', async () => {
        const bridge = new FakeNativeBridge()
        prepareUnixBash(bridge)
        bridge.queueProcess({
            chunks: ['ok\n'],
            exitCode: 0,
            fullOutputPath: '/tmp/ok.log',
        })
        await createBashTool('/repo', bridge).execute(
            'call-invoke',
            { command: 'echo "a b" && true' },
            toolContext(),
        )
        const start = bridge.calls.find((call) => call.method === 'startProcess')
        expect(start).toBeDefined()
        const input = start!.args[0] as ProcessStartInput
        expect(input.executable).toBe('/bin/bash')
        expect(input.args).toEqual(['-c', 'echo "a b" && true'])
        expect(input.cwd).toBe('/repo')
        expect(input.stdin).toBeUndefined()
    })

    it('uses stdin transport for legacy WSL bash without appending command as arg', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setRuntimeInfo({ platform: 'windows' })
        bridge.setLookPath('bash.exe', 'C:\\Windows\\System32\\bash.exe')
        bridge.queueProcess({
            chunks: ['ok\n'],
            exitCode: 0,
            fullOutputPath: '/tmp/wsl.log',
        })
        await createBashTool('/repo', bridge, {
            env: { ProgramFiles: 'C:\\Program Files' },
        }).execute('call-wsl', { command: 'echo hi' }, toolContext())
        const start = bridge.calls.find((call) => call.method === 'startProcess')
        const input = start!.args[0] as ProcessStartInput
        expect(input.executable).toBe('C:\\Windows\\System32\\bash.exe')
        expect(input.args).toEqual(['-s'])
        expect(input.stdin).toBe('echo hi')
    })

    it('returns (no output) when the process emits nothing', async () => {
        const bridge = new FakeNativeBridge()
        prepareUnixBash(bridge)
        bridge.queueProcess({
            chunks: [],
            exitCode: 0,
            fullOutputPath: '/tmp/empty.log',
        })
        const result = await createBashTool('/repo', bridge).execute(
            'call-empty',
            { command: 'true' },
            toolContext(),
        )
        expect(textOf(result)).toBe('(no output)')
    })

    it('deletes full output path on untruncated success', async () => {
        const bridge = new FakeNativeBridge()
        prepareUnixBash(bridge)
        bridge.setFile('/tmp/small.log', 'placeholder')
        bridge.queueProcess({
            chunks: ['hi\n'],
            exitCode: 0,
            fullOutputPath: '/tmp/small.log',
        })
        const result = await createBashTool('/repo', bridge, {
            maxLines: 100,
            maxBytes: 10_000,
        }).execute('call-del', { command: 'echo hi' }, toolContext())
        expect(textOf(result)).toBe('hi\n')
        expect((result.details as { fullOutputPath?: string } | undefined)?.fullOutputPath).toBeUndefined()
        expect(bridge.calls.some((call) => call.method === 'removeFile' && call.args[0] === '/tmp/small.log')).toBe(
            true,
        )
    })

    it('throws non-zero exit with existing output and exit status', async () => {
        const bridge = new FakeNativeBridge()
        prepareUnixBash(bridge)
        bridge.queueProcess({
            chunks: ['boom\n'],
            exitCode: 7,
            fullOutputPath: '/tmp/nz2.log',
        })
        await expect(
            createBashTool('/repo', bridge).execute('call-nz2', { command: 'false' }, toolContext()),
        ).rejects.toThrow(/boom[\s\S]*Command exited with code 7/)
    })

    it('merges stderr after stdout by event sequence', async () => {
        const bridge = new FakeNativeBridge()
        prepareUnixBash(bridge)
        bridge.queueProcess({
            chunks: ['out\n'],
            stderrChunks: ['err\n'],
            exitCode: 0,
            fullOutputPath: '/tmp/mix.log',
        })
        const result = await createBashTool('/repo', bridge).execute(
            'call-mix',
            { command: 'mixed' },
            toolContext(),
        )
        expect(textOf(result)).toBe('out\nerr\n')
    })

    it('surfaces native process error events', async () => {
        const bridge = new FakeNativeBridge()
        prepareUnixBash(bridge)
        bridge.queueProcess({
            error: 'spawn failed',
            fullOutputPath: '/tmp/err.log',
        })
        await expect(
            createBashTool('/repo', bridge).execute('call-err', { command: 'x' }, toolContext()),
        ).rejects.toThrow(/spawn failed/)
    })

    it('includes truncation footer and full path when output is truncated', async () => {
        const bridge = new FakeNativeBridge()
        prepareUnixBash(bridge)
        bridge.queueProcess({
            chunks: ['line1\nline2\nline3\n'],
            exitCode: 0,
            fullOutputPath: '/tmp/trunc.log',
        })
        const result = await createBashTool('/repo', bridge, {
            maxLines: 1,
            maxBytes: 1024,
        }).execute('call-trunc', { command: 'seq' }, toolContext())
        const text = textOf(result)
        expect(text).toContain('line1')
        expect(text).toMatch(/Full output: \/tmp\/trunc\.log/)
        expect((result.details as { truncation?: { truncated?: boolean } }).truncation?.truncated).toBe(
            true,
        )
    })

    it('returns head and tail with middle omission for large multi-line bash output', async () => {
        const bridge = new FakeNativeBridge()
        prepareUnixBash(bridge)
        const longLines = Array.from({ length: 50 }, (_, i) => `cmd_output_line_${i + 1}`).join('\n') + '\n'
        bridge.queueProcess({
            chunks: [longLines],
            exitCode: 0,
            fullOutputPath: '/tmp/large-bash.log',
        })
        const tool = createBashTool('/repo', bridge, { maxLines: 6, maxBytes: 10_000 })
        const result = await tool.execute('call-large', { command: 'seq 50' }, toolContext())
        const text = textOf(result)
        // Head lines present
        expect(text).toContain('cmd_output_line_1')
        expect(text).toContain('cmd_output_line_3')
        // Middle omitted
        expect(text).not.toContain('cmd_output_line_25')
        // Tail lines present
        expect(text).toContain('cmd_output_line_48')
        expect(text).toContain('cmd_output_line_50')
        // Middle marker and footer with fullOutputPath
        expect(text).toContain('truncated')
        expect(text).toContain('Full output: /tmp/large-bash.log')
        expect(text).toContain('[Showing lines')
        expect((result.details as { fullOutputPath?: string }).fullOutputPath).toBe('/tmp/large-bash.log')
        expect(bridge.calls.some((call) => call.method === 'removeFile')).toBe(false)
    })

    it('does not drop tail when head and tail content strings are identical', async () => {
        const bridge = new FakeNativeBridge()
        prepareUnixBash(bridge)
        bridge.queueProcess({
            chunks: ['STATUS_OK\nmiddle_1\nmiddle_2\nmiddle_3\nSTATUS_OK\n'],
            exitCode: 0,
            fullOutputPath: '/tmp/same-content.log',
        })
        const tool = createBashTool('/repo', bridge, { maxLines: 2, maxBytes: 10_000 })
        const result = await tool.execute('call-same', { command: 'check' }, toolContext())
        const text = textOf(result)

        // Both STATUS_OK occurrences must be present
        const matches = text.match(/STATUS_OK/g)
        expect(matches?.length).toBe(2)
        expect(text).toContain('truncated')
        expect(text).toContain('Full output: /tmp/same-content.log')
    })

    it('formats single long line with trailing newline using head and tail footer', async () => {
        const bridge = new FakeNativeBridge()
        prepareUnixBash(bridge)
        const longSingleLine = 'x'.repeat(40) + 'END\n'
        bridge.queueProcess({
            chunks: [longSingleLine],
            exitCode: 0,
            fullOutputPath: '/tmp/single-newline.log',
        })
        const tool = createBashTool('/repo', bridge, { maxLines: 10, maxBytes: 10 })
        const result = await tool.execute('call-single', { command: 'echo long' }, toolContext())
        const text = textOf(result)

        expect(text).toContain('END')
        expect(text).toContain('Showing head and tail of line 1')
        expect(text).not.toContain('line is 0B')
        expect(text).toContain('Full output: /tmp/single-newline.log')
    })

    it('formats single long line with maxLines=1 as showing head of line 1', async () => {
        const bridge = new FakeNativeBridge()
        prepareUnixBash(bridge)
        bridge.queueProcess({
            chunks: ['abcdefghijklmnop'],
            exitCode: 0,
            fullOutputPath: '/tmp/head-only.log',
        })
        const tool = createBashTool('/repo', bridge, { maxLines: 1, maxBytes: 10 })
        const result = await tool.execute('call-head-only', { command: 'echo abc' }, toolContext())
        const text = textOf(result)

        expect(text).toContain('abcde')
        expect(text).toContain('Showing head of line 1')
        expect(text).not.toContain('Showing last')
        expect(text).not.toContain('line is 16B')
        expect(text).toContain('Full output: /tmp/head-only.log')
    })
})
