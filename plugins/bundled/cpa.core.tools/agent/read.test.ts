import { describe, expect, it, vi } from 'vitest'
import type { ModelCatalogEntry } from '@cpa/plugin-api'
import { FakeNativeBridge } from './testUtils.js'
import type { ImageProcessor } from './image.js'
import { createReadTool, decodeUtf8PreserveBom, validateReadArgs } from './read.js'
import { createWorktreeFileBoundary } from './worktreeBoundary.js'
import type { ToolExecutionContext } from './types.js'
import { DEFAULT_MAX_BYTES, utf8ByteLength } from './truncate.js'

const visionModel: ModelCatalogEntry = {
    id: 'vision-model',
    label: 'Vision Model',
    supportsFast: true,
    reasoningLevels: [],
    input: ['text', 'image'],
    contextWindow: 128_000,
    maxTokens: 16_384,
}

const textOnlyModel: ModelCatalogEntry = {
    id: 'text-model',
    label: 'Text Model',
    supportsFast: false,
    reasoningLevels: [],
    input: ['text'],
    contextWindow: 64_000,
    maxTokens: 8_192,
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n')
}

function identityProcessor(): ImageProcessor {
    return {
        async process(bytes, mimeType) {
            const chunkSize = 0x8000
            let binary = ''
            for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
                const slice = bytes.subarray(offset, offset + chunkSize)
                binary += String.fromCharCode(...slice)
            }
            return {
                ok: true,
                data: btoa(binary),
                mimeType,
                hints: [],
                wasResized: false,
            }
        },
    }
}

function toolContext(signal?: AbortSignal): ToolExecutionContext {
    return { signal, cwd: '/repo' }
}

