import Database, { type Database as DatabaseType, type Statement } from 'better-sqlite3'
import fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAppConfigDirName } from '@cpa/plugin-api'
import { MemoriesDatabaseService } from './memoriesDatabaseService.js'
import { approxTokenCount, truncateMiddleWithTokenBudget } from '../shared/tokenBudget.js'
import * as memorySearch from '../shared/memorySearch.js'
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

    it.each([
        { matchMode: 'any', queries: ['sqlite', 'transactions'], expected: [6, 5, 4, 3, 2], candidates: [6, 5, 4, 3, 2] },
        { matchMode: 'all_on_same_line', queries: ['sqlite', 'transactions'], expected: [5], candidates: [6, 5, 4] },
        { matchMode: 'all_within_lines', queries: ['sqlite', 'transactions'], expected: [5, 4], candidates: [6, 5, 4] },
        { matchMode: 'all_on_same_line', queries: ['sqlite', 'db'], expected: [5], candidates: [6, 5, 4, 2] },
        { matchMode: 'all_within_lines', queries: ['sqlite', 'db'], expected: [5, 4], candidates: [6, 5, 4, 2] },
    ] satisfies { matchMode: SearchMemoriesRequest['matchMode']; queries: string[]; expected: number[]; candidates: number[] }[])(
        'pre-filters FTS candidates for $matchMode with $queries before exact line matching',
        ({ matchMode, queries, expected, candidates }) => {
            const notes = ['unrelated', 'sqlite', 'transactions db', 'SQLite\ntransactions db', 'SQLite transactions db', 'SQLite\nspacer\ntransactions db']
            for (const note of notes) service.add({ title: note.split('\n')[0], note })
            const match = vi.spyOn(memorySearch, 'matchMemoryContent')
            const prepare = vi.spyOn(Database.prototype, 'prepare')
            expect(service.search({ queries, matchMode, lineCount: 2 }).matches.map((hit) => hit.id)).toEqual(expected)
            expect(match.mock.calls.map(([content]) => content)).toEqual(candidates.map((id) => notes[id - 1]))
            expect(prepare.mock.calls.some(([sql]) => sql.includes('content MATCH ?'))).toBe(true)
        },
    )

    it.each([
        { request: { queries: ['db'] }, note: 'db', matches: true },
        { request: { queries: ['sqlite', 'db'] }, note: 'db', matches: true },
        { request: { queries: ['😀😀'] }, note: '😀😀', matches: true },
        { request: { queries: ['sqlite'], normalized: true }, note: 'sql-ite', matches: true },
        { request: { queries: ['sql\nite'] }, note: 'sql\nite', matches: false },
        { request: { queries: ['sql\rite'] }, note: 'sql\rite', matches: true },
        { request: { queries: ['ab\0cd'] }, note: 'ab\0cd', matches: true },
        { request: { queries: ['ab\0cd'], caseSensitive: true }, note: 'ab\0cd', matches: true },
        { request: { queries: ['école'] }, note: 'ÉCOLE', matches: true },
        { request: { queries: ['i\u0307stanbul'] }, note: 'İSTANBUL', matches: true },
        { request: { queries: ['db', 'x'], matchMode: 'all_on_same_line' }, note: 'db x', matches: true },
        { request: { queries: ['db', 'x'], matchMode: 'all_within_lines', lineCount: 2 }, note: 'db\nx', matches: true },
    ] satisfies { request: SearchMemoriesRequest; note: string; matches: boolean }[])(
        'falls back to all rows when FTS is unsafe for $request',
        ({ request, note, matches }) => {
            service.add({ title: 'target', note })
            service.add({ title: 'unrelated', note: 'unrelated' })
            const match = vi.spyOn(memorySearch, 'matchMemoryContent')
            const prepare = vi.spyOn(Database.prototype, 'prepare')
            expect(service.search(request).matches.map((hit) => hit.id)).toEqual(matches ? [1] : [])
            expect(match.mock.calls.map(([content]) => content)).toEqual(['unrelated', note])
            expect(prepare).toHaveBeenCalledWith('SELECT id, title, content FROM memories ORDER BY id DESC')
            expect(prepare.mock.calls.some(([sql]) => sql.includes('MATCH ?'))).toBe(false)
        },
    )

    it.each(['say "yes"', 'sqlite OR memory', '记忆数据库', '😀😀😀'])('escapes FTS phrases and supports Unicode code points for %s', (query) => {
        service.add({ title: 'target', note: 'prefix ' + query + ' suffix' })
        service.add({ title: 'unrelated', note: 'sqlite alone' })
        const match = vi.spyOn(memorySearch, 'matchMemoryContent')
        expect(service.search({ queries: [query] }).matches.map((hit) => hit.id)).toEqual([1])
        expect(match).toHaveBeenCalledTimes(1)
    })

    it.each([
        { upper: 'ÉCOLE', lower: 'école' },
        { upper: 'İSTANBUL', lower: 'i\u0307stanbul' },
        { upper: 'Kelvin', lower: 'kelvin' },
    ])('preserves non-ASCII case matching for $upper / $lower', ({ upper, lower }) => {
        service.add({ title: 'upper', note: upper })
        service.add({ title: 'lower', note: lower })
        expect(inspect((db) => db.prepare('SELECT memory_id FROM memories_unicode_docs ORDER BY memory_id').all()))
            .toEqual(lower === 'kelvin' ? [{ memory_id: 1 }] : [{ memory_id: 1 }, { memory_id: 2 }])
        for (const matchMode of ['any', 'all_on_same_line', 'all_within_lines'] as const) {
            expect(service.search({ queries: [lower], matchMode, lineCount: 2 }).matches.map((hit) => hit.id)).toEqual([2, 1])
            expect(service.search({ queries: [upper], matchMode, lineCount: 2 }).matches.map((hit) => hit.id)).toEqual([2, 1])
            expect(service.search({ queries: [lower], matchMode, lineCount: 2, caseSensitive: true }).matches.map((hit) => hit.id)).toEqual([2])
            expect(service.search({ queries: [upper], matchMode, lineCount: 2, caseSensitive: true }).matches.map((hit) => hit.id)).toEqual([1])
        }
    })

    it('keeps Unicode fallback candidates when eligible and ineligible queries are mixed in all modes', () => {
        service.add({ title: 'same line', note: 'Kelvin İSTANBUL' })
        service.add({ title: 'split', note: 'Kelvin\nİSTANBUL' })
        service.add({ title: 'unrelated', note: 'unrelated' })
        const match = vi.spyOn(memorySearch, 'matchMemoryContent')
        for (const matchMode of ['all_on_same_line', 'all_within_lines'] as const) {
            match.mockClear()
            expect(service.search({ queries: ['kelvin', 'i\u0307stanbul'], matchMode, lineCount: 2 }).matches.map((hit) => hit.id))
                .toEqual(matchMode === 'all_on_same_line' ? [1] : [2, 1])
            expect(match.mock.calls.map(([content]) => content)).toEqual(['Kelvin\nİSTANBUL', 'Kelvin İSTANBUL'])
        }
    })

    it('uses case-sensitive FTS candidates as a superset and checks ASCII case exactly', () => {
        service.add({ title: 'upper', note: 'SQLite' })
        service.add({ title: 'lower', note: 'sqlite' })
        service.add({ title: 'Unicode fallback only', note: 'ÉCOLE' })
        const match = vi.spyOn(memorySearch, 'matchMemoryContent')
        const prepare = vi.spyOn(Database.prototype, 'prepare')
        expect(service.search({ queries: ['SQLite'], caseSensitive: true }).matches.map((hit) => hit.id)).toEqual([1])
        expect(match.mock.calls.map(([content]) => content)).toEqual(['ÉCOLE', 'sqlite', 'SQLite'])
        expect(prepare.mock.calls.some(([sql]) => sql.includes('content MATCH ?') && sql.includes('OR m.id IN (SELECT memory_id FROM memories_unicode_docs)'))).toBe(true)
    })

    it.each([false, true])('matches NUL queries and text after NUL with caseSensitive=%s in all modes', (caseSensitive) => {
        service.add({ title: 'NUL query', note: 'ab\0cd' })
        service.add({ title: 'NUL content', note: 'prefix\0needle' })
        service.add({ title: 'different case', note: 'prefix\0NEEDLE' })
        service.add({ title: 'unrelated', note: 'abcd' })
        expect(inspect((db) => db.prepare('SELECT * FROM memories_unicode_docs ORDER BY memory_id').all())).toEqual([
            { memory_id: 1, has_unicode_case: 1 },
            { memory_id: 2, has_unicode_case: 1 },
            { memory_id: 3, has_unicode_case: 1 },
        ])
        const prepare = vi.spyOn(Database.prototype, 'prepare')
        for (const matchMode of ['any', 'all_on_same_line', 'all_within_lines'] as const) {
            prepare.mockClear()
            expect(service.search({ queries: ['ab\0cd'], caseSensitive, matchMode, lineCount: 2 })).toEqual({
                matches: [{ id: 1, title: 'NUL query', matchedQueries: ['ab\0cd'], snippet: 'ab\0cd' }],
                truncated: false,
            })
            expect(prepare.mock.calls.some(([sql]) => sql.includes('MATCH ?'))).toBe(false)
            expect(service.search({ queries: ['needle'], caseSensitive, matchMode, lineCount: 2 }).matches).toEqual([
                ...(!caseSensitive ? [{ id: 3, title: 'different case', matchedQueries: ['needle'], snippet: 'prefix\0NEEDLE' }] : []),
                { id: 2, title: 'NUL content', matchedQueries: ['needle'], snippet: 'prefix\0needle' },
            ])
            expect(prepare.mock.calls.some(([sql]) => sql.includes('content MATCH ?'))).toBe(true)
        }
    })

    it.each([false, true])('builds search indexes for an existing migrated database with an existing index marker: %s', (hasIndexMarker) => {
        const db = new Database(path.join(memoryRoot, 'memories.db'))
        try {
            db.exec(`
                CREATE TABLE memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE memories_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                INSERT INTO memories_meta (key, value) VALUES ('legacy_files_migrated', '1');
            `)
            const insert = db.prepare('INSERT INTO memories (title, content, created_at, updated_at) VALUES (?, ?, 1, 1)')
            for (const note of ['sqlite memory', 'Kelvin', 'İSTANBUL', 'ÉCOLE']) insert.run(note, note)
            if (hasIndexMarker) db.prepare("INSERT INTO memories_meta (key, value) VALUES ('fts_index_v1', '1')").run()
        } finally {
            db.close()
        }
        writeLegacy('not-imported.md', 'sqlite backup')
        expect(service.search({ queries: ['sqlite'] }).matches.map((hit) => hit.id)).toEqual([1])
        expect(service.search({ queries: ['kelvin'] }).matches.map((hit) => hit.id)).toEqual([2])
        expect(service.search({ queries: ['i\u0307stanbul'] }).matches.map((hit) => hit.id)).toEqual([3])
        expect(service.search({ queries: ['école'] }).matches.map((hit) => hit.id)).toEqual([4])
        expect(inspect((database) => database.prepare("SELECT rowid FROM memories_fts WHERE content MATCH 'sqlite'").all())).toEqual([{ rowid: 1 }])
        expect(inspect((database) => database.prepare('SELECT memory_id FROM memories_unicode_docs ORDER BY memory_id').all()))
            .toEqual([{ memory_id: 2 }, { memory_id: 3 }, { memory_id: 4 }])
        expect(inspect((database) => database.prepare("SELECT value FROM memories_meta WHERE key = 'fts_index_v1'").get())).toEqual({ value: '1' })
        expect(service.read({ ids: [5] }).missingIds).toEqual([5])
        service.close()
        const prepare = vi.spyOn(Database.prototype, 'prepare')
        expect(service.search({ queries: ['sqlite'] }).matches.map((hit) => hit.id)).toEqual([1])
        expect(prepare.mock.calls.some(([sql]) => sql.includes("VALUES('rebuild')"))).toBe(false)
    })

    it('creates initial search triggers only after rebuilding indexes in the same immediate transaction', () => {
        const db = new Database(path.join(memoryRoot, 'memories.db'), { timeout: 0 })
        try {
            db.exec(`
                CREATE TABLE memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
            `)
            const insert = db.prepare('INSERT INTO memories (title, content, created_at, updated_at) VALUES (?, ?, 1, 1)')
            insert.run('ASCII', 'sqlite memory')
            insert.run('Unicode', 'Kelvin')
            const concurrentUpdate = db.prepare('UPDATE memories SET title = title WHERE id = 1')
            const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
            const operations: string[] = []
            let rebuildDb: DatabaseType | undefined
            const originalExec = Database.prototype.exec
            vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: DatabaseType, sql: string) {
                if (/CREATE\s+TRIGGER/i.test(sql)) {
                    expect(this.inTransaction).toBe(true)
                    expect(this).toBe(rebuildDb)
                    expect(() => concurrentUpdate.run()).toThrow(expect.objectContaining({ code: 'SQLITE_BUSY' }))
                    expect(triggers.all()).toEqual([])
                    expect(db.prepare("SELECT rowid FROM memories_fts WHERE content MATCH 'sqlite'").all()).toEqual([])
                    expect(this.prepare("SELECT rowid FROM memories_fts WHERE content MATCH 'sqlite'").all()).toEqual([{ rowid: 1 }])
                    expect(this.prepare('SELECT memory_id FROM memories_unicode_docs ORDER BY memory_id').all())
                        .toEqual([{ memory_id: 1 }, { memory_id: 2 }])
                    operations.push('create triggers')
                }
                return originalExec.call(this, sql)
            })
            const originalPrepare = Database.prototype.prepare
            vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: DatabaseType, sql: string) {
                const statement = originalPrepare.call(this, sql) as Statement
                if (sql === 'DELETE FROM memories_unicode_docs' || sql.includes("VALUES('rebuild')")) {
                    const originalRun = statement.run
                    vi.spyOn(statement, 'run').mockImplementation((...params: unknown[]) => {
                        expect(this.inTransaction).toBe(true)
                        expect(() => concurrentUpdate.run()).toThrow(expect.objectContaining({ code: 'SQLITE_BUSY' }))
                        expect(this.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()).toEqual([])
                        const result = originalRun.apply(statement, params)
                        if (sql.includes("VALUES('rebuild')")) {
                            rebuildDb = this
                            operations.push('rebuild')
                        }
                        return result
                    })
                }
                return statement
            })

            service.getDbPath()
            expect(operations).toEqual(['rebuild', 'create triggers'])
            expect(triggers.all()).toEqual([
                { name: 'trg_memories_fts_ad' },
                { name: 'trg_memories_fts_ai' },
                { name: 'trg_memories_fts_au' },
            ])
            expect(db.prepare("SELECT value FROM memories_meta WHERE key = 'fts_index_v1'").get()).toEqual({ value: '1' })
            expect(service.search({ queries: ['sqlite'] }).matches.map((hit) => hit.id)).toEqual([1])
            expect(service.search({ queries: ['kelvin'] }).matches.map((hit) => hit.id)).toEqual([2])
        } finally {
            db.close()
        }
    })

    it('preserves existing search triggers when reopening an initialized database', () => {
        service.add({ title: 'saved', note: 'sqlite Kelvin' })
        service.close()
        const triggers = inspect((db) => db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all())
        const exec = vi.spyOn(Database.prototype, 'exec')
        const transaction = vi.spyOn(Database.prototype, 'transaction')

        expect(service.search({ queries: ['sqlite'] }).matches.map((hit) => hit.id)).toEqual([1])
        expect(exec.mock.calls.some(([sql]) => /DROP\s+TRIGGER/i.test(sql))).toBe(false)
        expect(exec.mock.calls.some(([sql]) => /CREATE\s+TRIGGER/i.test(sql))).toBe(false)
        expect(transaction).not.toHaveBeenCalled()
        expect(inspect((db) => db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all())).toEqual(triggers)
    })

    it.each([
        ['an invalid index marker', "UPDATE memories_meta SET value = '0' WHERE key = 'fts_index_v1'"],
        ['a missing insert trigger', 'DROP TRIGGER trg_memories_fts_ai'],
        ['a missing delete trigger', 'DROP TRIGGER trg_memories_fts_ad'],
        ['a missing update trigger', 'DROP TRIGGER trg_memories_fts_au'],
    ])('rebuilds search indexes with %s', (_issue, sql) => {
        service.add({ title: 'saved', note: 'sqlite Kelvin' })
        service.close()
        const db = new Database(path.join(memoryRoot, 'memories.db'))
        try {
            db.exec(sql)
        } finally {
            db.close()
        }
        const prepare = vi.spyOn(Database.prototype, 'prepare')
        expect(service.search({ queries: ['sqlite'] }).matches.map((hit) => hit.id)).toEqual([1])
        expect(service.search({ queries: ['kelvin'] }).matches.map((hit) => hit.id)).toEqual([1])
        expect(prepare.mock.calls.some(([statement]) => statement.includes("VALUES('rebuild')"))).toBe(true)
        expect(inspect((database) => database.prepare("SELECT value FROM memories_meta WHERE key = 'fts_index_v1'").get())).toEqual({ value: '1' })
        expect(inspect((database) => database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all())).toEqual([
            { name: 'trg_memories_fts_ad' },
            { name: 'trg_memories_fts_ai' },
            { name: 'trg_memories_fts_au' },
        ])
    })

    it('rebuilds an empty search index after memories were deleted without the delete trigger', () => {
        service.add({ title: 'saved', note: 'sqlite Kelvin' })
        service.close()
        const db = new Database(path.join(memoryRoot, 'memories.db'))
        try {
            db.exec(`
                DROP TRIGGER trg_memories_fts_ad;
                DELETE FROM memories;
            `)
            expect(db.prepare('SELECT id FROM memories').all()).toEqual([])
            expect(db.prepare("SELECT rowid FROM memories_fts WHERE content MATCH 'sqlite'").all()).toEqual([{ rowid: 1 }])

            service = new MemoriesDatabaseService({ memoryRoot })
            expect(service.search({ queries: ['sqlite'] })).toEqual({ matches: [], truncated: false })
            expect(db.prepare("SELECT rowid FROM memories_fts WHERE content MATCH 'sqlite'").all()).toEqual([])
            expect(db.prepare('SELECT * FROM memories_unicode_docs').all()).toEqual([])
            expect(() => db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')").run()).not.toThrow()
            expect(() => db.prepare("INSERT INTO memories_fts(memories_fts, rank) VALUES('integrity-check', 1)").run()).not.toThrow()
        } finally {
            db.close()
        }
    })

    it.each([false, true])('replaces search triggers and rebuilds indexes atomically in an immediate transaction with failure: %s', (failRebuild) => {
        service.add({ title: 'ASCII', note: 'sqlite memory' })
        service.add({ title: 'Unicode', note: 'Kelvin' })
        service.close()
        const db = new Database(path.join(memoryRoot, 'memories.db'), { timeout: 0 })
        try {
            db.exec(`
                DELETE FROM memories_meta WHERE key = 'fts_index_v1';
                DROP TRIGGER trg_memories_fts_ai;
                CREATE TRIGGER trg_memories_fts_ai AFTER INSERT ON memories BEGIN
                    SELECT 1;
                END;
            `)
            const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
            const previousTriggers = triggers.all()
            const concurrentUpdate = db.prepare('UPDATE memories SET title = title WHERE id = 1')
            const operations: string[] = []
            const replacements: string[] = []
            const originalExec = Database.prototype.exec
            vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: DatabaseType, sql: string) {
                if (/DROP\s+TRIGGER/i.test(sql)) {
                    expect(this.inTransaction).toBe(true)
                    expect(() => concurrentUpdate.run()).toThrow(expect.objectContaining({ code: 'SQLITE_BUSY' }))
                    operations.push('replace triggers')
                    replacements.push(sql)
                }
                return originalExec.call(this, sql)
            })
            const originalPrepare = Database.prototype.prepare
            vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: DatabaseType, sql: string) {
                const statement = originalPrepare.call(this, sql) as Statement
                if (sql === 'DELETE FROM memories_unicode_docs'
                    || sql.includes("VALUES('rebuild')")
                    || sql === 'INSERT INTO memories_unicode_docs (memory_id) SELECT id FROM memories'
                    || sql.includes("VALUES ('fts_index_v1', '1')")) {
                    const originalRun = statement.run
                    vi.spyOn(statement, 'run').mockImplementation((...params: unknown[]) => {
                        expect(this.inTransaction).toBe(true)
                        expect(() => concurrentUpdate.run()).toThrow(expect.objectContaining({ code: 'SQLITE_BUSY' }))
                        expect(triggers.all()).toEqual(previousTriggers)
                        expect(this.prepare("SELECT sql FROM sqlite_master WHERE name = 'trg_memories_fts_ai'").get())
                            .toEqual({ sql: expect.stringContaining(sql.includes("VALUES ('fts_index_v1', '1')")
                                ? 'INSERT INTO memories_unicode_docs' : 'SELECT 1;') })
                        operations.push(sql)
                        if (failRebuild && sql.includes("VALUES('rebuild')")) throw new Error('index rebuild failed')
                        return originalRun.apply(statement, params)
                    })
                }
                return statement
            })

            if (failRebuild) {
                expect(() => service.getDbPath()).toThrow('index rebuild failed')
                expect(triggers.all()).toEqual(previousTriggers)
                expect(db.prepare("SELECT value FROM memories_meta WHERE key = 'fts_index_v1'").get()).toBeUndefined()
            } else {
                service.getDbPath()
                expect(triggers.all()).not.toEqual(previousTriggers)
                expect(db.prepare("SELECT value FROM memories_meta WHERE key = 'fts_index_v1'").get()).toEqual({ value: '1' })
            }
            expect(operations).toEqual([
                'DELETE FROM memories_unicode_docs',
                "INSERT INTO memories_fts(memories_fts) VALUES('rebuild')",
                ...(!failRebuild ? [
                    'INSERT INTO memories_unicode_docs (memory_id) SELECT id FROM memories',
                    'replace triggers',
                    "INSERT OR REPLACE INTO memories_meta (key, value) VALUES ('fts_index_v1', '1')",
                ] : []),
            ])
            for (const name of ['trg_memories_fts_ai', 'trg_memories_fts_ad', 'trg_memories_fts_au']) {
                expect(replacements.some((sql) => sql.includes(`DROP TRIGGER IF EXISTS ${name}`))).toBe(!failRebuild)
            }
            expect(db.prepare('SELECT * FROM memories_unicode_docs').all()).toEqual([{ memory_id: 2, has_unicode_case: 1 }])
            expect(db.prepare("SELECT rowid FROM memories_fts WHERE content MATCH 'sqlite'").all()).toEqual([{ rowid: 1 }])
            expect(() => concurrentUpdate.run()).not.toThrow()
        } finally {
            db.close()
        }
    })

    it.each([
        { content: 'Kelvin', query: 'kelvin' },
        { content: 'prefix\0needle', query: 'needle' },
    ])('indexes migrated fallback files after the search index was initialized: $query', ({ content, query }) => {
        service.getDbPath()
        service.close()
        writeLegacy('fallback.md', content)
        const db = new Database(path.join(memoryRoot, 'memories.db'))
        try {
            db.prepare("DELETE FROM memories_meta WHERE key = 'legacy_files_migrated'").run()
        } finally {
            db.close()
        }
        expect(service.search({ queries: [query] }).matches.map((hit) => hit.id)).toEqual([1])
        expect(inspect((database) => database.prepare('SELECT * FROM memories_unicode_docs').all()))
            .toEqual([{ memory_id: 1, has_unicode_case: 1 }])
    })

    it.each([false, true])('upgrades the Unicode fallback schema and rebuilds indexes after an interrupted schema upgrade: %s', (interruptedUpgrade) => {
        service.add({ title: 'ASCII', note: 'abc' })
        service.add({ title: 'Unicode', note: 'abİ' })
        service.add({ title: 'NUL', note: 'prefix\0needle' })
        service.close()
        const db = new Database(path.join(memoryRoot, 'memories.db'))
        try {
            db.exec(`
                DROP TABLE memories_unicode_docs;
                CREATE TABLE memories_unicode_docs (
                    memory_id INTEGER PRIMARY KEY,
                    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
                );
                INSERT INTO memories_unicode_docs (memory_id) VALUES (2);
                DROP TRIGGER trg_memories_fts_ai;
                DROP TRIGGER trg_memories_fts_au;
                CREATE TRIGGER trg_memories_fts_ai AFTER INSERT ON memories BEGIN
                    INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
                END;
                CREATE TRIGGER trg_memories_fts_au AFTER UPDATE OF content ON memories
                WHEN old.content IS NOT new.content BEGIN
                    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
                    INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
                END;
            `)
            if (interruptedUpgrade) {
                db.exec('ALTER TABLE memories_unicode_docs ADD COLUMN has_unicode_case INTEGER NOT NULL DEFAULT -1')
            }
            const previousColumns = db.pragma('table_info(memories_unicode_docs)')
            const previousTriggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()
            const previousUnicodeDocs = db.prepare('SELECT * FROM memories_unicode_docs').all()
            const originalExec = Database.prototype.exec
            vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: DatabaseType, sql: string) {
                if (sql.startsWith('ALTER TABLE memories_unicode_docs')) expect(this.inTransaction).toBe(true)
                return originalExec.call(this, sql)
            })
            const originalPrepare = Database.prototype.prepare
            const failRebuild = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: DatabaseType, sql: string) {
                const statement = originalPrepare.call(this, sql) as Statement
                if (sql.includes("VALUES('rebuild')")) {
                    vi.spyOn(statement, 'run').mockImplementation(() => { throw new Error('index rebuild failed') })
                }
                return statement
            })
            expect(() => service.getDbPath()).toThrow('index rebuild failed')
            expect(db.pragma('table_info(memories_unicode_docs)')).toEqual(previousColumns)
            expect(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()).toEqual(previousTriggers)
            expect(db.prepare('SELECT * FROM memories_unicode_docs').all()).toEqual(previousUnicodeDocs)
            expect(db.prepare("SELECT value FROM memories_meta WHERE key = 'fts_index_v1'").get()).toEqual({ value: '1' })
            failRebuild.mockRestore()

            const prepare = vi.spyOn(Database.prototype, 'prepare')
            service.getDbPath()
            expect(db.prepare(`
                SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger'
                AND name IN ('trg_memories_fts_ai', 'trg_memories_fts_ad', 'trg_memories_fts_au')
                AND sql LIKE '%memories_unicode_docs%'
            `).get()).toEqual({ count: 3 })
            expect(inspect((database) => database.prepare('SELECT * FROM memories_unicode_docs ORDER BY memory_id').all())).toEqual([
                { memory_id: 2, has_unicode_case: 1 },
                { memory_id: 3, has_unicode_case: 1 },
            ])
            expect(prepare.mock.calls.some(([sql]) => sql.includes("VALUES('rebuild')"))).toBe(true)
            db.prepare('UPDATE memories SET content = ? WHERE id = 1').run('abİ')
            db.prepare('INSERT INTO memories (title, content, created_at, updated_at) VALUES (?, ?, 1, 1)').run('raw', 'abİ')
            expect(service.search({ queries: ['abi'] }).matches.map((hit) => hit.id)).toEqual([4, 2, 1])
            expect(service.search({ queries: ['needle'], caseSensitive: true }).matches.map((hit) => hit.id)).toEqual([3])
        } finally {
            db.close()
        }
    })

    it('re-checks the search index when another connection upgrades the schema before the immediate transaction', () => {
        service.add({ title: 'saved', note: 'sqlite Kelvin' })
        service.close()
        const db = new Database(path.join(memoryRoot, 'memories.db'))
        const concurrentService = new MemoriesDatabaseService({ memoryRoot })
        try {
            db.exec(`
                DROP TRIGGER trg_memories_fts_ai;
                DROP TRIGGER trg_memories_fts_ad;
                DROP TRIGGER trg_memories_fts_au;
                DROP TABLE memories_unicode_docs;
                CREATE TABLE memories_unicode_docs (
                    memory_id INTEGER PRIMARY KEY,
                    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
                );
            `)
            const exec = vi.spyOn(Database.prototype, 'exec')
            const prepare = vi.spyOn(Database.prototype, 'prepare')
            const pragma = vi.spyOn(Database.prototype, 'pragma')
            const originalTransaction = Database.prototype.transaction
            vi.spyOn(Database.prototype, 'transaction').mockImplementationOnce(function (this: DatabaseType, fn) {
                const transaction = originalTransaction.call(this, fn)
                expect(this.inTransaction).toBe(false)
                expect(pragma).toHaveBeenCalledWith('table_info(memories_unicode_docs)')
                concurrentService.getDbPath()
                exec.mockClear()
                prepare.mockClear()
                pragma.mockClear()
                return transaction
            })

            expect(() => service.getDbPath()).not.toThrow()
            expect(pragma).toHaveBeenCalledExactlyOnceWith('table_info(memories_unicode_docs)')
            expect(exec.mock.calls.some(([sql]) => sql.startsWith('ALTER TABLE memories_unicode_docs'))).toBe(false)
            expect(prepare.mock.calls.some(([sql]) => sql.includes("VALUES('rebuild')"))).toBe(false)
            expect(db.prepare('SELECT * FROM memories_unicode_docs').all()).toEqual([{ memory_id: 1, has_unicode_case: 1 }])
            expect(service.search({ queries: ['sqlite'] }).matches.map((hit) => hit.id)).toEqual([1])
            expect(service.search({ queries: ['kelvin'] }).matches.map((hit) => hit.id)).toEqual([1])
        } finally {
            concurrentService.close()
            db.close()
        }
    })

    it.each(['any', 'all_on_same_line', 'all_within_lines'] as const)('classifies raw SQL content updates lazily for %s', (matchMode) => {
        service.add({ title: 'target', note: 'abc' })
        const db = new Database(path.join(memoryRoot, 'memories.db'))
        try {
            const update = db.prepare('UPDATE memories SET content = ? WHERE id = 1')
            const fallbackRows = db.prepare('SELECT * FROM memories_unicode_docs')
            expect(fallbackRows.all()).toEqual([])
            update.run('abİ')
            expect(fallbackRows.all()).toEqual([{ memory_id: 1, has_unicode_case: -1 }])
            expect(service.search({ queries: ['abi'], matchMode, lineCount: 2 }).matches)
                .toEqual([{ id: 1, title: 'target', matchedQueries: ['abi'], snippet: 'abİ' }])
            expect(fallbackRows.all()).toEqual([{ memory_id: 1, has_unicode_case: 1 }])
            update.run('abİ')
            expect(fallbackRows.all()).toEqual([{ memory_id: 1, has_unicode_case: 1 }])
            update.run('abi')
            expect(fallbackRows.all()).toEqual([{ memory_id: 1, has_unicode_case: -1 }])
            expect(service.search({ queries: ['abi'], matchMode, lineCount: 2 }).matches)
                .toEqual([{ id: 1, title: 'target', matchedQueries: ['abi'], snippet: 'abi' }])
            expect(fallbackRows.all()).toEqual([])
            update.run('abc')
            expect(service.search({ queries: ['abi'], matchMode, lineCount: 2 }).matches).toEqual([])
            expect(fallbackRows.all()).toEqual([])
        } finally {
            db.close()
        }
    })

    it('reads and classifies pending Unicode rows in a single immediate transaction', () => {
        const db = new Database(service.getDbPath(), { timeout: 0 })
        try {
            const insert = db.prepare('INSERT INTO memories (title, content, created_at, updated_at) VALUES (?, ?, 1, 1)')
            insert.run('ASCII', 'abc')
            insert.run('Unicode', 'abİ')
            const concurrentUpdate = db.prepare('UPDATE memories SET content = ? WHERE id = 1')
            const operations: string[] = []
            const transaction = vi.spyOn(Database.prototype, 'transaction')
            const originalPrepare = Database.prototype.prepare
            vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: DatabaseType, sql: string) {
                const statement = originalPrepare.call(this, sql) as Statement
                if (sql.includes('SELECT m.id, m.content FROM memories_unicode_docs u')) {
                    const originalAll = statement.all
                    vi.spyOn(statement, 'all').mockImplementation((...params: unknown[]) => {
                        expect(this.inTransaction).toBe(true)
                        expect(() => concurrentUpdate.run('abİ')).toThrow(expect.objectContaining({ code: 'SQLITE_BUSY' }))
                        operations.push('read')
                        return originalAll.apply(statement, params)
                    })
                } else if (sql.startsWith('UPDATE memories_unicode_docs ') || sql.startsWith('DELETE FROM memories_unicode_docs ')) {
                    const originalRun = statement.run
                    vi.spyOn(statement, 'run').mockImplementation((...params: unknown[]) => {
                        expect(this.inTransaction).toBe(true)
                        operations.push(sql.startsWith('UPDATE') ? 'update' : 'delete')
                        return originalRun.apply(statement, params)
                    })
                }
                return statement
            })
            expect(service.search({ queries: ['abi'] }).matches.map((hit) => hit.id)).toEqual([2])
            expect(transaction).toHaveBeenCalledTimes(1)
            expect(operations[0]).toBe('read')
            expect(operations.slice(1).sort()).toEqual(['delete', 'update'])
            expect(db.prepare('SELECT * FROM memories_unicode_docs').all()).toEqual([
                { memory_id: 2, has_unicode_case: 1 },
            ])
        } finally {
            db.close()
        }
    })

    it('skips the Unicode classification transaction when no rows are pending', () => {
        service.add({ title: 'Unicode', note: 'abİ' })
        const transaction = vi.spyOn(Database.prototype, 'transaction')
        expect(service.search({ queries: ['abi'] }).matches.map((hit) => hit.id)).toEqual([1])
        expect(transaction).not.toHaveBeenCalled()
    })

    it('classifies raw SQL inserts on search and pending updates on add', () => {
        const db = new Database(service.getDbPath())
        try {
            const insert = db.prepare('INSERT INTO memories (title, content, created_at, updated_at) VALUES (?, ?, 1, 1)')
            insert.run('ASCII', 'abc')
            insert.run('Unicode', 'abİ')
            insert.run('NUL', 'prefix\0needle')
            const fallbackRows = db.prepare('SELECT * FROM memories_unicode_docs ORDER BY memory_id')
            expect(fallbackRows.all()).toEqual([
                { memory_id: 1, has_unicode_case: -1 },
                { memory_id: 2, has_unicode_case: -1 },
                { memory_id: 3, has_unicode_case: -1 },
            ])
            expect(service.search({ queries: ['abi'] }).matches.map((hit) => hit.id)).toEqual([2])
            expect(fallbackRows.all()).toEqual([
                { memory_id: 2, has_unicode_case: 1 },
                { memory_id: 3, has_unicode_case: 1 },
            ])
            expect(service.search({ queries: ['needle'], caseSensitive: true }).matches.map((hit) => hit.id)).toEqual([3])
            db.prepare('UPDATE memories SET content = ? WHERE id = 2').run('abc')
            service.add({ title: 'new', note: 'abc' })
            expect(fallbackRows.all()).toEqual([{ memory_id: 3, has_unicode_case: 1 }])
            expect(service.search({ queries: ['abi'] }).matches).toEqual([])
            db.prepare('DELETE FROM memories WHERE id = 3').run()
            expect(fallbackRows.all()).toEqual([])
        } finally {
            db.close()
        }
    })

    it('keeps FTS synchronized through content updates, unchanged updates and deletes', () => {
        service.add({ title: 'target', note: 'sqlite memory' })
        const db = new Database(path.join(memoryRoot, 'memories.db'))
        try {
            db.prepare('UPDATE memories SET content = ? WHERE id = 1').run('transactions memory')
            db.prepare('UPDATE memories SET content = content WHERE id = 1').run()
            expect(service.search({ queries: ['sqlite'] }).matches).toEqual([])
            expect(service.search({ queries: ['transactions'] }).matches.map((hit) => hit.id)).toEqual([1])
            db.prepare('DELETE FROM memories WHERE id = 1').run()
            expect(service.search({ queries: ['transactions'] }).matches).toEqual([])
        } finally {
            db.close()
        }
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
        service.add({ title: 'new', note: 'sqlite Kelvin' })
        const exec = vi.spyOn(Database.prototype, 'exec')
        expect(inspect((db) => db.pragma('journal_mode', { simple: true }))).toBe('wal')
        expect(() => service.clear()).not.toThrow()
        expect(exec).toHaveBeenCalledWith('VACUUM')
        expect(inspect((db) => db.prepare('SELECT * FROM memories').all())).toEqual([])
        expect(inspect((db) => db.prepare('SELECT memory_id FROM memories_unicode_docs').all())).toEqual([])
        expect(inspect((db) => db.prepare("SELECT rowid FROM memories_fts WHERE content MATCH 'sqlite'").all())).toEqual([])
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
