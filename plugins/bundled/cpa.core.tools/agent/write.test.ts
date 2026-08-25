import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeNativeBridge } from './testUtils.js'
import { __resetFileMutationQueuesForTests } from './mutationQueue.js'
import { createWriteTool, validateWriteArgs } from './write.js'
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

function decode(bytes: Uint8Array): string {
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
}

describe('write tool', () => {
    describe('validate', () => {
        it('accepts valid args without mutating the input', () => {
            const input = { path: 'a.txt', content: 'hi' }
            const snapshot = { ...input }
            expect(validateWriteArgs(input)).toEqual(input)
            expect(input).toEqual(snapshot)
        })

        it('rejects invalid path/content', () => {
            expect(() => validateWriteArgs({ path: '', content: 'x' })).toThrow(/path/i)
            expect(() => validateWriteArgs({ path: 'a.txt', content: 1 as unknown as string })).toThrow(
                /content/i,
            )
            expect(() => validateWriteArgs(null)).toThrow(/object/i)
        })

        it('rejects unknown keys', () => {
            expect(() =>
                validateWriteArgs({ path: 'a.txt', content: 'x', mode: 0o644 } as never),
            ).toThrow(/unknown/i)
        })
    })

    describe('execute', () => {
        it('writes UTF-8 bytes, creates parents, and returns the strict success text', async () => {
            const bridge = new FakeNativeBridge()
            const tool = createWriteTool('/repo', bridge)
            const content = 'Hello world'
            const result = await tool.execute(
                'w1',
                { path: 'nested/dir/note.txt', content },
                toolContext(),
            )

            const bytes = new TextEncoder().encode(content)
            expect(textOf(result)).toBe(
                `Successfully wrote ${bytes.byteLength} bytes to /repo/nested/dir/note.txt`,
            )

            const written = await bridge.readFile('/repo/nested/dir/note.txt')
            expect(new TextDecoder().decode(written)).toBe(content)
            expect(bridge.calls.some((call) => call.method === 'mkdirAll')).toBe(true)
        })

        it('overwrites an existing file', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setFile('/repo/a.txt', 'old')
            const tool = createWriteTool('/repo', bridge)
            await tool.execute('w2', { path: 'a.txt', content: 'new' }, toolContext())
            const written = await bridge.readFile('/repo/a.txt')
            expect(new TextDecoder().decode(written)).toBe('new')
        })

        it('serializes writes to the same realpath key', async () => {
            const bridge = new FakeNativeBridge()
            const order: string[] = []
            let release!: () => void
            const hold = new Promise<void>((resolve) => {
                release = resolve
            })

            const originalWrite = bridge.writeFile.bind(bridge)
            bridge.writeFile = async (path: string, data: Uint8Array) => {
                order.push(`write:${new TextDecoder().decode(data)}`)
                if (new TextDecoder().decode(data) === 'first') {
                    await hold
                }
                return originalWrite(path, data)
            }
            bridge.realPath = async (path: string) => {
                if (path.endsWith('alias.txt') || path.endsWith('target.txt')) {
                    return '/repo/target.txt'
                }
                return path.replace(/\\/g, '/')
            }

            const tool = createWriteTool('/repo', bridge)
            const first = tool.execute('w3', { path: 'alias.txt', content: 'first' }, toolContext())

            await vi.waitFor(() => {
                expect(order).toEqual(['write:first'])
            })

            const second = tool.execute('w4', { path: 'target.txt', content: 'second' }, toolContext())
            await Promise.resolve()
            await Promise.resolve()
            expect(order).toEqual(['write:first'])

            release()
            await first
            await second
            expect(order).toEqual(['write:first', 'write:second'])

            const finalBytes = await bridge.readFile('/repo/target.txt')
            expect(new TextDecoder().decode(finalBytes)).toBe('second')
        })

        it('does not write when aborted before execution', async () => {
            const bridge = new FakeNativeBridge()
            const tool = createWriteTool('/repo', bridge)
            const controller = new AbortController()
            controller.abort()
            await expect(
                tool.execute('w5', { path: 'nope.txt', content: 'x' }, toolContext(controller.signal)),
            ).rejects.toThrow(/aborted/i)
            expect(bridge.calls.some((call) => call.method === 'writeFile')).toBe(false)
        })

        it('does not write when aborted while queued and keeps later writes healthy', async () => {
            const bridge = new FakeNativeBridge()

            let releaseFirst!: () => void
            const firstHold = new Promise<void>((resolve) => {
                releaseFirst = resolve
            })
            const order: string[] = []

            const originalWrite = bridge.writeFile.bind(bridge)
            bridge.writeFile = async (path: string, data: Uint8Array) => {
                const text = new TextDecoder().decode(data)
                order.push(`enter:${text}`)
                if (path.endsWith('same.txt') && text === 'first') {
                    await firstHold
                }
                await originalWrite(path, data)
                order.push(`done:${text}`)
            }

            const tool = createWriteTool('/repo', bridge)
            const first = tool.execute(
                'w6',
                { path: 'same.txt', content: 'first' },
                toolContext(),
            )

            await vi.waitFor(() => {
                expect(order).toContain('enter:first')
            })

            const controller = new AbortController()
            const second = tool.execute(
                'w7',
                { path: 'same.txt', content: 'second' },
                toolContext(controller.signal),
            )

            // Abort while the second write is still waiting on the queue.
            await Promise.resolve()
            await Promise.resolve()
            controller.abort()
            await expect(second).rejects.toThrow(/aborted/i)

            releaseFirst()
            await first
            expect(order).toEqual(['enter:first', 'done:first'])

            const written = await bridge.readFile('/repo/same.txt')
            expect(new TextDecoder().decode(written)).toBe('first')

            // Later same-key write must not be poisoned by the aborted queue node.
            await tool.execute('w7b', { path: 'same.txt', content: 'third' }, toolContext())
            const finalBytes = await bridge.readFile('/repo/same.txt')
            expect(new TextDecoder().decode(finalBytes)).toBe('third')
            expect(order).not.toContain('enter:second')
        })

        it('serializes alias and real missing targets through the same parent realpath key', async () => {
            const bridge = new FakeNativeBridge()
            const order: string[] = []
            let release!: () => void
            const hold = new Promise<void>((resolve) => {
                release = resolve
            })

            bridge.realPath = async (path: string) => {
                if (path === '/repo/alias/new.txt' || path === '/repo/alias') {
                    // /repo/alias is a symlink to /repo/real; children are missing pre-create.
                    if (path === '/repo/alias/new.txt') {
                        throw Object.assign(new Error('not found'), { code: 'ENOENT' })
                    }
                    return '/repo/real'
                }
                if (path === '/repo/real/new.txt') {
                    throw Object.assign(new Error('not found'), { code: 'ENOENT' })
                }
                return path.replace(/\\/g, '/')
            }

            const originalWrite = bridge.writeFile.bind(bridge)
            bridge.writeFile = async (path: string, data: Uint8Array) => {
                order.push(`write:${path}:${new TextDecoder().decode(data)}`)
                if (new TextDecoder().decode(data) === 'first') {
                    await hold
                }
                return originalWrite(path, data)
            }

            const tool = createWriteTool('/repo', bridge)
            const first = tool.execute(
                'w-alias',
                { path: 'alias/new.txt', content: 'first' },
                toolContext(),
            )
            await vi.waitFor(() => {
                expect(order.length).toBe(1)
            })

            const second = tool.execute(
                'w-real',
                { path: 'real/new.txt', content: 'second' },
                toolContext(),
            )
            await Promise.resolve()
            await Promise.resolve()
            expect(order).toHaveLength(1)

            release()
            await first
            await second
            expect(order.map((entry) => entry.split(':').pop())).toEqual(['first', 'second'])
        })

        it('counts multi-byte content with TextEncoder byte length', async () => {
            const bridge = new FakeNativeBridge()
            const tool = createWriteTool('/repo', bridge)
            const content = '🚀'
            const result = await tool.execute('w8', { path: 'emoji.txt', content }, toolContext())
            const byteLength = new TextEncoder().encode(content).byteLength
            expect(byteLength).toBeGreaterThan(content.length)
            expect(textOf(result)).toBe(
                `Successfully wrote ${byteLength} bytes to /repo/emoji.txt`,
            )
        })
    })

    describe('schema', () => {
        it('declares additionalProperties false', () => {
            const tool = createWriteTool('/repo', new FakeNativeBridge())
            const schema = tool.parameters as { additionalProperties?: boolean }
            expect(schema.additionalProperties).toBe(false)
        })
    })

    describe('path expansion (~ / @)', () => {
        it('writes via ~ and leading @ without macOS filename fuzzy matching', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setRuntimeInfo({ homeDir: '/home/me', platform: 'darwin' })
            const tool = createWriteTool('/repo', bridge)

            await tool.execute('w-home', { path: '~/out.txt', content: 'home-write' }, toolContext())
            expect(decode(await bridge.readFile('/home/me/out.txt'))).toBe('home-write')

            await tool.execute('w-at', { path: '@src/out.ts', content: 'at-write' }, toolContext())
            expect(decode(await bridge.readFile('/repo/src/out.ts'))).toBe('at-write')

            await tool.execute(
                'w-athome',
                { path: '@~/nested/x.txt', content: 'nested' },
                toolContext(),
            )
            expect(decode(await bridge.readFile('/home/me/nested/x.txt'))).toBe('nested')
        })
    })

    describe('counting and stats', () => {
        it('computes additions/deletions for new and overwritten files', async () => {
            const bridge = new FakeNativeBridge()
            const tool = createWriteTool('/repo', bridge)
            const recorded: Array<{ sessionId: string; change: any }> = []

            // New file
            const newRes = await tool.execute(
                'w-stat-1',
                { path: 'brand-new.txt', content: 'Line 1\nLine 2\nLine 3' },
                toolContext(undefined, {
                    sessionId: 'sess-test-write',
                    recordChange: (sessionId: string, change: any) => {
                        recorded.push({ sessionId, change })
                    },
                }),
            )
            expect((newRes.details as any).additions).toBe(3)
            expect((newRes.details as any).deletions).toBe(0)
            expect(recorded.length).toBe(1)
            expect(recorded[0].change.additions).toBe(3)
            expect(recorded[0].change.deletions).toBe(0)

            // Overwrite file
            const overwriteRes = await tool.execute(
                'w-stat-2',
                { path: 'brand-new.txt', content: 'Line 1\nModified Line 2' },
                toolContext(undefined, {
                    sessionId: 'sess-test-write',
                    recordChange: (sessionId: string, change: any) => {
                        recorded.push({ sessionId, change })
                    },
                }),
            )
            expect((overwriteRes.details as any).additions).toBe(1)
            expect((overwriteRes.details as any).deletions).toBe(2)
            expect(recorded.length).toBe(2)
            expect(recorded[1].change.additions).toBe(1)
            expect(recorded[1].change.deletions).toBe(2)
        })
    })

    describe('worktree boundaries', () => {
        it('rejects worktree-external writes before creating directories or files', async () => {
            const bridge = new FakeNativeBridge()
            const boundary = await createWorktreeFileBoundary({
                worktreePath: '/worktrees/repo',
            }, bridge)
            const tool = createWriteTool('/worktrees/repo', bridge, boundary)

            await expect(tool.execute('write-source', {
                path: '/projects/repo/new.txt',
                content: 'blocked',
            }, toolContext())).rejects.toThrow(/File modifications must stay within/)
            await expect(bridge.stat('/projects/repo/new.txt')).rejects.toThrow()
        })
    })
})