describe('read tool', () => {
    describe('validate', () => {
        it('accepts valid args and does not mutate the input object', () => {
            const input = { path: 'a.txt', offset: 2, limit: 3 }
            const snapshot = { ...input }
            const args = validateReadArgs(input)
            expect(args).toEqual({ path: 'a.txt', offset: 2, limit: 3 })
            expect(input).toEqual(snapshot)
        })

        it('rejects empty path and non-positive offset/limit', () => {
            expect(() => validateReadArgs({ path: '' })).toThrow(/path/i)
            expect(() => validateReadArgs({ path: 'a', offset: 0 })).toThrow(/offset/i)
            expect(() => validateReadArgs({ path: 'a', offset: 1.5 })).toThrow(/offset/i)
            expect(() => validateReadArgs({ path: 'a', limit: 0 })).toThrow(/limit/i)
            expect(() => validateReadArgs({ path: 'a', limit: -2 })).toThrow(/limit/i)
        })

        it('rejects unknown keys', () => {
            expect(() => validateReadArgs({ path: 'a.txt', extra: true })).toThrow(/unknown/i)
        })
    })

    describe('text reads', () => {
        it('reads a small text file fully', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setFile('/repo/notes.txt', 'hello\nworld')
            const tool = createReadTool('/repo', bridge, identityProcessor(), textOnlyModel)
            const result = await tool.execute('call-1', { path: 'notes.txt' }, toolContext())
            expect(textOf(result)).toBe('hello\nworld')
            expect(result.content).toEqual([{ type: 'text', text: 'hello\nworld' }])
        })

        it('preserves trailing newline when reading the full file without offset/limit', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setFile('/repo/trail.txt', 'hello\nworld\n')
            const tool = createReadTool('/repo', bridge, identityProcessor(), textOnlyModel)
            const result = await tool.execute('call-trail', { path: 'trail.txt' }, toolContext())
            expect(textOf(result)).toBe('hello\nworld\n')
        })

        it('treats empty files as zero lines', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setFile('/repo/empty.txt', '')
            const tool = createReadTool('/repo', bridge, identityProcessor(), textOnlyModel)
            const result = await tool.execute('call-empty', { path: 'empty.txt' }, toolContext())
            expect(textOf(result)).toBe('')
            await expect(
                tool.execute('call-empty-oob', { path: 'empty.txt', offset: 1 }, toolContext()),
            ).rejects.toThrow(/beyond end of file/i)
        })

        it('does not invent a phantom line for trailing newline and handles limit/offset', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setFile('/repo/one.txt', 'a\n')
            const tool = createReadTool('/repo', bridge, identityProcessor(), textOnlyModel)

            const limited = await tool.execute(
                'call-one-limit',
                { path: 'one.txt', limit: 1 },
                toolContext(),
            )
            expect(textOf(limited)).toBe('a')
            expect(textOf(limited)).not.toMatch(/more lines/i)

            await expect(
                tool.execute('call-one-oob', { path: 'one.txt', offset: 2 }, toolContext()),
            ).rejects.toThrow(/beyond end of file/i)
        })

        it('applies 1-based offset and limit with a continuation note', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setFile('/repo/lines.txt', 'L1\nL2\nL3\nL4\nL5')
            const tool = createReadTool('/repo', bridge, identityProcessor(), textOnlyModel)
            const result = await tool.execute(
                'call-2',
                { path: 'lines.txt', offset: 2, limit: 2 },
                toolContext(),
            )
            expect(textOf(result)).toContain('L2\nL3')
            expect(textOf(result)).toContain('2 more lines in file. Use offset=4 to continue.')
        })

        it('throws when offset is beyond the end of the file', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setFile('/repo/short.txt', 'only\n')
            const tool = createReadTool('/repo', bridge, identityProcessor(), textOnlyModel)
            await expect(
                tool.execute('call-3', { path: 'short.txt', offset: 10 }, toolContext()),
            ).rejects.toThrow(/beyond end of file/i)
        })

        it('preserves a UTF-8 BOM without stripping or normalizing', async () => {
            const bridge = new FakeNativeBridge()
            const bomText = '\uFEFFhello'
            bridge.setFile('/repo/bom.txt', new TextEncoder().encode(bomText))
            const tool = createReadTool('/repo', bridge, identityProcessor(), textOnlyModel)
            const result = await tool.execute('call-4', { path: 'bom.txt' }, toolContext())
            expect(textOf(result).charCodeAt(0)).toBe(0xfeff)
            expect(textOf(result)).toBe(bomText)
        })

        it('preserves double UTF-8 BOM code points', async () => {
            const bridge = new FakeNativeBridge()
            const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61])
            bridge.setFile('/repo/double-bom.txt', bytes)
            const tool = createReadTool('/repo', bridge, identityProcessor(), textOnlyModel)
            const result = await tool.execute('call-double-bom', { path: 'double-bom.txt' }, toolContext())
            expect(textOf(result).charCodeAt(0)).toBe(0xfeff)
            expect(textOf(result).charCodeAt(1)).toBe(0xfeff)
            expect(textOf(result)).toBe('\uFEFF\uFEFFa')
        })

        it('reports first-line over 50KiB with an actionable message', async () => {
            const bridge = new FakeNativeBridge()
            // One long line over 50KiB
            const longLine = 'x'.repeat(DEFAULT_MAX_BYTES + 10)
            bridge.setFile('/repo/huge.txt', `${longLine}\nsecond`)
            const tool = createReadTool('/repo', bridge, identityProcessor(), textOnlyModel)
            const result = await tool.execute('call-5', { path: 'huge.txt' }, toolContext())
            const text = textOf(result)
            expect(text).toMatch(/Line 1 is/)
            expect(text).toMatch(/exceeds/)
            expect(text).toMatch(/sed -n '1p'/)
        })

        it('emits a continuation note with accurate line numbers after line truncation', async () => {
            const bridge = new FakeNativeBridge()
            const lines = Array.from({ length: 5 }, (_, i) => `line-${i + 1}`)
            bridge.setFile('/repo/many.txt', lines.join('\n'))
            const tool = createReadTool('/repo', bridge, identityProcessor(), textOnlyModel)
            const result = await tool.execute(
                'call-6',
                { path: 'many.txt', offset: 1, limit: 2 },
                toolContext(),
            )
            expect(textOf(result)).toContain('line-1\nline-2')
            expect(textOf(result)).toContain('Use offset=3 to continue.')
        })
    })

    describe('image reads', () => {
        it('returns text + image for vision models', async () => {
            const bridge = new FakeNativeBridge()
            const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
            bridge.setFile('/repo/pic.png', png)
            const tool = createReadTool('/repo', bridge, identityProcessor(), visionModel)
            const result = await tool.execute('call-img-1', { path: 'pic.png' }, toolContext())
            expect(result.content[0]).toMatchObject({ type: 'text' })
            expect(result.content[1]).toMatchObject({
                type: 'image',
                mimeType: 'image/png',
            })
            expect(JSON.stringify(result)).toContain('image/png')
        })

        it('returns only text for non-vision models and does not leak image blocks', async () => {
            const bridge = new FakeNativeBridge()
            const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
            bridge.setFile('/repo/pic.png', png)
            const tool = createReadTool('/repo', bridge, identityProcessor(), textOnlyModel)
            const result = await tool.execute('call-img-2', { path: 'pic.png' }, toolContext())
            expect(result.content.every((block) => block.type === 'text')).toBe(true)
            expect(textOf(result)).toMatch(/does not support images/i)
            expect(JSON.stringify(result)).not.toContain('"type":"image"')
        })
    })

    describe('abort', () => {
        it('rejects when already aborted before work starts', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setFile('/repo/a.txt', 'data')
            const tool = createReadTool('/repo', bridge, identityProcessor(), textOnlyModel)
            const controller = new AbortController()
            controller.abort()
            await expect(
                tool.execute('call-abort', { path: 'a.txt' }, toolContext(controller.signal)),
            ).rejects.toThrow(/aborted/i)
        })

        it('removes the abort listener after completion', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setFile('/repo/a.txt', 'data')
            const tool = createReadTool('/repo', bridge, identityProcessor(), textOnlyModel)
            const controller = new AbortController()
            const addSpy = vi.spyOn(controller.signal, 'addEventListener')
            const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')
            await tool.execute('call-clean', { path: 'a.txt' }, toolContext(controller.signal))
            expect(addSpy).toHaveBeenCalled()
            expect(removeSpy).toHaveBeenCalled()
        })

        it('rejects immediately while image processing is pending and never returns success', async () => {
            const bridge = new FakeNativeBridge()
            const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
            bridge.setFile('/repo/slow.png', png)

            let release!: () => void
            const hold = new Promise<void>((resolve) => {
                release = resolve
            })
            let processStarted = false
            let processFinished = false
            const slowProcessor: ImageProcessor = {
                async process(bytes, mimeType) {
                    processStarted = true
                    await hold
                    processFinished = true
                    return {
                        ok: true,
                        data: btoa(String.fromCharCode(...bytes)),
                        mimeType,
                        hints: [],
                        wasResized: false,
                    }
                },
            }

            const tool = createReadTool('/repo', bridge, slowProcessor, visionModel)
            const controller = new AbortController()
            const pending = tool.execute(
                'call-abort-img',
                { path: 'slow.png' },
                toolContext(controller.signal),
            )

            await vi.waitFor(() => {
                expect(processStarted).toBe(true)
            })
            controller.abort()

            await expect(pending).rejects.toThrow(/aborted/i)
            expect(processFinished).toBe(false)

            release()
            await vi.waitFor(() => {
                expect(processFinished).toBe(true)
            })
        })
    })

    describe('decodeUtf8PreserveBom', () => {
        it('keeps BOM like Buffer.toString("utf-8")', () => {
            const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61])
            const decoded = decodeUtf8PreserveBom(bytes)
            expect(decoded.charCodeAt(0)).toBe(0xfeff)
            expect(decoded).toBe('\uFEFFa')
            expect(utf8ByteLength(decoded.slice(1))).toBe(1)
        })

        it('keeps every BOM code point including doubles', () => {
            const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x62])
            const decoded = decodeUtf8PreserveBom(bytes)
            expect(decoded).toBe('\uFEFF\uFEFFb')
        })
    })

    describe('schema', () => {
        it('declares integer offset/limit with minimum 1 and additionalProperties false', () => {
            const tool = createReadTool('/repo', new FakeNativeBridge(), identityProcessor(), textOnlyModel)
            const schema = tool.parameters as {
                additionalProperties?: boolean
                properties: Record<string, { type?: string; minimum?: number }>
            }
            expect(schema.additionalProperties).toBe(false)
            expect(schema.properties.offset?.type).toBe('integer')
            expect(schema.properties.offset?.minimum).toBe(1)
            expect(schema.properties.limit?.type).toBe('integer')
            expect(schema.properties.limit?.minimum).toBe(1)
        })
    })

    describe('path expansion (~ / @ / macOS variants)', () => {
        it('reads via leading @ and home ~ expansion', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setRuntimeInfo({ homeDir: '/home/me', platform: 'linux' })
            bridge.setFile('/home/me/secret.txt', 'from-home')
            bridge.setFile('/repo/src/a.ts', 'from-at')
            const tool = createReadTool('/repo', bridge, identityProcessor(), textOnlyModel)

            const home = await tool.execute('r-home', { path: '~/secret.txt' }, toolContext())
            expect(textOf(home)).toBe('from-home')

            const at = await tool.execute('r-at', { path: '@src/a.ts' }, toolContext())
            expect(textOf(at)).toBe('from-at')

            const atHome = await tool.execute('r-athome', { path: '@~/secret.txt' }, toolContext())
            expect(textOf(atHome)).toBe('from-home')
        })

        it('resolves darwin AM/PM narrow-NBSP screenshot names', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setRuntimeInfo({ platform: 'darwin', homeDir: '/home/me' })
            const real = `/repo/Screenshot 1 PM.png`
            const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
            bridge.setFile(real, png)
            const tool = createReadTool('/repo', bridge, identityProcessor(), visionModel)
            const result = await tool.execute(
                'r-shot',
                { path: 'Screenshot 1 PM.png' },
                toolContext(),
            )
            expect(result.content.some((b) => b.type === 'image')).toBe(true)
        })

        it('preserves BOM after path expansion', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setRuntimeInfo({ platform: 'linux', homeDir: '/home/me' })
            const bomText = '\uFEFFhello'
            bridge.setFile('/home/me/bom.txt', bomText)
            const tool = createReadTool('/repo', bridge, identityProcessor(), textOnlyModel)
            const result = await tool.execute('r-bom', { path: '~/bom.txt' }, toolContext())
            expect(textOf(result)).toBe(bomText)
        })
    })

    describe('worktree boundaries', () => {
        it('restricts relative reads to worktree while allowing absolute source reads', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setFile('/worktrees/repo/src/in-worktree.ts', 'worktree')
            bridge.setFile('/projects/repo/src/original.ts', 'original')
            const boundary = await createWorktreeFileBoundary({
                worktreePath: '/worktrees/repo',
            }, bridge)
            const tool = createReadTool(
                '/worktrees/repo',
                bridge,
                identityProcessor(),
                textOnlyModel,
                boundary,
            )

            await expect(tool.execute('inside', {
                path: 'src/in-worktree.ts',
            }, toolContext())).resolves.toMatchObject({
                content: [{ type: 'text', text: 'worktree' }],
            })
            await expect(tool.execute('escape', {
                path: '../../projects/repo/src/original.ts',
            }, toolContext())).rejects.toThrow(/Relative read paths must stay within/)
            await expect(tool.execute('absolute', {
                path: '/projects/repo/src/original.ts',
            }, toolContext())).resolves.toMatchObject({
                content: [{ type: 'text', text: 'original' }],
            })
        })

        it('rejects a relative read whose realPath escapes through a symlink', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setFile('/worktrees/repo/link/file.ts', 'must not be read')
            vi.spyOn(bridge, 'realPath').mockImplementation(async (path) => {
                if (path === '/worktrees/repo') return '/real/worktrees/repo'
                if (path === '/worktrees/repo/link/file.ts') {
                    return '/projects/repo/file.ts'
                }
                return path.replace('/worktrees/repo', '/real/worktrees/repo')
            })
            const readFile = vi.spyOn(bridge, 'readFile')
            const boundary = await createWorktreeFileBoundary({
                worktreePath: '/worktrees/repo',
            }, bridge)
            const tool = createReadTool(
                '/worktrees/repo',
                bridge,
                identityProcessor(),
                textOnlyModel,
                boundary,
            )

            await expect(tool.execute('symlink-read', {
                path: 'link/file.ts',
            }, toolContext())).rejects.toThrow(/Relative read paths must stay within/)
            expect(readFile).not.toHaveBeenCalled()
        })
    })
})
