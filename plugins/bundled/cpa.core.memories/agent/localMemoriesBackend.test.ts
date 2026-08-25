import { beforeEach, describe, expect, it } from 'vitest'
import {
    LocalMemoriesBackend,
    type ElectronBridgeLike,
    addAdHocNote,
    deleteLocalMemory,
    joinPath,
    listMemories,
    normalizeSeparators,
    readMemory,
    searchMemories,
    splitLines,
    stringToBase64,
    validateAdHocFilename,
} from './localMemoriesBackend'

class MockElectronBridge implements ElectronBridgeLike {
    files = new Map<string, string>()
    dirs = new Set<string>()
    symlinks = new Set<string>()
    symlinkTargets = new Map<string, string>()

    constructor(public rootDir: string = '/test-memories') {
        this.dirs.add(rootDir)
    }

    async RuntimeInfo() {
        return {
            homeDir: '/mock/home',
            platform: 'darwin',
            tempDir: '/tmp',
            userConfigDir: '/mock/home/.config',
        }
    }

    async ReadFile(filePath: string) {
        const norm = normalizeSeparators(filePath)
        if (!this.files.has(norm)) {
            throw new Error(`ENOENT: no such file or directory, open '${filePath}'`)
        }
        return { dataBase64: this.files.get(norm)! }
    }

    async WriteFile(filePath: string, dataBase64: string) {
        const norm = normalizeSeparators(filePath)
        this.files.set(norm, dataBase64)
        const parts = norm.split('/')
        for (let i = 1; i < parts.length; i++) {
            const dir = parts.slice(0, i).join('/')
            if (dir) this.dirs.add(dir)
        }
    }

    async MkdirAll(dirPath: string) {
        const norm = normalizeSeparators(dirPath)
        const parts = norm.split('/')
        for (let i = 1; i <= parts.length; i++) {
            const dir = parts.slice(0, i).join('/')
            if (dir) this.dirs.add(dir)
        }
    }

    async RemoveFile(filePath: string) {
        const norm = normalizeSeparators(filePath)
        if (!this.files.has(norm) && !this.symlinks.has(norm)) {
            throw new Error(`ENOENT: no such file or directory, unlink '${filePath}'`)
        }
        this.files.delete(norm)
        this.symlinks.delete(norm)
        this.symlinkTargets.delete(norm)
    }

    async Stat(targetPath: string) {
        const norm = normalizeSeparators(targetPath)
        const isSymlink = this.symlinks.has(norm)
        const isDir = this.dirs.has(norm)
        const isFile = this.files.has(norm)

        if (!isDir && !isFile && !isSymlink) {
            throw new Error(`ENOENT: no such file or directory, stat '${targetPath}'`)
        }

        const name = norm.split('/').pop() || ''
        const size = isFile ? (this.files.get(norm)?.length ?? 0) : 0
        return {
            name,
            size,
            mode: isSymlink ? 0o120777 : isDir ? 0o040755 : 0o100644,
            isDir,
            isSymbolicLink: isSymlink,
        }
    }

    async ReadDir(dirPath: string) {
        const norm = normalizeSeparators(dirPath).replace(/\/+$/, '')
        if (!this.dirs.has(norm)) {
            throw new Error(`ENOENT: no such file or directory, scandir '${dirPath}'`)
        }
        const entriesMap = new Map<string, { name: string; isDir: boolean; isSymbolicLink?: boolean }>()
        for (const dir of this.dirs) {
            if (dir !== norm && dir.startsWith(norm + '/')) {
                const relative = dir.slice(norm.length + 1)
                const firstComp = relative.split('/')[0]
                if (firstComp && !entriesMap.has(firstComp)) {
                    entriesMap.set(firstComp, { name: firstComp, isDir: true })
                }
            }
        }
        for (const file of this.files.keys()) {
            if (file.startsWith(norm + '/')) {
                const relative = file.slice(norm.length + 1)
                const parts = relative.split('/')
                if (parts.length === 1) {
                    const name = parts[0]
                    entriesMap.set(name, { name, isDir: false })
                } else if (parts[0] && !entriesMap.has(parts[0])) {
                    entriesMap.set(parts[0], { name: parts[0], isDir: true })
                }
            }
        }
        for (const sym of this.symlinks) {
            if (sym.startsWith(norm + '/')) {
                const relative = sym.slice(norm.length + 1)
                const parts = relative.split('/')
                if (parts.length === 1) {
                    const name = parts[0]
                    entriesMap.set(name, { name, isDir: false, isSymbolicLink: true })
                }
            }
        }
        return Array.from(entriesMap.values())
    }

