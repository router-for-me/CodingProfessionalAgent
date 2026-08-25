import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeNativeBridge } from './testUtils.js'
import { __resetFileMutationQueuesForTests } from './mutationQueue.js'
import { createEditTool, validateEditArgs } from './edit.js'
import { createWorktreeFileBoundary } from './worktreeBoundary.js'
import type { ToolExecutionContext } from './types.js'

afterEach(() => {
    __resetFileMutationQueuesForTests()
})

function toolContext(signal?: AbortSignal, extra?: Record<string, unknown>): ToolExecutionContext {
    return { signal, cwd: '/repo', ...extra }
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n')
}

function bytesOf(text: string): Uint8Array {
    return new TextEncoder().encode(text)
}

function decode(bytes: Uint8Array): string {
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
}

describe('edit tool validate', () => {
    it('accepts a normal edits array without mutating the input', () => {
        const input = {
            path: 'a.txt',
            edits: [{ oldText: 'a', newText: 'b' }],
        }
        const snapshot = structuredClone(input)
        expect(validateEditArgs(input)).toEqual(input)
        expect(input).toEqual(snapshot)
    })

    it('accepts edits provided as a JSON string without mutating the input', () => {
        const input = {
            path: 'a.txt',
            edits: JSON.stringify([{ oldText: 'a', newText: 'b' }]),
        }
        const snapshot = structuredClone(input)
        expect(validateEditArgs(input)).toEqual({
            path: 'a.txt',
            edits: [{ oldText: 'a', newText: 'b' }],
        })
        expect(input).toEqual(snapshot)
    })

    it('rejects invalid JSON / non-array / empty / wrong item shapes with clear errors', () => {
        expect(() => validateEditArgs({ path: 'a.txt', edits: '{not-json' })).toThrow(/JSON/i)
        expect(() => validateEditArgs({ path: 'a.txt', edits: JSON.stringify({ a: 1 }) })).toThrow(
            /array/i,
        )
        expect(() => validateEditArgs({ path: 'a.txt', edits: [] })).toThrow(/at least one/i)
        expect(() =>
            validateEditArgs({
                path: 'a.txt',
                edits: [{ oldText: 'a', newText: 'b', extra: true }],
            }),
        ).toThrow(/unknown|additional|extra/i)
        expect(() =>
            validateEditArgs({
                path: 'a.txt',
                edits: [{ oldText: 1, newText: 'b' }],
            }),
        ).toThrow(/oldText/i)
        expect(() =>
            validateEditArgs({
                path: 'a.txt',
                edits: [{ oldText: 'a', newText: 2 }],
            }),
        ).toThrow(/newText/i)
        expect(() => validateEditArgs({ path: '', edits: [{ oldText: 'a', newText: 'b' }] })).toThrow(
            /path/i,
        )
        expect(() =>
            validateEditArgs({
                path: 'a.txt',
                edits: [{ oldText: 'a', newText: 'b' }],
                mode: 'x',
            } as never),
        ).toThrow(/unknown/i)
    })

    it('declares schema with additionalProperties false and required fields', () => {
        const tool = createEditTool('/repo', new FakeNativeBridge())
        expect(tool.parameters).toMatchObject({
            type: 'object',
            required: expect.arrayContaining(['path', 'edits']),
            additionalProperties: false,
        })
        const props = tool.parameters.properties as Record<string, unknown>
        const pathSchema = props.path as Record<string, unknown>
        expect(pathSchema.minLength).toBe(1)

        const edits = props.edits as Record<string, unknown>
        const alts = (edits.oneOf ?? edits.anyOf) as Array<Record<string, unknown>>
        expect(Array.isArray(alts)).toBe(true)
        expect(alts.length).toBeGreaterThanOrEqual(2)

        const arrayAlt = alts.find((alt) => alt.type === 'array') as Record<string, unknown>
        const stringAlt = alts.find((alt) => alt.type === 'string') as Record<string, unknown>
        expect(arrayAlt).toBeDefined()
        expect(stringAlt).toBeDefined()
        expect(arrayAlt.minItems).toBe(1)
        expect(stringAlt.minLength).toBe(1)

        const items = arrayAlt.items as Record<string, unknown>
        expect(items.additionalProperties).toBe(false)
        expect(items.required).toEqual(expect.arrayContaining(['oldText', 'newText']))
        const itemProps = items.properties as Record<string, Record<string, unknown>>
        expect(itemProps.oldText.minLength).toBe(1)
    })

    it('rejects empty oldText at validation time (schema minLength 1)', () => {
        expect(() =>
            validateEditArgs({
                path: 'a.txt',
                edits: [{ oldText: '', newText: 'x' }],
            }),
        ).toThrow(/oldText/i)
    })
})

