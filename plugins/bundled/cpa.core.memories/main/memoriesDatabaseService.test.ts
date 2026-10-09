import Database, { type Database as DatabaseType, type Statement } from 'better-sqlite3'
import fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAppConfigDirName } from '@cpa/plugin-api'
import { MemoriesDatabaseService } from './memoriesDatabaseService.js'
import { approxTokenCount, truncateMiddleWithTokenBudget } from '../shared/tokenBudget.js'
import type { AddMemoryRequest, ReadMemoriesRequest, SearchMemoriesRequest } from '../shared/types.js'

describe('MemoriesDatabaseService', () => {
    let memoryRoot: string
    let service: MemoriesDatabaseService

    beforeEach(() => {
        memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-memories-db-test-'))
        service = new MemoriesDatabaseService({ memoryRoot })
    })

    afterEach(() => {
        vi.restoreAllMocks()
        service.close()
        fs.rmSync(memoryRoot, { recursive: true, force: true })
    })

    function writeLegacy(relativePath: string, content = 'legacy sqlite memory'): string {
        const filePath = path.join(memoryRoot, relativePath)
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, content)
        return filePath
    }

    function inspect<T>(callback: (db: DatabaseType) => T, dbPath = path.join(memoryRoot, 'memories.db')): T {
        const db = new Database(dbPath, { readonly: true })
        try {
            return callback(db)
        } finally {
            db.close()
        }
    }

    function migrationMarker(): unknown {
        return inspect((db) => db.prepare("SELECT value FROM memories_meta WHERE key = 'legacy_files_migrated'").get())
    }

    it('creates database when memory root is missing', () => {
        service.close()
        fs.rmSync(memoryRoot, { recursive: true })
        const pragma = vi.spyOn(Database.prototype, 'pragma')
        service = new MemoriesDatabaseService({ memoryRoot })
        expect(fs.existsSync(memoryRoot)).toBe(false)
        expect(service.search({ queries: ['x'] })).toEqual({ matches: [], truncated: false })
        expect(fs.existsSync(path.join(memoryRoot, 'memories.db'))).toBe(true)
        expect(migrationMarker()).toEqual({ value: '1' })
        expect(pragma).toHaveBeenCalledWith('journal_mode = WAL')
        expect(pragma).toHaveBeenCalledWith('busy_timeout = 5000')
        expect(pragma).toHaveBeenCalledWith('synchronous = NORMAL')
        expect(inspect((db) => db.pragma('journal_mode', { simple: true }))).toBe('wal')
    })

    it('uses the configured home directory and supports a separate database path', () => {
        const defaultService = new MemoriesDatabaseService()
        try {
            expect(defaultService.getDbPath()).toBe(path.join(os.homedir(), getAppConfigDirName(), 'memories', 'memories.db'))
        } finally {
            defaultService.close()
        }
        service.close()
        writeLegacy('legacy.md', 'separate database')
        const dbPath = path.join(memoryRoot, 'database', 'custom.db')
        service = new MemoriesDatabaseService({ memoryRoot, dbPath })
        expect(service.search({ queries: ['separate'] }).matches[0].id).toBe(1)
        expect(service.getDbPath()).toBe(dbPath)
        expect(fs.existsSync(dbPath)).toBe(true)
    })

    it('migrates legacy markdown files once in chronological order', () => {
        const later = writeLegacy('extensions/ad_hoc/notes/2026-09-18T00-30-00-b-note.md', 'later')
        const earlier = writeLegacy('extensions/ad_hoc/notes/2026-09-15T10-00-00-a-note.md', 'earlier')
        expect(service.read({ ids: [1, 2] })).toEqual({
            memories: [
                { id: 1, title: 'a-note', content: 'earlier', truncated: false },
                { id: 2, title: 'b-note', content: 'later', truncated: false },
            ],
            missingIds: [],
        })
        expect(inspect((db) => db.prepare('SELECT created_at, updated_at FROM memories ORDER BY id').all())).toEqual([
            { created_at: new Date(2026, 8, 15, 10, 0, 0).getTime(), updated_at: new Date(2026, 8, 15, 10, 0, 0).getTime() },
            { created_at: new Date(2026, 8, 18, 0, 30, 0).getTime(), updated_at: new Date(2026, 8, 18, 0, 30, 0).getTime() },
        ])
        expect(fs.readFileSync(earlier, 'utf8')).toBe('earlier')
        expect(fs.readFileSync(later, 'utf8')).toBe('later')
        service.close()
        writeLegacy('2026-09-19T00-00-00-new.md', 'not imported')
        service = new MemoriesDatabaseService({ memoryRoot })
        expect(service.read({ ids: [1, 2, 3] }).missingIds).toEqual([3])
        expect(migrationMarker()).toEqual({ value: '1' })
    })

    it('migrates non-standard filenames with fallback title and mtime', () => {
        const note = writeLegacy('notes.md')
        fs.utimesSync(note, 1234567890, 1234567890.125)
        const createdAt = Math.floor(fs.statSync(note).mtimeMs)
        writeLegacy('x.md.bak')
        writeLegacy('UPPER.MD')
        writeLegacy('.hidden.md')
        writeLegacy('.git/y.md')
        fs.symlinkSync(note, path.join(memoryRoot, 'link.md'))
        const linkedDir = path.join(memoryRoot, 'linked-directory')
        fs.symlinkSync(path.join(memoryRoot, '.git'), linkedDir, 'dir')
        expect(service.search({ queries: ['sqlite'] }).matches.map((hit) => hit.title)).toEqual(['notes'])
        expect(inspect((db) => db.prepare('SELECT created_at, updated_at FROM memories').get())).toEqual({
            created_at: createdAt,
            updated_at: createdAt,
        })
    })

    it('orders equal timestamps by relative path and keeps non-ASCII titles', () => {
        writeLegacy('z/2026-09-15T10-00-00-Z.md', 'last')
        writeLegacy('a/2026-09-15T10-00-00-记忆.md', 'first')
        expect(service.read({ ids: [1, 2] }).memories.map((memory) => memory.title)).toEqual(['记忆', 'Z'])
    })

    it.skipIf(process.platform === 'win32')('skips unreadable files during migration', () => {
        writeLegacy('good.md')
        const unreadable = writeLegacy('unreadable.md')
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        fs.chmodSync(unreadable, 0o000)
        try {
            expect(service.search({ queries: ['sqlite'] }).matches.map((hit) => hit.title)).toEqual(['good'])
            expect(warn).toHaveBeenCalledWith(expect.stringContaining(unreadable), expect.any(Error))
            expect(migrationMarker()).toEqual({ value: '1' })
        } finally {
            fs.chmodSync(unreadable, 0o600)
        }
    })

    it.skipIf(process.platform === 'win32')('skips unreadable subdirectories during migration', () => {
        writeLegacy('good.md')
        writeLegacy('readable/nested.md')
        writeLegacy('unreadable/hidden.md')
        const unreadable = path.join(memoryRoot, 'unreadable')
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        fs.chmodSync(unreadable, 0o000)
        try {
            expect(service.search({ queries: ['sqlite'] }).matches.map((hit) => hit.title).sort()).toEqual(['good', 'nested'])
            expect(warn).toHaveBeenCalledWith(expect.stringContaining(unreadable), expect.any(Error))
            expect(migrationMarker()).toEqual({ value: '1' })
        } finally {
            fs.chmodSync(unreadable, 0o700)
        }
    })

    it('skips a file removed during migration', () => {
        writeLegacy('good.md')
        const removed = writeLegacy('removed.md')
        const originalRead = fs.readFileSync
        vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
            if (args[0] === removed) throw new Error('file disappeared')
            return originalRead(...args)
        })
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        expect(service.search({ queries: ['sqlite'] }).matches.map((hit) => hit.title)).toEqual(['good'])
        expect(warn).toHaveBeenCalled()
        expect(migrationMarker()).toEqual({ value: '1' })
    })

    it('rolls back migration on failure', () => {
        writeLegacy('2026-09-15T10-00-00-a.md')
        writeLegacy('2026-09-18T00-30-00-b.md')
        const originalPrepare = Database.prototype.prepare
        let inserts = 0
        const prepare = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: DatabaseType, sql: string) {
            const statement = originalPrepare.call(this, sql) as Statement
            if (sql.includes('INSERT INTO memories (')) {
                const originalRun = statement.run
                vi.spyOn(statement, 'run').mockImplementation((...params: unknown[]) => {
                    inserts++
                    if (inserts === 2) throw new Error('migration insert failed')
                    return originalRun.apply(statement, params)
                })
            }
            return statement
        })
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        expect(() => service.search({ queries: ['sqlite'] })).toThrow('migration insert failed')
        expect(inspect((db) => db.prepare('SELECT * FROM memories').all())).toEqual([])
        expect(migrationMarker()).toBeUndefined()
        expect(warn).toHaveBeenCalled()
        prepare.mockRestore()
        expect(service.read({ ids: [1, 2] }).memories.map((memory) => memory.title)).toEqual(['a', 'b'])
        expect(migrationMarker()).toEqual({ value: '1' })
    })

    it('search aggregates per memory, orders by id desc, paginates', () => {
        for (let i = 1; i <= 3; i++) service.add({ title: `note ${i}`, note: 'intro\n  sqlite first  \nsqlite second' })
        expect(service.search({ queries: ['sqlite'], maxResults: 2 })).toEqual({
            matches: [
                { id: 3, title: 'note 3', matchedQueries: ['sqlite'], snippet: 'sqlite first' },
                { id: 2, title: 'note 2', matchedQueries: ['sqlite'], snippet: 'sqlite first' },
            ],
            nextCursor: '2',
            truncated: true,
        })
        expect(service.search({ queries: ['sqlite'], cursor: '2' })).toEqual({
            matches: [{ id: 1, title: 'note 1', matchedQueries: ['sqlite'], snippet: 'sqlite first' }],
            truncated: false,
        })
        expect(service.search({ queries: ['sqlite'], cursor: '3' })).toEqual({ matches: [], truncated: false })
        expect(() => service.search({ queries: ['sqlite'], cursor: '9' })).toThrow('exceeds result count')
        expect(service.search({ queries: ['absent'] })).toEqual({ matches: [], truncated: false })
    })

    it('search preserves matcher modes, keyword union, case, normalization and snippets', () => {
        service.add({ title: 'split', note: 'prefix\n  SQLite  \ntransactions' })
        service.add({ title: 'same', note: 'SQLite transactions\n' + 'sqlite '.repeat(30) })
        expect(service.search({ queries: ['transactions', 'sqlite'] }).matches[1]).toEqual({
            id: 1, title: 'split', matchedQueries: ['transactions', 'sqlite'], snippet: 'SQLite',
        })
        expect(service.search({ queries: ['sqlite', 'transactions'], matchMode: 'all_on_same_line' }).matches.map((hit) => hit.id)).toEqual([2])
        expect(service.search({ queries: ['sqlite', 'transactions'], matchMode: 'all_within_lines', lineCount: 2 }).matches.map((hit) => hit.id)).toEqual([2, 1])
        expect(service.search({ queries: ['SQLITE'], caseSensitive: true }).matches).toEqual([])
        expect(service.search({ queries: ['s-q_l.i t e'], normalized: true }).matches.map((hit) => hit.id)).toEqual([2, 1])
        expect(service.search({ queries: ['sqlite '], caseSensitive: true }).matches[0].snippet).toBe(('sqlite '.repeat(30)).trim().slice(0, 120) + '…')
    })

    it('read returns requested order, missingIds and shares token budget', () => {
        service.add({ title: 'small', note: 'a'.repeat(40) })
        service.add({ title: 'large', note: 'b'.repeat(400) })
        expect(service.read({ ids: [2, 99, 1], maxTokens: 60 })).toEqual({
            memories: [
                { id: 2, title: 'large', ...truncateMiddleWithTokenBudget('b'.repeat(400), 30) },
                { id: 1, title: 'small', content: 'a'.repeat(40), truncated: false },
            ],
            missingIds: [99],
        })
        expect(service.read({ ids: [99, 98, 99] })).toEqual({ memories: [], missingIds: [99, 98] })
        expect(service.read({ ids: [1, 1, 2] }).memories.map((memory) => memory.id)).toEqual([1, 2])
    })

    it('deducts actual returned tokens including truncation markers and clamps remaining budget', () => {
        service.add({ title: 'first', note: 'a'.repeat(400) })
        service.add({ title: 'second', note: 'b'.repeat(400) })
        const first = truncateMiddleWithTokenBudget('a'.repeat(400), 30)
        const second = truncateMiddleWithTokenBudget('b'.repeat(400), Math.max(0, 60 - approxTokenCount(first.content)))
        expect(service.read({ ids: [1, 2], maxTokens: 60 }).memories).toEqual([
            { id: 1, title: 'first', ...first }, { id: 2, title: 'second', ...second },
        ])
        expect(service.read({ ids: [1, 2], maxTokens: 1 }).memories.map((memory) => memory.content)).toEqual([
            '…100 tokens truncated…', '…100 tokens truncated…',
        ])
    })

    it('add stores timestamps and returns id', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1790000000123)
        expect(service.add({ title: '  new note  ', note: '  full markdown\n' })).toEqual({ success: true, id: 1 })
        expect(inspect((db) => db.prepare('SELECT * FROM memories').get())).toEqual({
            id: 1, title: 'new note', content: '  full markdown\n', created_at: 1790000000123, updated_at: 1790000000123,
        })
        expect(service.add({ title: 'new note', note: 'duplicates allowed' })).toEqual({ success: true, id: 2 })
    })

    it('validates requests before opening the database', () => {
        expect(() => service.search({ queries: ['!!!'], normalized: true })).toThrow('queries must not be empty')
        expect(() => service.search({ queries: ['x'], matchMode: 'invalid' } as unknown as SearchMemoriesRequest)).toThrow('match_mode')
        for (const ids of [[1.5], [-1], ['1'], Array.from({ length: 21 }, (_, i) => i + 1)]) {
            expect(() => service.read({ ids } as ReadMemoriesRequest)).toThrow('positive integers')
        }
        expect(() => service.add({ title: '\ninvalid', note: 'note' })).toThrow('title must be')
        expect(() => service.add({ title: 'valid', note: 12 } as unknown as AddMemoryRequest)).toThrow('note must not be empty')
        expect(fs.existsSync(path.join(memoryRoot, 'memories.db'))).toBe(false)
    })

    it('clear vacuums in WAL mode and keeps legacy backups without re-running migration', () => {
        const legacy = writeLegacy('legacy.md')
        service.add({ title: 'new', note: 'sqlite' })
        const exec = vi.spyOn(Database.prototype, 'exec')
        expect(inspect((db) => db.pragma('journal_mode', { simple: true }))).toBe('wal')
        expect(() => service.clear()).not.toThrow()
        expect(exec).toHaveBeenCalledWith('VACUUM')
        expect(inspect((db) => db.prepare('SELECT * FROM memories').all())).toEqual([])
        expect(service.search({ queries: ['sqlite'] })).toEqual({ matches: [], truncated: false })
        expect(migrationMarker()).toEqual({ value: '1' })
        expect(fs.readFileSync(legacy, 'utf8')).toBe('legacy sqlite memory')
        service.close()
        service = new MemoriesDatabaseService({ memoryRoot })
        expect(service.search({ queries: ['sqlite'] }).matches).toEqual([])
        expect(service.add({ title: 'after clear', note: 'sqlite' }).id).toBe(3)
    })

    it('clear migrates before deleting on the first call', () => {
        writeLegacy('legacy.md')
        service.clear()
        service.close()
        service = new MemoriesDatabaseService({ memoryRoot })
        expect(service.search({ queries: ['sqlite'] }).matches).toEqual([])
        expect(migrationMarker()).toEqual({ value: '1' })
    })

    it('close is repeatable and subsequent calls reopen the database', () => {
        service.add({ title: 'saved', note: 'sqlite' })
        service.close()
        service.close()
        expect(service.read({ ids: [1] }).memories[0].title).toBe('saved')
    })
})