    async RealPath(targetPath: string) {
        const norm = normalizeSeparators(targetPath)
        if (this.symlinkTargets.has(norm)) {
            return this.symlinkTargets.get(norm)!
        }
        return norm
    }

    addFile(relativePath: string, content: string) {
        const fullPath = joinPath(this.rootDir, relativePath)
        this.WriteFile(fullPath, stringToBase64(content))
    }

    addSymlink(relativePath: string, targetFullPath?: string) {
        const fullPath = joinPath(this.rootDir, relativePath)
        const norm = normalizeSeparators(fullPath)
        this.symlinks.add(norm)
        if (targetFullPath) {
            this.symlinkTargets.set(norm, normalizeSeparators(targetFullPath))
        }
    }

    addDirectory(relativePath: string) {
        const fullPath = joinPath(this.rootDir, relativePath)
        this.MkdirAll(fullPath)
    }
}

describe('LocalMemoriesBackend', () => {
    let mockBridge: MockElectronBridge
    const memoryRoot = '/test-memories'

    beforeEach(() => {
        mockBridge = new MockElectronBridge(memoryRoot)
    })

    describe('splitLines helper matching Rust lines() semantics', () => {
        it('handles empty string as 0 lines', () => {
            expect(splitLines('')).toEqual([])
        })

        it('handles single line without trailing newline', () => {
            expect(splitLines('hello world')).toEqual(['hello world'])
        })

        it('handles single line with trailing LF', () => {
            expect(splitLines('hello world\n')).toEqual(['hello world'])
        })

        it('handles single line with trailing CRLF', () => {
            expect(splitLines('hello world\r\n')).toEqual(['hello world'])
        })

        it('handles multiline with trailing LF without extra empty line', () => {
            expect(splitLines('line1\nline2\n')).toEqual(['line1', 'line2'])
        })

        it('handles multiline with trailing CRLF without extra empty line', () => {
            expect(splitLines('line1\r\nline2\r\n')).toEqual(['line1', 'line2'])
        })

        it('preserves empty lines inside content', () => {
            expect(splitLines('line1\n\nline2\n')).toEqual(['line1', '', 'line2'])
        })

        it('handles solitary newline characters', () => {
            expect(splitLines('\n')).toEqual([''])
            expect(splitLines('\r\n')).toEqual([''])
            expect(splitLines('\n\n')).toEqual(['', ''])
        })
    })

    describe('Path Safety & Scoped Path Resolution', () => {
        it('rejects parent directory traversal', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            await expect(backend.readMemory({ path: '../secret.txt' })).rejects.toThrow(
                /must stay within the memories root/,
            )
            await expect(backend.readMemory({ path: 'nested/../../outside.txt' })).rejects.toThrow(
                /must stay within the memories root/,
            )
        })

        it('rejects root or drive letter traversal', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            await expect(backend.readMemory({ path: '/etc/passwd' })).rejects.toThrow(
                /must stay within the memories root/,
            )
            await expect(backend.readMemory({ path: 'C:/Windows/System32' })).rejects.toThrow(
                /must stay within the memories root/,
            )
        })

        it('rejects hidden files or directories as not found', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addFile('.secret.md', 'secret content')
            mockBridge.addFile('.hidden/file.md', 'hidden content')

            await expect(backend.readMemory({ path: '.secret.md' })).rejects.toThrow(
                /was not found/,
            )
            await expect(backend.readMemory({ path: '.hidden/file.md' })).rejects.toThrow(
                /was not found/,
            )
        })

        it('rejects symlinks inside memory root', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addSymlink('symlinked.md')

            await expect(backend.readMemory({ path: 'symlinked.md' })).rejects.toThrow(
                /must not be a symlink/,
            )
        })

        it('rejects symlinks escaping memory root via RealPath containment check', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addSymlink('escaped_link.md', '/etc/passwd')

            await expect(backend.readMemory({ path: 'escaped_link.md' })).rejects.toThrow(
                /must stay within the memories root/,
            )
        })

        it('rejects traversing through non-directory path components', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addFile('plain-file.md', 'hello')

            await expect(backend.readMemory({ path: 'plain-file.md/sub-file.md' })).rejects.toThrow(
                /traverses through a non-directory path component/,
            )
        })
    })

    describe('listMemories', () => {
        it('lists sorted files and directories relative to memory root', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addFile('MEMORY.md', '# Memory Index')
            mockBridge.addFile('memory_summary.md', 'Summary')
            mockBridge.addDirectory('extensions/ad_hoc/notes')
            mockBridge.addFile('extensions/ad_hoc/notes/note1.md', 'Note 1')
            mockBridge.addFile('.hidden.md', 'Hidden')
            mockBridge.addSymlink('link.md')

            const response = await backend.listMemories({})
            expect(response.truncated).toBe(false)
            expect(response.nextCursor).toBeUndefined()
            expect(response.entries).toEqual([
                { path: 'MEMORY.md', entryType: 'file' },
                { path: 'extensions', entryType: 'directory' },
                { path: 'memory_summary.md', entryType: 'file' },
            ])
        })

        it('lists direct entries within a subpath', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addDirectory('nested')
            mockBridge.addFile('nested/b.md', 'b')
            mockBridge.addFile('nested/a.md', 'a')
            mockBridge.addDirectory('nested/sub')

            const response = await backend.listMemories({ path: 'nested' })
            expect(response.entries).toEqual([
                { path: 'nested/a.md', entryType: 'file' },
                { path: 'nested/b.md', entryType: 'file' },
                { path: 'nested/sub', entryType: 'directory' },
            ])
        })

        it('listing a single file returns single file entry', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addFile('single.md', 'single file')

            const response = await backend.listMemories({ path: 'single.md' })
            expect(response.entries).toEqual([
                { path: 'single.md', entryType: 'file' },
            ])
        })

        it('supports pagination with cursor and maxResults', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addFile('file1.md', '1')
            mockBridge.addFile('file2.md', '2')
            mockBridge.addFile('file3.md', '3')
            mockBridge.addFile('file4.md', '4')

            const page1 = await backend.listMemories({ maxResults: 2 })
            expect(page1.entries).toEqual([
                { path: 'file1.md', entryType: 'file' },
                { path: 'file2.md', entryType: 'file' },
            ])
            expect(page1.truncated).toBe(true)
            expect(page1.nextCursor).toBe('2')

            const page2 = await backend.listMemories({ cursor: page1.nextCursor, maxResults: 2 })
            expect(page2.entries).toEqual([
                { path: 'file3.md', entryType: 'file' },
                { path: 'file4.md', entryType: 'file' },
            ])
            expect(page2.truncated).toBe(false)
            expect(page2.nextCursor).toBeUndefined()
        })

        it('rejects invalid cursors', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addFile('file1.md', '1')

            await expect(backend.listMemories({ cursor: 'invalid' })).rejects.toThrow(
                /cursor 'invalid' must be a non-negative integer/,
            )
            await expect(backend.listMemories({ cursor: '-1' })).rejects.toThrow(
                /cursor '-1' must be a non-negative integer/,
            )
            await expect(backend.listMemories({ cursor: '10' })).rejects.toThrow(
                /cursor '10' exceeds result count/,
            )
        })

        it('throws not found when directory does not exist', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            await expect(backend.listMemories({ path: 'nonexistent' })).rejects.toThrow(
                /path 'nonexistent' was not found/,
            )
        })
    })

    describe('readMemory', () => {
        it('reads whole file content when no line limits are specified', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addFile('MEMORY.md', 'line 1\nline 2\nline 3\n')

            const response = await backend.readMemory({ path: 'MEMORY.md' })
            expect(response).toEqual({
                path: 'MEMORY.md',
                startLineNumber: 1,
                content: 'line 1\nline 2\nline 3\n',
                truncated: false,
            })
        })

        it('reads from line offset with max lines limit', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addFile('MEMORY.md', 'first line\nsecond needle line\nthird line\n')

            const response = await backend.readMemory({
                path: 'MEMORY.md',
                lineOffset: 2,
                maxLines: 1,
            })
            expect(response).toEqual({
                path: 'MEMORY.md',
                startLineNumber: 2,
                content: 'second needle line\n',
                truncated: true,
            })
        })

        it('rejects invalid line offset (<= 0)', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addFile('MEMORY.md', 'content')

            await expect(backend.readMemory({ path: 'MEMORY.md', lineOffset: 0 })).rejects.toThrow(
                /line_offset must be a 1-indexed line number/,
            )
            await expect(backend.readMemory({ path: 'MEMORY.md', lineOffset: -5 })).rejects.toThrow(
                /line_offset must be a 1-indexed line number/,
            )
        })

        it('rejects invalid max lines (<= 0)', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addFile('MEMORY.md', 'content')

            await expect(backend.readMemory({ path: 'MEMORY.md', maxLines: 0 })).rejects.toThrow(
                /max_lines must be a positive integer/,
            )
        })

        it('rejects line offset exceeding file length', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addFile('MEMORY.md', 'line 1\nline 2\n')

            await expect(backend.readMemory({ path: 'MEMORY.md', lineOffset: 5 })).rejects.toThrow(
                /line_offset exceeds file length/,
            )
        })

        it('rejects reading a directory', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addDirectory('nested_dir')

            await expect(backend.readMemory({ path: 'nested_dir' })).rejects.toThrow(
                /path 'nested_dir' is not a file/,
            )
        })

        it('truncates content when exceeding maxTokens budget', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            const longText = 'A'.repeat(400) // approx 100 tokens
            mockBridge.addFile('long.md', longText)

            const response = await backend.readMemory({
                path: 'long.md',
                maxTokens: 10, // 40 bytes budget
            })
            expect(response.truncated).toBe(true)
            expect(response.content).toContain('tokens truncated')
            expect(response.content.startsWith('A'.repeat(20))).toBe(true)
            expect(response.content.endsWith('A'.repeat(20))).toBe(true)
        })
    })

    describe('searchMemories', () => {
        beforeEach(() => {
            mockBridge.addFile('file1.md', 'alpha only\nneedle only\nalpha needle\n')
            mockBridge.addFile('nested/file2.md', 'beta needle\nsomething else\n')
        })

        it('searches with matchMode "any"', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            const response = await backend.searchMemories({
                queries: ['alpha', 'needle'],
                matchMode: 'any',
            })

            expect(response.queries).toEqual(['alpha', 'needle'])
            expect(response.matchMode).toBe('any')
            expect(response.matches).toEqual([
                {
                    path: 'file1.md',
                    matchLineNumber: 1,
                    contentStartLineNumber: 1,
                    content: 'alpha only',
                    matchedQueries: ['alpha'],
                },
                {
                    path: 'file1.md',
                    matchLineNumber: 2,
                    contentStartLineNumber: 2,
                    content: 'needle only',
                    matchedQueries: ['needle'],
                },
                {
                    path: 'file1.md',
                    matchLineNumber: 3,
                    contentStartLineNumber: 3,
                    content: 'alpha needle',
                    matchedQueries: ['alpha', 'needle'],
                },
                {
                    path: 'nested/file2.md',
                    matchLineNumber: 1,
                    contentStartLineNumber: 1,
                    content: 'beta needle',
                    matchedQueries: ['needle'],
                },
            ])
        })

        it('searches with matchMode "all_on_same_line"', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            const response = await backend.searchMemories({
                queries: ['alpha', 'needle'],
                matchMode: 'all_on_same_line',
            })

            expect(response.matches).toEqual([
                {
                    path: 'file1.md',
                    matchLineNumber: 3,
                    contentStartLineNumber: 3,
                    content: 'alpha needle',
                    matchedQueries: ['alpha', 'needle'],
                },
            ])
        })

        it('searches with matchMode "all_within_lines"', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addFile('window.md', 'first line: alpha\nsecond line: middle\nthird line: needle\nfourth line: end\n')

            const response = await backend.searchMemories({
                queries: ['alpha', 'needle'],
                matchMode: 'all_within_lines',
                lineCount: 3,
                path: 'window.md',
            })

            expect(response.matches).toEqual([
                {
                    path: 'window.md',
                    matchLineNumber: 1,
                    contentStartLineNumber: 1,
                    content: 'first line: alpha\nsecond line: middle\nthird line: needle',
                    matchedQueries: ['alpha', 'needle'],
                },
            ])
        })

        it('supports contextLines surrounding match', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addFile('ctx.md', 'line 1: preamble\nline 2: target needle\nline 3: postamble\n')

            const response = await backend.searchMemories({
                queries: ['needle'],
                contextLines: 1,
                path: 'ctx.md',
            })

            expect(response.matches).toEqual([
                {
                    path: 'ctx.md',
                    matchLineNumber: 2,
                    contentStartLineNumber: 1,
                    content: 'line 1: preamble\nline 2: target needle\nline 3: postamble',
                    matchedQueries: ['needle'],
                },
            ])
        })

        it('handles caseSensitive matching', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addFile('case.md', 'Alpha Needle\nalpha needle\n')

            const sensitive = await backend.searchMemories({
                queries: ['Alpha'],
                caseSensitive: true,
                path: 'case.md',
            })
            expect(sensitive.matches.length).toBe(1)
            expect(sensitive.matches[0].matchLineNumber).toBe(1)

            const insensitive = await backend.searchMemories({
                queries: ['Alpha'],
                caseSensitive: false,
                path: 'case.md',
            })
            expect(insensitive.matches.length).toBe(2)
        })

        it('handles normalized matching stripping non-alphanumerics', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addFile('norm.md', 'hello, world! (123)\n')

            const response = await backend.searchMemories({
                queries: ['hello world 123'],
                normalized: true,
                path: 'norm.md',
            })
            expect(response.matches.length).toBe(1)
            expect(response.matches[0].content).toBe('hello, world! (123)')
        })

        it('paginates search results with cursor and maxResults', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            const page1 = await backend.searchMemories({
                queries: ['needle'],
                maxResults: 1,
            })
            expect(page1.matches.length).toBe(1)
            expect(page1.truncated).toBe(true)
            expect(page1.nextCursor).toBe('1')

            const page2 = await backend.searchMemories({
                queries: ['needle'],
                cursor: page1.nextCursor,
                maxResults: 1,
            })
            expect(page2.matches.length).toBe(1)
            expect(page2.nextCursor).toBe('2')
        })

        it('rejects empty or whitespace queries', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            await expect(backend.searchMemories({ queries: [] })).rejects.toThrow(
                /queries must not be empty/,
            )
            await expect(backend.searchMemories({ queries: ['   '] })).rejects.toThrow(
                /queries must not be empty/,
            )
        })

        it('rejects invalid lineCount for all_within_lines', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            await expect(
                backend.searchMemories({
                    queries: ['alpha'],
                    matchMode: 'all_within_lines',
                    lineCount: 0,
                }),
            ).rejects.toThrow(/all_within_lines.line_count must be a positive integer/)
        })
    })

    describe('validateAdHocFilename', () => {
        it('accepts valid timestamp and slug combinations', () => {
            expect(() =>
                validateAdHocFilename('2026-05-26T13-42-08-remember-review-style.md'),
            ).not.toThrow()
            expect(() =>
                validateAdHocFilename('2024-01-01T00-00-00-a.md'),
            ).not.toThrow()
            expect(() =>
                validateAdHocFilename('2030-12-31T23-59-59-custom-key-123.md'),
            ).not.toThrow()
        })

        it('rejects path traversal attempts in filename', () => {
            expect(() =>
                validateAdHocFilename('../2026-05-26T13-42-08-remember.md'),
            ).toThrow(/must use YYYY-MM-DDTHH-MM-SS-<slug>.md/)
        })

        it('rejects missing .md extension', () => {
            expect(() =>
                validateAdHocFilename('2026-05-26T13-42-08-remember.txt'),
            ).toThrow(/must end with .md/)
        })

        it('rejects invalid timestamp format', () => {
            expect(() =>
                validateAdHocFilename('2026-5-26T13-42-08-remember.md'),
            ).toThrow(/must use YYYY-MM-DDTHH-MM-SS-<slug>.md/)
            expect(() =>
                validateAdHocFilename('2026-05-26-13-42-08-remember.md'),
            ).toThrow(/must use YYYY-MM-DDTHH-MM-SS-<slug>.md/)
        })

        it('rejects empty slug or slug exceeding 80 bytes', () => {
            expect(() =>
                validateAdHocFilename('2026-05-26T13-42-08-.md'),
            ).toThrow(/must use YYYY-MM-DDTHH-MM-SS-<slug>.md/)
            expect(() =>
                validateAdHocFilename(`2026-05-26T13-42-08-${'a'.repeat(81)}.md`),
            ).toThrow(/slug must be 1 to 80 bytes/)
        })

        it('rejects uppercase letters, underscores, and special characters in slug', () => {
            expect(() =>
                validateAdHocFilename('2026-05-26T13-42-08-RememberReview.md'),
            ).toThrow(/slug must contain only lowercase ASCII letters, digits, or hyphens/)
            expect(() =>
                validateAdHocFilename('2026-05-26T13-42-08-note_with_underscore.md'),
            ).toThrow(/slug must contain only lowercase ASCII letters, digits, or hyphens/)
            expect(() =>
                validateAdHocFilename('2026-05-26T13-42-08-note with spaces.md'),
            ).toThrow(/slug must contain only lowercase ASCII letters, digits, or hyphens/)
        })

        it('rejects total filename exceeding 128 bytes', () => {
            const filename = `2026-05-26T13-42-08-${'a'.repeat(110)}.md`
            expect(() => validateAdHocFilename(filename)).toThrow(
                /must be at most 128 bytes/,
            )
        })
    })

    describe('addAdHocNote', () => {
        it('writes ad-hoc note under extensions/ad_hoc/notes and returns relative path', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            const filename = '2026-05-26T13-42-08-remember-review-style.md'
            const noteContent = 'Remember to keep PR review comments concise.'

            const response = await backend.addAdHocNote({
                filename,
                note: noteContent,
            })

            expect(response).toEqual({
                success: true,
                path: `extensions/ad_hoc/notes/${filename}`,
            })

            const readBack = await backend.readMemory({
                path: `extensions/ad_hoc/notes/${filename}`,
            })
            expect(readBack.content).toBe(noteContent)
        })

        it('rejects empty or whitespace-only note', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            await expect(
                backend.addAdHocNote({
                    filename: '2026-05-26T13-42-08-empty-note.md',
                    note: '   \n  \t ',
                }),
            ).rejects.toThrow(/ad-hoc note must not be empty/)
        })

        it('rejects writing when note file already exists', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            const filename = '2026-05-26T13-42-08-duplicate.md'
            mockBridge.addFile(`extensions/ad_hoc/notes/${filename}`, 'existing')

            await expect(
                backend.addAdHocNote({
                    filename,
                    note: 'new content',
                }),
            ).rejects.toThrow(/already exists/)
        })
    })

    describe('deleteLocalMemory', () => {
        it('recursively removes all files in memory root using RemoveFile', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addFile('MEMORY.md', 'Index')
            mockBridge.addFile('memory_summary.md', 'Summary')
            mockBridge.addFile('extensions/ad_hoc/notes/note1.md', 'Note 1')

            await backend.deleteLocalMemory()

            expect(mockBridge.files.size).toBe(0)
            await expect(backend.readMemory({ path: 'MEMORY.md' })).rejects.toThrow(/was not found/)
            await expect(
                backend.readMemory({ path: 'extensions/ad_hoc/notes/note1.md' }),
            ).rejects.toThrow(/was not found/)
        })

        it('does not follow or remove symlinks escaping root during deletion', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addFile('MEMORY.md', 'Index')
            mockBridge.addSymlink('outside_symlink', '/outside/secret.txt')

            await backend.deleteLocalMemory()

            expect(mockBridge.files.has('/test-memories/MEMORY.md')).toBe(false)
        })

        it('creates memory root if it did not exist initially', async () => {
            const freshBridge = new MockElectronBridge('/fresh-root')
            freshBridge.dirs.clear()
            const backend = LocalMemoriesBackend.fromMemoryRoot('/fresh-root', freshBridge)

            await backend.deleteLocalMemory()
            expect(freshBridge.dirs.has('/fresh-root')).toBe(true)
        })
    })

    describe('Global bridge and root resolution fallback', () => {
        it('throws when bridge is unavailable', async () => {
            const backend = new LocalMemoriesBackend({ memoryRoot: '/some/root' })
            await expect(backend.listMemories({})).rejects.toThrow(/bridge is unavailable/)
        })

        it('reads empty file at line 1 without truncation', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            mockBridge.addFile('empty.md', '')

            const res = await backend.readMemory({ path: 'empty.md', lineOffset: 1 })
            expect(res).toEqual({
                path: 'empty.md',
                startLineNumber: 1,
                content: '',
                truncated: false,
            })
        })

        it('eliminates redundant containing windows in all_within_lines', async () => {
            const backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
            // Window 1: line 1 to 4 contains alpha, beta
            // Window 2: line 2 to 3 contains alpha, beta (strictly smaller)
            mockBridge.addFile(
                'windows.md',
                'line 1: alpha\nline 2: alpha\nline 3: beta\nline 4: beta\n',
            )

            const res = await backend.searchMemories({
                queries: ['alpha', 'beta'],
                matchMode: 'all_within_lines',
                lineCount: 4,
                path: 'windows.md',
            })

            // Window starting at line 1 ends at line 3 (lines 1..3)
            // Window starting at line 2 ends at line 3 (lines 2..3)
            // Window 1..3 strictly contains 2..3, so 1..3 is dropped!
            expect(res.matches.length).toBe(1)
            expect(res.matches[0].matchLineNumber).toBe(2)
            expect(res.matches[0].content).toBe('line 2: alpha\nline 3: beta')
        })
    })

    describe('Standalone functional exports', () => {
        it('works with standalone helper functions passing options', async () => {
            mockBridge.addFile('test.md', 'test content')
            const listRes = await listMemories({}, { memoryRoot, bridge: mockBridge })
            expect(listRes.entries.length).toBe(1)

            const readRes = await readMemory({ path: 'test.md' }, { memoryRoot, bridge: mockBridge })
            expect(readRes.content).toBe('test content')

            const searchRes = await searchMemories(
                { queries: ['test'] },
                { memoryRoot, bridge: mockBridge },
            )
            expect(searchRes.matches.length).toBe(1)

            const addRes = await addAdHocNote(
                {
                    filename: '2026-05-26T13-42-08-func.md',
                    note: 'functional note',
                },
                { memoryRoot, bridge: mockBridge },
            )
            expect(addRes.success).toBe(true)

            await deleteLocalMemory({ memoryRoot, bridge: mockBridge })
            expect(mockBridge.files.size).toBe(0)
            await expect(
                readMemory({ path: 'test.md' }, { memoryRoot, bridge: mockBridge }),
            ).rejects.toThrow(/was not found/)
            await expect(
                readMemory(
                    { path: 'extensions/ad_hoc/notes/2026-05-26T13-42-08-func.md' },
                    { memoryRoot, bridge: mockBridge },
                ),
            ).rejects.toThrow(/was not found/)
        })
    })
})
