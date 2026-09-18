import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import Module, { createRequire } from 'node:module'
import {
    resolveMainEntry,
    resolveMainScriptToExecute,
    addFallbackModulePaths,
    ensureNativeModuleBridges,
    getBaseBinaryVersion,
} from '../../src/main/bootstrapper.js'
import { UpdateStateStorage } from '../../src/main/services/update/updateStateStorage.js'

describe('bootstrapper', () => {
    let tempDir: string
    let storage: UpdateStateStorage
    const defaultPath = '/app/dist-electron/src/main/index.js'

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-bootstrapper-test-'))
        storage = new UpdateStateStorage({ runtimeDir: tempDir, baseVersion: '1.0.0' })
    })

    afterEach(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true })
        } catch {}
    })

    it('returns baseDefaultMainPath when running in unpackaged/dev mode', () => {
        const entry = resolveMainEntry(defaultPath, { isPackaged: false, storage })
        expect(entry).toBe(defaultPath)
    })

    it('returns baseDefaultMainPath immediately when CPA_HOT_PATCH_ACTIVE is set', () => {
        process.env.CPA_HOT_PATCH_ACTIVE = '1'
        try {
            const entry = resolveMainEntry(defaultPath, { isPackaged: true, storage })
            expect(entry).toBe(defaultPath)
        } finally {
            delete process.env.CPA_HOT_PATCH_ACTIVE
        }
    })

    it('resolves base binary version from resourcesPath package.json', () => {
        const mockResources = path.join(tempDir, 'mock-resources-ver')
        const asarDir = path.join(mockResources, 'app.asar')
        fs.mkdirSync(asarDir, { recursive: true })
        fs.writeFileSync(path.join(asarDir, 'package.json'), JSON.stringify({ version: '1.0.0' }), 'utf8')

        const resolved = getBaseBinaryVersion(mockResources)
        expect(resolved).toBe('1.0.0')
    })

    it('returns baseDefaultMainPath when packaged but no active asar is configured', () => {
        const entry = resolveMainEntry(defaultPath, { isPackaged: true, storage })
        expect(entry).toBe(defaultPath)
    })

    it('resolves main script from active asar and increments failure count when asar exists', () => {
        const versionsDir = path.join(tempDir, 'versions', '1.1.0')
        fs.mkdirSync(versionsDir, { recursive: true })
        const asarFile = path.join(versionsDir, 'app.asar')
        fs.writeFileSync(asarFile, 'dummy asar content')

        storage.recordPendingVersion('1.1.0', 'versions/1.1.0/app.asar')
        storage.activatePendingVersion()

        expect(storage.loadState().consecutiveFailures).toBe(0)

        const entry = resolveMainEntry(defaultPath, { isPackaged: true, storage })
        const expected = path.join(asarFile, 'dist-electron', 'src', 'main', 'index.js')
        expect(entry).toBe(expected)
        expect(storage.loadState().consecutiveFailures).toBe(1)

        // Calling from the active target entry itself should NOT increment failures again
        const reEntry = resolveMainEntry(expected, { isPackaged: true, storage })
        expect(reEntry).toBe(expected)
        expect(storage.loadState().consecutiveFailures).toBe(1)

        // Calling with file:// URL format should resolve properly
        const urlEntry = resolveMainEntry(pathToFileURL(defaultPath).href, { isPackaged: true, storage })
        expect(urlEntry).toBe(expected)
    })

    it('falls back to default path if active asar file does not exist on disk', () => {
        storage.recordPendingVersion('1.1.0', 'versions/1.1.0/missing.asar')
        storage.activatePendingVersion()

        const entry = resolveMainEntry(defaultPath, { isPackaged: true, storage })
        expect(entry).toBe(defaultPath)
        expect(storage.loadState().consecutiveFailures).toBe(0)
    })

    it('automatically rolls back to base version when consecutive failures threshold is reached', () => {
        const versionsDir = path.join(tempDir, 'versions', '1.1.0')
        fs.mkdirSync(versionsDir, { recursive: true })
        const asarFile = path.join(versionsDir, 'app.asar')
        fs.writeFileSync(asarFile, 'dummy asar content')

        storage.recordPendingVersion('1.1.0', 'versions/1.1.0/app.asar')
        storage.activatePendingVersion()

        // Simulate 2 previous crashes
        storage.incrementFailure()
        storage.incrementFailure()
        expect(storage.shouldRollback()).toBe(true)

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const entry = resolveMainEntry(defaultPath, { isPackaged: true, storage })

        expect(entry).toBe(defaultPath)
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Consecutive startup failures detected'))
        expect(storage.loadState().activeVersion).toBe('1.0.0')
        expect(storage.loadState().activeAsarPath).toBeNull()
        expect(storage.loadState().consecutiveFailures).toBe(0)
        warnSpy.mockRestore()
    })

    it('exports resolveMainScriptToExecute as an alias of resolveMainEntry', () => {
        expect(resolveMainScriptToExecute).toBe(resolveMainEntry)
    })

    it('configures fallback module lookup paths for base app resources when packaged', () => {
        const mockResources = path.join(tempDir, 'mock-resources')
        resolveMainEntry(defaultPath, { isPackaged: true, storage, resourcesPath: mockResources })

        const expectedAsarModules = path.join(mockResources, 'app.asar', 'node_modules')
        const expectedUnpackedModules = path.join(mockResources, 'app.asar.unpacked', 'node_modules')

        const globalPaths = (Module as any).globalPaths || []
        expect(globalPaths).toContain(expectedAsarModules)
        expect(globalPaths).toContain(expectedUnpackedModules)

        const envPaths = (process.env.NODE_PATH || '').split(path.delimiter)
        expect(envPaths).toContain(expectedAsarModules)
        expect(envPaths).toContain(expectedUnpackedModules)
    })

    it('adds custom paths via addFallbackModulePaths', () => {
        const customPath = path.join(tempDir, 'custom-node-modules')
        addFallbackModulePaths([customPath])

        const globalPaths = (Module as any).globalPaths || []
        expect(globalPaths).toContain(customPath)

        const envPaths = (process.env.NODE_PATH || '').split(path.delimiter)
        expect(envPaths).toContain(customPath)
    })

    it('creates ESM bridge files for native modules in <runtimeDir>/node_modules/<module_name>', () => {
        const mockResources = path.join(tempDir, 'mock-resources')
        const unpackedPty = path.join(mockResources, 'app.asar.unpacked', 'node_modules', 'node-pty')
        fs.mkdirSync(unpackedPty, { recursive: true })
        fs.writeFileSync(
            path.join(unpackedPty, 'package.json'),
            JSON.stringify({ name: 'node-pty', main: './lib/index.js' }),
            'utf8',
        )
        fs.mkdirSync(path.join(unpackedPty, 'lib'), { recursive: true })
        fs.writeFileSync(
            path.join(unpackedPty, 'lib', 'index.js'),
            'module.exports = { spawn: () => {} };',
            'utf8',
        )

        const unpackedSqlite = path.join(mockResources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3')
        fs.mkdirSync(unpackedSqlite, { recursive: true })
        fs.writeFileSync(
            path.join(unpackedSqlite, 'index.cjs'),
            'module.exports = function Database() {}; module.exports.SqliteError = class SqliteError {};',
            'utf8',
        )

        const bridged = ensureNativeModuleBridges(tempDir, mockResources)
        expect(bridged).toContain('node-pty')
        expect(bridged).toContain('better-sqlite3')

        // Verify bridge package.json and index.js
        const ptyBridgeDir = path.join(tempDir, 'node_modules', 'node-pty')
        expect(fs.existsSync(path.join(ptyBridgeDir, 'package.json'))).toBe(true)
        expect(fs.existsSync(path.join(ptyBridgeDir, 'index.js'))).toBe(true)
        const ptyBridgePkg = JSON.parse(fs.readFileSync(path.join(ptyBridgeDir, 'package.json'), 'utf8'))
        expect(ptyBridgePkg.type).toBe('module')

        const ptyBridgeJs = fs.readFileSync(path.join(ptyBridgeDir, 'index.js'), 'utf8')
        expect(ptyBridgeJs).toContain('import m from "file://')
        expect(ptyBridgeJs).toContain('export default m;')
        expect(ptyBridgeJs).toContain('export * from "file://')

        const sqliteBridgeDir = path.join(tempDir, 'node_modules', 'better-sqlite3')
        expect(fs.existsSync(path.join(sqliteBridgeDir, 'package.json'))).toBe(true)
        expect(fs.existsSync(path.join(sqliteBridgeDir, 'index.js'))).toBe(true)
    })

    it('allows ESM imports of native modules from dynamic paths via bridge', async () => {
        const mockResources = path.join(tempDir, 'mock-resources')
        const unpackedMod = path.join(mockResources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3')
        fs.mkdirSync(unpackedMod, { recursive: true })
        fs.writeFileSync(
            path.join(unpackedMod, 'package.json'),
            JSON.stringify({ name: 'better-sqlite3', main: './index.cjs' }),
            'utf8',
        )
        fs.writeFileSync(
            path.join(unpackedMod, 'index.cjs'),
            'module.exports = function MockDatabase(file) { return { file, open: true }; }; module.exports.SqliteError = class SqliteError extends Error {};',
            'utf8',
        )

        ensureNativeModuleBridges(tempDir, mockResources)

        const bridgeIndexJs = path.join(tempDir, 'node_modules', 'better-sqlite3', 'index.js')
        expect(fs.existsSync(bridgeIndexJs)).toBe(true)

        // 1. Test direct dynamic ESM import
        const imported = await import(pathToFileURL(bridgeIndexJs).href)
        expect(imported.default).toBeDefined()
        expect(typeof imported.default).toBe('function')
        const dbInstance = imported.default('memory.db')
        expect(dbInstance.file).toBe('memory.db')
        expect(imported.SqliteError).toBeDefined()

        // 2. Test directory tree walking from a nested dynamic path (simulating app.asar)
        const callerDir = path.join(tempDir, 'versions', '1.1.0', 'app.asar', 'dist', 'main')
        fs.mkdirSync(callerDir, { recursive: true })
        const callerScript = path.join(callerDir, 'test-import.mjs')
        fs.writeFileSync(
            callerScript,
            `
import Database, { SqliteError } from 'better-sqlite3';
const db = Database('nested-test.db');
if (db.file !== 'nested-test.db') process.exit(1);
if (typeof SqliteError !== 'function') process.exit(2);
console.log('ESM_BRIDGE_WALK_SUCCESS');
`,
            'utf8',
        )

        const result = execSync('node test-import.mjs', { cwd: callerDir, encoding: 'utf8' })
        expect(result.trim()).toBe('ESM_BRIDGE_WALK_SUCCESS')
    })

    it('automatically ensures native module bridges when resolveMainEntry resolves an active patched asar', () => {
        const mockResources = path.join(tempDir, 'mock-resources')
        const unpackedMod = path.join(mockResources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3')
        fs.mkdirSync(unpackedMod, { recursive: true })
        fs.writeFileSync(
            path.join(unpackedMod, 'package.json'),
            JSON.stringify({ name: 'better-sqlite3', main: './index.cjs' }),
            'utf8',
        )
        fs.writeFileSync(path.join(unpackedMod, 'index.cjs'), 'module.exports = {};', 'utf8')

        const versionsDir = path.join(tempDir, 'versions', '1.1.0')
        fs.mkdirSync(versionsDir, { recursive: true })
        const asarFile = path.join(versionsDir, 'app.asar')
        fs.writeFileSync(asarFile, 'dummy asar content')

        storage.recordPendingVersion('1.1.0', 'versions/1.1.0/app.asar')
        storage.activatePendingVersion()

        resolveMainEntry(defaultPath, { isPackaged: true, storage, resourcesPath: mockResources })

        const bridgeIndexJs = path.join(tempDir, 'node_modules', 'better-sqlite3', 'index.js')
        expect(fs.existsSync(bridgeIndexJs)).toBe(true)
    })

    it('prefers asar JS entry over unpacked JS so sibling CJS deps like bindings resolve', () => {
        const mockResources = path.join(tempDir, 'mock-resources')
        const asarSqlite = path.join(mockResources, 'app.asar', 'node_modules', 'better-sqlite3')
        const unpackedSqlite = path.join(mockResources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3')

        fs.mkdirSync(path.join(asarSqlite, 'lib'), { recursive: true })
        fs.writeFileSync(
            path.join(asarSqlite, 'package.json'),
            JSON.stringify({ name: 'better-sqlite3', main: './lib/index.js' }),
            'utf8',
        )
        fs.writeFileSync(
            path.join(asarSqlite, 'lib', 'index.js'),
            'module.exports = function AsarDatabase() {};',
            'utf8',
        )

        fs.mkdirSync(path.join(unpackedSqlite, 'lib'), { recursive: true })
        fs.writeFileSync(
            path.join(unpackedSqlite, 'package.json'),
            JSON.stringify({ name: 'better-sqlite3', main: './lib/index.js' }),
            'utf8',
        )
        fs.writeFileSync(
            path.join(unpackedSqlite, 'lib', 'index.js'),
            'module.exports = function UnpackedDatabase() {};',
            'utf8',
        )

        const bridged = ensureNativeModuleBridges(tempDir, mockResources)
        expect(bridged).toContain('better-sqlite3')

        const bridgeJs = fs.readFileSync(path.join(tempDir, 'node_modules', 'better-sqlite3', 'index.js'), 'utf8')
        const asarUrl = pathToFileURL(path.join(asarSqlite, 'lib', 'index.js')).href
        const unpackedUrl = pathToFileURL(path.join(unpackedSqlite, 'lib', 'index.js')).href
        expect(bridgeJs).toContain(asarUrl)
        expect(bridgeJs).not.toContain(unpackedUrl)
    })

    it('resolves CJS require of companion deps from unpacked native modules via fallback module paths', () => {
        const companionName = 'cpa-test-native-companion'
        const asarModules = path.join(tempDir, 'app.asar', 'node_modules')
        const unpackedLib = path.join(tempDir, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'lib')

        fs.mkdirSync(path.join(asarModules, companionName), { recursive: true })
        fs.writeFileSync(
            path.join(asarModules, companionName, 'package.json'),
            JSON.stringify({ name: companionName, main: './index.js' }),
            'utf8',
        )
        fs.writeFileSync(
            path.join(asarModules, companionName, 'index.js'),
            'module.exports = function companion() { return { fromAsar: true }; };',
            'utf8',
        )

        fs.mkdirSync(unpackedLib, { recursive: true })
        const databaseJs = path.join(unpackedLib, 'database.js')
        fs.writeFileSync(
            databaseJs,
            `'use strict';
const companion = require(${JSON.stringify(companionName)});
module.exports = function Database() { return { addon: companion() }; };
`,
            'utf8',
        )

        const reqBefore = createRequire(databaseJs)
        expect(() => reqBefore(companionName)).toThrow(/Cannot find module/)

        addFallbackModulePaths([asarModules])

        // Simulate Electron ignoring NODE_PATH / globalPaths for unpacked CJS.
        const savedNodePath = process.env.NODE_PATH
        try {
            delete process.env.NODE_PATH
            ;(Module as any)._initPaths?.()

            const reqAfter = createRequire(databaseJs)
            const Database = reqAfter(databaseJs)
            const instance = Database()
            expect(instance.addon).toEqual({ fromAsar: true })
        } finally {
            if (savedNodePath === undefined) {
                delete process.env.NODE_PATH
            } else {
                process.env.NODE_PATH = savedNodePath
            }
            ;(Module as any)._initPaths?.()
        }
    })
})