describe('edit tool execute', () => {
    it('applies multi-edit, returns strict success text and diff/patch details', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setFile('/repo/note.txt', 'alpha beta gamma\n')
        const tool = createEditTool('/repo', bridge)

        const result = await tool.execute(
            'e1',
            {
                path: 'note.txt',
                edits: [
                    { oldText: 'alpha', newText: 'A' },
                    { oldText: 'gamma', newText: 'G' },
                ],
            },
            toolContext(),
        )

        expect(textOf(result)).toBe('Successfully replaced 2 block(s) in note.txt.')
        const details = result.details as {
            diff: string
            patch: string
            firstChangedLine?: number
        }
        expect(details.diff).toContain('+1 A beta G')
        expect(details.patch).toContain('--- note.txt')
        expect(details.patch).not.toMatch(/undefined/)
        expect(details.firstChangedLine).toBe(1)

        expect(decode(await bridge.readFile('/repo/note.txt'))).toBe('A beta G\n')
    })

    it('strips exactly one BOM for matching and re-adds it; double BOM is preserved', async () => {
        const bridge = new FakeNativeBridge()
        const tool = createEditTool('/repo', bridge)

        bridge.setFile('/repo/bom.txt', bytesOf('\uFEFFhello world'))
        await tool.execute(
            'e2',
            { path: 'bom.txt', edits: [{ oldText: 'hello', newText: 'hi' }] },
            toolContext(),
        )
        expect(decode(await bridge.readFile('/repo/bom.txt'))).toBe('\uFEFFhi world')

        bridge.setFile('/repo/double-bom.txt', bytesOf('\uFEFF\uFEFFhello'))
        await tool.execute(
            'e3',
            { path: 'double-bom.txt', edits: [{ oldText: '\uFEFFhello', newText: 'X' }] },
            toolContext(),
        )
        expect(decode(await bridge.readFile('/repo/double-bom.txt'))).toBe('\uFEFFX')
    })

    it('detects CRLF, matches on LF-normalized content, and restores CRLF on write', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setFile('/repo/crlf.txt', 'line1\r\nline2\r\n')
        const tool = createEditTool('/repo', bridge)

        await tool.execute(
            'e4',
            { path: 'crlf.txt', edits: [{ oldText: 'line2', newText: 'LINE2' }] },
            toolContext(),
        )
        expect(decode(await bridge.readFile('/repo/crlf.txt'))).toBe('line1\r\nLINE2\r\n')
    })

    it('rejects directory targets via stat', async () => {
        const bridge = new FakeNativeBridge()
        await bridge.mkdirAll('/repo/dir')
        const tool = createEditTool('/repo', bridge)
        await expect(
            tool.execute(
                'e5',
                { path: 'dir', edits: [{ oldText: 'a', newText: 'b' }] },
                toolContext(),
            ),
        ).rejects.toThrow(/director/i)
    })

    it('rejects missing files with a clear error', async () => {
        const bridge = new FakeNativeBridge()
        const tool = createEditTool('/repo', bridge)
        await expect(
            tool.execute(
                'e6',
                { path: 'missing.txt', edits: [{ oldText: 'a', newText: 'b' }] },
                toolContext(),
            ),
        ).rejects.toThrow(/Could not edit file/i)
    })

    it('does not write when aborted before execution', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setFile('/repo/a.txt', 'hello')
        const tool = createEditTool('/repo', bridge)
        const controller = new AbortController()
        controller.abort()
        await expect(
            tool.execute(
                'e7',
                { path: 'a.txt', edits: [{ oldText: 'hello', newText: 'hi' }] },
                toolContext(controller.signal),
            ),
        ).rejects.toThrow(/aborted/i)
        expect(bridge.calls.some((call) => call.method === 'writeFile')).toBe(false)
        expect(decode(await bridge.readFile('/repo/a.txt'))).toBe('hello')
    })

    it('rejects immediately when aborted while queued and never starts that write', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setFile('/repo/same.txt', 'v1')
        const order: string[] = []
        let releaseFirst!: () => void
        const firstHold = new Promise<void>((resolve) => {
            releaseFirst = resolve
        })

        const originalWrite = bridge.writeFile.bind(bridge)
        bridge.writeFile = async (path: string, data: Uint8Array) => {
            const text = decode(data)
            order.push(`enter:${text}`)
            if (text.includes('first')) {
                await firstHold
            }
            await originalWrite(path, data)
            order.push(`done:${text}`)
        }

        const tool = createEditTool('/repo', bridge)
        const first = tool.execute(
            'e8',
            { path: 'same.txt', edits: [{ oldText: 'v1', newText: 'first' }] },
            toolContext(),
        )
        await vi.waitFor(() => {
            expect(order).toContain('enter:first')
        })

        const controller = new AbortController()
        const second = tool.execute(
            'e9',
            { path: 'same.txt', edits: [{ oldText: 'first', newText: 'second' }] },
            toolContext(controller.signal),
        )
        await Promise.resolve()
        await Promise.resolve()
        controller.abort()
        await expect(second).rejects.toThrow(/aborted/i)

        releaseFirst()
        await first
        expect(order.some((entry) => entry.includes('second'))).toBe(false)
        expect(decode(await bridge.readFile('/repo/same.txt'))).toBe('first')
    })

    it('serializes edits through the mutation queue realpath key', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setFile('/repo/target.txt', 'start')
        const order: string[] = []
        let release!: () => void
        const hold = new Promise<void>((resolve) => {
            release = resolve
        })

        const canonical = (path: string) => {
            const normalized = path.replace(/\\/g, '/')
            if (normalized.endsWith('alias.txt') || normalized.endsWith('target.txt')) {
                return '/repo/target.txt'
            }
            return normalized
        }

        bridge.realPath = async (path: string) => canonical(path)
        const originalStat = bridge.stat.bind(bridge)
        const originalRead = bridge.readFile.bind(bridge)
        const originalWrite = bridge.writeFile.bind(bridge)
        bridge.stat = async (path: string) => originalStat(canonical(path))
        bridge.readFile = async (path: string) => originalRead(canonical(path))
        bridge.writeFile = async (path: string, data: Uint8Array) => {
            order.push(`write:${decode(data)}`)
            if (decode(data) === 'one') {
                await hold
            }
            return originalWrite(canonical(path), data)
        }

        const tool = createEditTool('/repo', bridge)
        const first = tool.execute(
            'e11',
            { path: 'alias.txt', edits: [{ oldText: 'start', newText: 'one' }] },
            toolContext(),
        )
        await vi.waitFor(() => {
            expect(order).toEqual(['write:one'])
        })

        const second = tool.execute(
            'e12',
            { path: 'target.txt', edits: [{ oldText: 'one', newText: 'two' }] },
            toolContext(),
        )
        await Promise.resolve()
        await Promise.resolve()
        expect(order).toEqual(['write:one'])

        release()
        await first
        await second
        expect(order).toEqual(['write:one', 'write:two'])
        expect(decode(await bridge.readFile('/repo/target.txt'))).toBe('two')
    })

    it('accepts edits JSON string at execute validation boundary', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setFile('/repo/json.txt', 'old')
        const tool = createEditTool('/repo', bridge)
        const args = validateEditArgs({
            path: 'json.txt',
            edits: JSON.stringify([{ oldText: 'old', newText: 'new' }]),
        })
        const result = await tool.execute('e13', args, toolContext())
        expect(textOf(result)).toBe('Successfully replaced 1 block(s) in json.txt.')
        expect(decode(await bridge.readFile('/repo/json.txt'))).toBe('new')
    })

    it('computes additions/deletions stats and invokes recordChange callback', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setFile('/repo/count-test.txt', 'line 1\nline 2\nline 3\n')
        const tool = createEditTool('/repo', bridge)
        const recorded: Array<{ sessionId: string; change: any }> = []

        const result = await tool.execute(
            'e-stat',
            {
                path: 'count-test.txt',
                edits: [
                    {
                        oldText: 'line 2',
                        newText: 'line 2 modified\nline 2.1 added\nline 2.2 added',
                    },
                ],
            },
            toolContext(undefined, {
                sessionId: 'sess-edit-stat',
                recordChange: (sessionId: string, change: any) => {
                    recorded.push({ sessionId, change })
                },
            }),
        )

        expect((result.details as any).additions).toBe(3)
        expect((result.details as any).deletions).toBe(1)
        expect(recorded.length).toBe(1)
        expect(recorded[0].sessionId).toBe('sess-edit-stat')
        expect(recorded[0].change.additions).toBe(3)
        expect(recorded[0].change.deletions).toBe(1)
    })

    describe('worktree boundaries', () => {
        it('rejects absolute and symlinked edit targets outside the worktree', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setFile('/projects/repo/file.txt', 'old')
            const boundary = await createWorktreeFileBoundary({
                worktreePath: '/worktrees/repo',
            }, bridge)
            const tool = createEditTool('/worktrees/repo', bridge, boundary)

            await expect(tool.execute('edit-source', {
                path: '/projects/repo/file.txt',
                edits: [{ oldText: 'old', newText: 'new' }],
            }, toolContext())).rejects.toThrow(/File modifications must stay within/)
            expect(new TextDecoder().decode(await bridge.readFile('/projects/repo/file.txt'))).toBe('old')
        })
    })
})
