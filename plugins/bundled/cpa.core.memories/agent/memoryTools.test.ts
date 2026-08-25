/**
 * Unit tests for agent memory tools (memories_list, memories_read, memories_search, memories_add_ad_hoc_note).
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
    LocalMemoriesBackend,
    type ElectronBridgeLike,
    joinPath,
    normalizeSeparators,
    stringToBase64,
} from './localMemoriesBackend'
import {
    MEMORIES_ADD_AD_HOC_NOTE_DESCRIPTION,
    MEMORIES_ADD_AD_HOC_NOTE_PARAMETERS,
    MEMORIES_ADD_AD_HOC_NOTE_TOOL_NAME,
    MEMORIES_LIST_DESCRIPTION,
    MEMORIES_LIST_PARAMETERS,
    MEMORIES_LIST_TOOL_NAME,
    MEMORIES_READ_DESCRIPTION,
    MEMORIES_READ_PARAMETERS,
    MEMORIES_READ_TOOL_NAME,
    MEMORIES_SEARCH_DESCRIPTION,
    MEMORIES_SEARCH_PARAMETERS,
    MEMORIES_SEARCH_TOOL_NAME,
    createMemoryTools,
} from './memoryTools'
import type {
    AddAdHocNoteResponse,
    ListMemoriesResponse,
    ReadMemoryResponse,
    SearchMemoriesResponse,
} from './types'

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

    addDirectory(relativePath: string) {
        const fullPath = joinPath(this.rootDir, relativePath)
        this.MkdirAll(fullPath)
    }
}

describe('Memory Agent Tools', () => {
    let mockBridge: MockElectronBridge
    const memoryRoot = '/test-memories'
    let backend: LocalMemoriesBackend

    beforeEach(() => {
        mockBridge = new MockElectronBridge(memoryRoot)
        backend = LocalMemoriesBackend.fromMemoryRoot(memoryRoot, mockBridge)
    })

    describe('Tool Schemas and Metadata', () => {
        it('exports 4 tool contributions matching specifications', () => {
            const tools = createMemoryTools({ backend })
            expect(tools).toHaveLength(4)

            const toolNames = tools.map((t) => t.name)
            expect(toolNames).toEqual([
                MEMORIES_LIST_TOOL_NAME,
                MEMORIES_READ_TOOL_NAME,
                MEMORIES_SEARCH_TOOL_NAME,
                MEMORIES_ADD_AD_HOC_NOTE_TOOL_NAME,
            ])
        })

        it('defines valid metadata and schema for memories_list', () => {
            const tools = createMemoryTools({ backend })
            const tool = tools.find((t) => t.name === MEMORIES_LIST_TOOL_NAME)!

            expect(tool.description).toBe(MEMORIES_LIST_DESCRIPTION)
            expect(tool.parameters).toEqual(MEMORIES_LIST_PARAMETERS)
            expect((tool.parameters as Record<string, unknown>).type).toBe('object')
            expect((tool.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty('path')
            expect((tool.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty('cursor')
            expect((tool.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty('max_results')
        })

        it('defines valid metadata and schema for memories_read', () => {
            const tools = createMemoryTools({ backend })
            const tool = tools.find((t) => t.name === MEMORIES_READ_TOOL_NAME)!

            expect(tool.description).toBe(MEMORIES_READ_DESCRIPTION)
            expect(tool.parameters).toEqual(MEMORIES_READ_PARAMETERS)
            expect((tool.parameters as { required: string[] }).required).toEqual(['path'])
            expect((tool.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty('line_offset')
            expect((tool.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty('max_lines')
            expect((tool.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty('max_tokens')
        })

        it('defines valid metadata and schema for memories_search', () => {
            const tools = createMemoryTools({ backend })
            const tool = tools.find((t) => t.name === MEMORIES_SEARCH_TOOL_NAME)!

            expect(tool.description).toBe(MEMORIES_SEARCH_DESCRIPTION)
            expect(tool.parameters).toEqual(MEMORIES_SEARCH_PARAMETERS)
            expect((tool.parameters as { required: string[] }).required).toEqual(['queries'])
            expect((tool.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty('match_mode')
            expect((tool.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty('line_count')
            expect((tool.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty('context_lines')
            expect((tool.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty('case_sensitive')
            expect((tool.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty('normalized')
        })

        it('defines valid metadata and schema for memories_add_ad_hoc_note', () => {
            const tools = createMemoryTools({ backend })
            const tool = tools.find((t) => t.name === MEMORIES_ADD_AD_HOC_NOTE_TOOL_NAME)!

            expect(tool.description).toBe(MEMORIES_ADD_AD_HOC_NOTE_DESCRIPTION)
            expect(tool.parameters).toEqual(MEMORIES_ADD_AD_HOC_NOTE_PARAMETERS)
            expect((tool.parameters as { required: string[] }).required).toEqual(['filename', 'note'])
        })
    })

    describe('memories_list execution', () => {
        beforeEach(() => {
            mockBridge.addFile('MEMORY.md', '# Memory Index')
            mockBridge.addFile('memory_summary.md', '# Summary')
            mockBridge.addDirectory('nested')
            mockBridge.addFile('nested/note1.md', 'Note 1')
            mockBridge.addFile('nested/note2.md', 'Note 2')
        })

        it('lists files at root with default parameters', async () => {
            const tools = createMemoryTools({ backend })
            const listTool = tools.find((t) => t.name === MEMORIES_LIST_TOOL_NAME)!

            const res = (await listTool.execute({}, undefined)) as ListMemoriesResponse
            expect(res.truncated).toBe(false)
            expect(res.entries).toEqual([
                { path: 'MEMORY.md', entryType: 'file' },
                { path: 'memory_summary.md', entryType: 'file' },
                { path: 'nested', entryType: 'directory' },
            ])
        })

        it('lists files within a scoped subdirectory', async () => {
            const tools = createMemoryTools({ backend })
            const listTool = tools.find((t) => t.name === MEMORIES_LIST_TOOL_NAME)!

            const res = (await listTool.execute({ path: 'nested' }, undefined)) as ListMemoriesResponse
            expect(res.entries).toEqual([
                { path: 'nested/note1.md', entryType: 'file' },
                { path: 'nested/note2.md', entryType: 'file' },
            ])
        })

        it('maps snake_case max_results and cursor for pagination', async () => {
            const tools = createMemoryTools({ backend })
            const listTool = tools.find((t) => t.name === MEMORIES_LIST_TOOL_NAME)!

            const page1 = (await listTool.execute(
                { max_results: 1 },
                undefined
            )) as ListMemoriesResponse
            expect(page1.entries).toHaveLength(1)
            expect(page1.truncated).toBe(true)
            expect(page1.nextCursor).toBe('1')

            const page2 = (await listTool.execute(
                { cursor: page1.nextCursor, max_results: 2 },
                undefined
            )) as ListMemoriesResponse
            expect(page2.entries).toHaveLength(2)
            expect(page2.truncated).toBe(false)
        })

        it('maps camelCase maxResults as well', async () => {
            const tools = createMemoryTools({ backend })
            const listTool = tools.find((t) => t.name === MEMORIES_LIST_TOOL_NAME)!

            const res = (await listTool.execute(
                { maxResults: 1 },
                undefined
            )) as ListMemoriesResponse
            expect(res.entries).toHaveLength(1)
            expect(res.truncated).toBe(true)
        })

        it('returns formatted error when path does not exist', async () => {
            const tools = createMemoryTools({ backend })
            const listTool = tools.find((t) => t.name === MEMORIES_LIST_TOOL_NAME)!

            const res = await listTool.execute({ path: 'nonexistent' }, undefined)
            expect(typeof res).toBe('string')
            expect(res).toMatch(/^Error: path 'nonexistent' was not found/)
        })

        it('returns formatted error on path traversal attempt', async () => {
            const tools = createMemoryTools({ backend })
            const listTool = tools.find((t) => t.name === MEMORIES_LIST_TOOL_NAME)!

            const res = await listTool.execute({ path: '../outside' }, undefined)
            expect(typeof res).toBe('string')
            expect(res).toMatch(/^Error: path '\.\.\/outside' must stay within the memories root/)
        })

        it('returns formatted error on invalid argument types', async () => {
            const tools = createMemoryTools({ backend })
            const listTool = tools.find((t) => t.name === MEMORIES_LIST_TOOL_NAME)!

            const res1 = await listTool.execute({ path: 123 }, undefined)
            expect(res1).toBe('Error: path must be a string')

            const res2 = await listTool.execute({ max_results: 'many' }, undefined)
            expect(res2).toBe('Error: max_results must be a number')

            const res3 = await listTool.execute({ cursor: {} }, undefined)
            expect(res3).toBe('Error: cursor must be a string')
        })
    })

    describe('memories_read execution', () => {
        beforeEach(() => {
            mockBridge.addFile(
                'MEMORY.md',
                'line 1: header\nline 2: needle content\nline 3: footer\n'
            )
        })

        it('reads entire file with default options', async () => {
            const tools = createMemoryTools({ backend })
            const readTool = tools.find((t) => t.name === MEMORIES_READ_TOOL_NAME)!

            const res = (await readTool.execute({ path: 'MEMORY.md' }, undefined)) as ReadMemoryResponse
            expect(res).toEqual({
                path: 'MEMORY.md',
                startLineNumber: 1,
                content: 'line 1: header\nline 2: needle content\nline 3: footer\n',
                truncated: false,
            })
        })

        it('maps snake_case line_offset and max_lines correctly', async () => {
            const tools = createMemoryTools({ backend })
            const readTool = tools.find((t) => t.name === MEMORIES_READ_TOOL_NAME)!

            const res = (await readTool.execute(
                {
                    path: 'MEMORY.md',
                    line_offset: 2,
                    max_lines: 1,
                },
                undefined
            )) as ReadMemoryResponse
            expect(res).toEqual({
                path: 'MEMORY.md',
                startLineNumber: 2,
                content: 'line 2: needle content\n',
                truncated: true,
            })
        })

        it('maps snake_case max_tokens correctly', async () => {
            const tools = createMemoryTools({ backend })
            const readTool = tools.find((t) => t.name === MEMORIES_READ_TOOL_NAME)!
            mockBridge.addFile('long.md', 'B'.repeat(400))

            const res = (await readTool.execute(
                {
                    path: 'long.md',
                    max_tokens: 10,
                },
                undefined
            )) as ReadMemoryResponse
            expect(res.truncated).toBe(true)
            expect(res.content).toContain('tokens truncated')
        })

        it('maps camelCase options lineOffset, maxLines, maxTokens', async () => {
            const tools = createMemoryTools({ backend })
            const readTool = tools.find((t) => t.name === MEMORIES_READ_TOOL_NAME)!

            const res = (await readTool.execute(
                {
                    path: 'MEMORY.md',
                    lineOffset: 1,
                    maxLines: 2,
                    maxTokens: 500,
                },
                undefined
            )) as ReadMemoryResponse
            expect(res.startLineNumber).toBe(1)
            expect(res.content).toBe('line 1: header\nline 2: needle content\n')
            expect(res.truncated).toBe(true)
        })

        it('returns formatted error when path is missing or empty', async () => {
            const tools = createMemoryTools({ backend })
            const readTool = tools.find((t) => t.name === MEMORIES_READ_TOOL_NAME)!

            const res1 = await readTool.execute({}, undefined)
            expect(res1).toBe('Error: path is required and must be a non-empty string')

            const res2 = await readTool.execute({ path: '   ' }, undefined)
            expect(res2).toBe('Error: path is required and must be a non-empty string')

            const res3 = await readTool.execute({ path: 123 }, undefined)
            expect(res3).toBe('Error: path is required and must be a non-empty string')
        })

        it('returns formatted error when file does not exist', async () => {
            const tools = createMemoryTools({ backend })
            const readTool = tools.find((t) => t.name === MEMORIES_READ_TOOL_NAME)!

            const res = await readTool.execute({ path: 'nonexistent.md' }, undefined)
            expect(res).toBe("Error: path 'nonexistent.md' was not found")
        })

        it('returns formatted error on invalid line_offset or max_lines', async () => {
            const tools = createMemoryTools({ backend })
            const readTool = tools.find((t) => t.name === MEMORIES_READ_TOOL_NAME)!

            const res1 = await readTool.execute(
                { path: 'MEMORY.md', line_offset: 0 },
                undefined
            )
            expect(res1).toBe('Error: line_offset must be a 1-indexed line number')

            const res2 = await readTool.execute(
                { path: 'MEMORY.md', max_lines: -1 },
                undefined
            )
            expect(res2).toBe('Error: max_lines must be a positive integer')

            const res3 = await readTool.execute(
                { path: 'MEMORY.md', line_offset: 'first' },
                undefined
            )
            expect(res3).toBe('Error: line_offset must be a number')
        })
    })

    describe('memories_search execution', () => {
        beforeEach(() => {
            mockBridge.addFile('MEMORY.md', 'typescript react coding\nagent architecture\n')
            mockBridge.addFile('sub/guide.md', 'TypeScript React coding best practices\n')
        })

        it('searches with default any match mode and maps queries', async () => {
            const tools = createMemoryTools({ backend })
            const searchTool = tools.find((t) => t.name === MEMORIES_SEARCH_TOOL_NAME)!

            const res = (await searchTool.execute(
                { queries: ['typescript', 'architecture'] },
                undefined
            )) as SearchMemoriesResponse
            expect(res.queries).toEqual(['typescript', 'architecture'])
            expect(res.matchMode).toBe('any')
            expect(res.matches.length).toBe(3)
        })

        it('maps snake_case match_mode, line_count, context_lines, case_sensitive, normalized', async () => {
            const tools = createMemoryTools({ backend })
            const searchTool = tools.find((t) => t.name === MEMORIES_SEARCH_TOOL_NAME)!

            mockBridge.addFile(
                'case.md',
                'Line 1: TypeScript React\nLine 2: Other\nLine 3: Agent System\n'
            )

            const resAllOnSameLine = (await searchTool.execute(
                {
                    queries: ['TypeScript', 'React'],
                    path: 'case.md',
                    match_mode: 'all_on_same_line',
                    case_sensitive: true,
                },
                undefined
            )) as SearchMemoriesResponse
            expect(resAllOnSameLine.matches.length).toBe(1)
            expect(resAllOnSameLine.matches[0].content).toBe('Line 1: TypeScript React')

            const resAllWithinLines = (await searchTool.execute(
                {
                    queries: ['TypeScript', 'Agent'],
                    path: 'case.md',
                    match_mode: 'all_within_lines',
                    line_count: 3,
                    context_lines: 0,
                },
                undefined
            )) as SearchMemoriesResponse
            expect(resAllWithinLines.matches.length).toBe(1)
        })

        it('maps camelCase parameters for search', async () => {
            const tools = createMemoryTools({ backend })
            const searchTool = tools.find((t) => t.name === MEMORIES_SEARCH_TOOL_NAME)!

            const res = (await searchTool.execute(
                {
                    queries: ['typescript', 'react'],
                    matchMode: 'all_on_same_line',
                    caseSensitive: false,
                    maxResults: 1,
                },
                undefined
            )) as SearchMemoriesResponse
            expect(res.matches.length).toBe(1)
            expect(res.truncated).toBe(true)
            expect(res.nextCursor).toBe('1')
        })

        it('returns formatted error when queries is missing or not an array', async () => {
            const tools = createMemoryTools({ backend })
            const searchTool = tools.find((t) => t.name === MEMORIES_SEARCH_TOOL_NAME)!

            const res1 = await searchTool.execute({}, undefined)
            expect(res1).toBe('Error: queries is required and must be an array of strings')

            const res2 = await searchTool.execute({ queries: 'typescript' }, undefined)
            expect(res2).toBe('Error: queries is required and must be an array of strings')

            const res3 = await searchTool.execute({ queries: [123] }, undefined)
            expect(res3).toBe('Error: queries must contain only strings')
        })

        it('returns formatted error when queries array is empty or contains empty strings', async () => {
            const tools = createMemoryTools({ backend })
            const searchTool = tools.find((t) => t.name === MEMORIES_SEARCH_TOOL_NAME)!

            const res1 = await searchTool.execute({ queries: [] }, undefined)
            expect(res1).toBe('Error: queries must not be empty or contain empty strings')

            const res2 = await searchTool.execute({ queries: ['   '] }, undefined)
            expect(res2).toBe('Error: queries must not be empty or contain empty strings')
        })

        it('returns formatted error for invalid match_mode enum or line_count', async () => {
            const tools = createMemoryTools({ backend })
            const searchTool = tools.find((t) => t.name === MEMORIES_SEARCH_TOOL_NAME)!

            const res1 = await searchTool.execute(
                { queries: ['test'], match_mode: 'invalid_mode' },
                undefined
            )
            expect(res1).toBe(
                "Error: match_mode must be one of 'any', 'all_on_same_line', 'all_within_lines'"
            )

            const res2 = await searchTool.execute(
                {
                    queries: ['test'],
                    match_mode: 'all_within_lines',
                    line_count: -1,
                },
                undefined
            )
            expect(res2).toBe('Error: all_within_lines.line_count must be a positive integer')
        })
    })

    describe('memories_add_ad_hoc_note execution', () => {
        it('successfully writes ad-hoc note and returns response', async () => {
            const tools = createMemoryTools({ backend })
            const addTool = tools.find(
                (t) => t.name === MEMORIES_ADD_AD_HOC_NOTE_TOOL_NAME
            )!

            const filename = '2026-05-26T13-42-08-coding-style.md'
            const note = 'Prefer functional components with TypeScript.'

            const res = (await addTool.execute(
                { filename, note },
                undefined
            )) as AddAdHocNoteResponse
            expect(res).toEqual({
                success: true,
                path: `extensions/ad_hoc/notes/${filename}`,
            })

            const readTool = tools.find((t) => t.name === MEMORIES_READ_TOOL_NAME)!
            const readRes = (await readTool.execute(
                { path: `extensions/ad_hoc/notes/${filename}` },
                undefined
            )) as ReadMemoryResponse
            expect(readRes.content).toBe(note)
        })

        it('returns formatted error when filename or note is missing or empty', async () => {
            const tools = createMemoryTools({ backend })
            const addTool = tools.find(
                (t) => t.name === MEMORIES_ADD_AD_HOC_NOTE_TOOL_NAME
            )!

            const res1 = await addTool.execute({ note: 'some note' }, undefined)
            expect(res1).toBe('Error: filename is required and must be a non-empty string')

            const res2 = await addTool.execute(
                { filename: '2026-05-26T13-42-08-test.md' },
                undefined
            )
            expect(res2).toBe('Error: note is required and must be a non-empty string')

            const res3 = await addTool.execute(
                { filename: '2026-05-26T13-42-08-test.md', note: '   ' },
                undefined
            )
            expect(res3).toBe('Error: note is required and must be a non-empty string')
        })

        it('returns formatted error when filename format is invalid', async () => {
            const tools = createMemoryTools({ backend })
            const addTool = tools.find(
                (t) => t.name === MEMORIES_ADD_AD_HOC_NOTE_TOOL_NAME
            )!

            const res1 = await addTool.execute(
                { filename: 'invalid-name.md', note: 'content' },
                undefined
            )
            expect(res1).toBe("Error: filename 'invalid-name.md' must use YYYY-MM-DDTHH-MM-SS-<slug>.md")

            const res2 = await addTool.execute(
                { filename: '../2026-05-26T13-42-08-escape.md', note: 'content' },
                undefined
            )
            expect(res2).toBe("Error: filename '../2026-05-26T13-42-08-escape.md' must use YYYY-MM-DDTHH-MM-SS-<slug>.md")
        })

        it('returns formatted error when note already exists', async () => {
            const tools = createMemoryTools({ backend })
            const addTool = tools.find(
                (t) => t.name === MEMORIES_ADD_AD_HOC_NOTE_TOOL_NAME
            )!

            const filename = '2026-05-26T13-42-08-existing.md'
            await addTool.execute({ filename, note: 'first' }, undefined)

            const resDuplicate = await addTool.execute(
                { filename, note: 'second' },
                undefined
            )
            expect(resDuplicate).toBe(
                `Error: ad-hoc note '${filename}' already exists`
            )
        })
    })

    describe('createMemoryTools options and backend resolution', () => {
        it('supports rootDir and bridge options directly', async () => {
            mockBridge.addFile('from_root_dir.md', 'hello root dir')
            const tools = createMemoryTools({
                rootDir: memoryRoot,
                bridge: mockBridge,
            })
            const readTool = tools.find((t) => t.name === MEMORIES_READ_TOOL_NAME)!
            const res = (await readTool.execute(
                { path: 'from_root_dir.md' },
                undefined
            )) as ReadMemoryResponse
            expect(res.content).toBe('hello root dir')
        })

        it('supports memoryRoot alias option', async () => {
            mockBridge.addFile('from_memory_root.md', 'hello memory root')
            const tools = createMemoryTools({
                memoryRoot,
                bridge: mockBridge,
            })
            const readTool = tools.find((t) => t.name === MEMORIES_READ_TOOL_NAME)!
            const res = (await readTool.execute(
                { path: 'from_memory_root.md' },
                undefined
            )) as ReadMemoryResponse
            expect(res.content).toBe('hello memory root')
        })

        it('falls back to default backend when options are omitted', () => {
            const tools = createMemoryTools()
            expect(tools).toHaveLength(4)
        })
    })
})
