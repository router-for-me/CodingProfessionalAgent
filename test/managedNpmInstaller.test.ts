import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
    ManagedNpmInstaller,
    parseNpmSpec,
    escapePackageName,
    type ManagedNpmPackage,
} from '../src/main/plugins/packages/ManagedNpmInstaller.js'
import {
    PluginPackageLock,
    type PluginPackageLockFile,
} from '../src/main/plugins/packages/PluginPackageLock.js'
import { NpmPluginSource } from '../src/main/plugins/sources/NpmPluginSource.js'
import { createPluginCatalog } from '../src/main/plugins/catalog/createPluginCatalog.js'
import { DuplicatePluginSourceError, PluginError } from '@cpa/plugin-api'

describe('ManagedNpmInstaller & PluginPackageLock & NpmPluginSource', () => {
    let tempRoot: string
    let pluginsDir: string
    let lockfilePath: string

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-npm-test-'))
        pluginsDir = path.join(tempRoot, 'plugins')
        lockfilePath = path.join(pluginsDir, 'plugin-lock.json')
        await fs.mkdir(pluginsDir, { recursive: true })
    })

    afterEach(async () => {
        try {
            await fs.rm(tempRoot, { recursive: true, force: true })
        } catch {
            // Ignore cleanup errors
        }
    })

    describe('ManagedNpmInstaller', () => {
        it('pins the resolved version and integrity without running scripts', async () => {
            const fixtureManifest = {
                name: '@example/cpa-plugin',
                version: '1.2.3',
                _integrity: 'sha512-fixtureIntegrityHash1234567890==',
                dist: {
                    integrity: 'sha512-fixtureIntegrityHash1234567890==',
                },
            }

            const extractSpy = vi.fn(async (spec: string, dest: string, opts?: any) => {
                await fs.mkdir(dest, { recursive: true })
                await fs.writeFile(
                    path.join(dest, 'package.json'),
                    JSON.stringify({
                        name: '@example/cpa-plugin',
                        version: '1.2.3',
                        cpa: {
                            id: 'example-plugin',
                            apiVersion: '1.0.0',
                            engines: { cpa: '^1.0.0' },
                            entries: { main: './index.js' },
                        },
                    }),
                    'utf-8',
                )
                await fs.writeFile(
                    path.join(dest, 'index.js'),
                    'export default {};',
                    'utf-8',
                )
            })

            const installer = new ManagedNpmInstaller({
                pluginsDir,
                fetchManifest: async () => fixtureManifest,
                extractPackage: extractSpy,
            })

            const installed = await installer.install('npm:@example/cpa-plugin@^1.2.0')
            expect(installed.name).toBe('@example/cpa-plugin')
            expect(installed.version).toBe('1.2.3')
            expect(installed.integrity).toBe('sha512-fixtureIntegrityHash1234567890==')
            expect(installed.packageRoot).toBe(
                path.join(pluginsDir, 'npm', '@example+cpa-plugin', '1.2.3'),
            )
            expect(extractSpy).toHaveBeenCalledWith(
                '@example/cpa-plugin@1.2.3',
                expect.stringContaining('.tmp-'),
                expect.objectContaining({ runScripts: false }),
            )

            // Verify lockfile was written
            const lock = new PluginPackageLock(lockfilePath)
            const lockContent = await lock.load()
            expect(lockContent.version).toBe(1)
            expect(lockContent.packages['npm:@example/cpa-plugin@^1.2.0']).toEqual(
                expect.objectContaining({
                    requested: 'npm:@example/cpa-plugin@^1.2.0',
                    resolvedVersion: '1.2.3',
                    integrity: 'sha512-fixtureIntegrityHash1234567890==',
                    packageRoot: path.join(pluginsDir, 'npm', '@example+cpa-plugin', '1.2.3'),
                    contentDigest: expect.any(String),
                }),
            )
        })

        it('handles unscoped package names and escapes scoped packages cleanly', async () => {
            const fixtureManifest = {
                name: 'simple-plugin',
                version: '2.0.0',
                dist: { integrity: 'sha512-simpleIntegrity==' },
            }
            const extractSpy = vi.fn(async (_s: string, dest: string) => {
                await fs.mkdir(dest, { recursive: true })
                await fs.writeFile(
                    path.join(dest, 'package.json'),
                    JSON.stringify({ name: 'simple-plugin', version: '2.0.0' }),
                    'utf-8',
                )
            })

            const installer = new ManagedNpmInstaller({
                pluginsDir,
                fetchManifest: async () => fixtureManifest,
                extractPackage: extractSpy,
            })

            const installed = await installer.install('npm:simple-plugin@^2.0.0')
            expect(installed.name).toBe('simple-plugin')
            expect(installed.packageRoot).toBe(
                path.join(pluginsDir, 'npm', 'simple-plugin', '2.0.0'),
            )
        })

        it('uses cache without network access when directory exists and locked integrity matches', async () => {
            const targetDir = path.join(pluginsDir, 'npm', 'cached-plugin', '1.0.0')
            await fs.mkdir(targetDir, { recursive: true })
            await fs.writeFile(
                path.join(targetDir, 'package.json'),
                JSON.stringify({ name: 'cached-plugin', version: '1.0.0' }),
                'utf-8',
            )

            const lock = new PluginPackageLock(lockfilePath)
            await lock.save({
                version: 1,
                packages: {
                    'npm:cached-plugin@1.0.0': {
                        requested: 'npm:cached-plugin@1.0.0',
                        resolvedVersion: '1.0.0',
                        integrity: 'sha512-validIntegrity==',
                        packageRoot: targetDir,
                    },
                },
            })

            const fetchSpy = vi.fn()
            const extractSpy = vi.fn()

            const installer = new ManagedNpmInstaller({
                pluginsDir,
                fetchManifest: fetchSpy,
                extractPackage: extractSpy,
            })

            const installed = await installer.install('npm:cached-plugin@1.0.0')
            expect(installed.name).toBe('cached-plugin')
            expect(installed.version).toBe('1.0.0')
            expect(installed.integrity).toBe('sha512-validIntegrity==')
            expect(installed.packageRoot).toBe(targetDir)
            expect(fetchSpy).not.toHaveBeenCalled()
            expect(extractSpy).not.toHaveBeenCalled()
        })

        it('offline mode succeeds when cached package matches locked integrity', async () => {
            const targetDir = path.join(pluginsDir, 'npm', 'offline-plugin', '1.0.0')
            await fs.mkdir(targetDir, { recursive: true })
            await fs.writeFile(
                path.join(targetDir, 'package.json'),
                JSON.stringify({ name: 'offline-plugin', version: '1.0.0' }),
                'utf-8',
            )

            const lock = new PluginPackageLock(lockfilePath)
            await lock.save({
                version: 1,
                packages: {
                    'npm:offline-plugin@^1.0.0': {
                        requested: 'npm:offline-plugin@^1.0.0',
                        resolvedVersion: '1.0.0',
                        integrity: 'sha512-offlineIntegrity==',
                        packageRoot: targetDir,
                    },
                },
            })

            const installer = new ManagedNpmInstaller({
                pluginsDir,
                offline: true,
                fetchManifest: vi.fn(),
                extractPackage: vi.fn(),
            })

            const installed = await installer.install('npm:offline-plugin@^1.0.0')
            expect(installed.name).toBe('offline-plugin')
            expect(installed.version).toBe('1.0.0')
            expect(installed.integrity).toBe('sha512-offlineIntegrity==')
        })

        it('offline mode fails with descriptive error when cache or lock is missing', async () => {
            const installer = new ManagedNpmInstaller({
                pluginsDir,
                offline: true,
            })

            await expect(installer.install('npm:missing-plugin@1.0.0')).rejects.toThrow(
                /offline|not found/i,
            )
        })

        it('offline mode fails when cached directory does not exist on disk', async () => {
            const lock = new PluginPackageLock(lockfilePath)
            await lock.save({
                version: 1,
                packages: {
                    'npm:ghost-plugin@1.0.0': {
                        requested: 'npm:ghost-plugin@1.0.0',
                        resolvedVersion: '1.0.0',
                        integrity: 'sha512-ghostIntegrity==',
                        packageRoot: path.join(pluginsDir, 'npm', 'ghost-plugin', '1.0.0'),
                    },
                },
            })

            const installer = new ManagedNpmInstaller({
                pluginsDir,
                offline: true,
            })

            await expect(installer.install('npm:ghost-plugin@1.0.0')).rejects.toThrow(
                /offline|not found/i,
            )
        })

        it('cleans up extraction directory and throws if extract fails', async () => {
            const installer = new ManagedNpmInstaller({
                pluginsDir,
                fetchManifest: async () => ({
                    name: 'fail-extract',
                    version: '1.0.0',
                    dist: { integrity: 'sha512-fail==' },
                }),
                extractPackage: async (_s, dest) => {
                    await fs.mkdir(dest, { recursive: true })
                    await fs.writeFile(path.join(dest, 'partial.txt'), 'partial')
                    throw new Error('Disk full')
                },
            })

            await expect(installer.install('npm:fail-extract@1.0.0')).rejects.toThrow('Disk full')
            const exists = await fs
                .access(path.join(pluginsDir, 'npm', 'fail-extract', '1.0.0'))
                .then(() => true)
                .catch(() => false)
            expect(exists).toBe(false)
        })

        it('throws when manifest fetching fails', async () => {
            const installer = new ManagedNpmInstaller({
                pluginsDir,
                fetchManifest: async () => {
                    throw new Error('E404 Not Found')
                },
            })

            await expect(installer.install('npm:nonexistent-pkg@1.0.0')).rejects.toThrow(
                /failed to fetch manifest.*E404 Not Found/i,
            )
        })

        it('automatically resolves latest version when no version is specified in package spec', async () => {
            const extractSpy = vi.fn(async (_s: string, dest: string) => {
                await fs.mkdir(dest, { recursive: true })
                await fs.writeFile(
                    path.join(dest, 'package.json'),
                    JSON.stringify({ name: 'cpa-codex-computer-use', version: '2.1.0' }),
                    'utf-8',
                )
            })

            const fetchManifestSpy = vi.fn(async (spec: string) => {
                expect(spec).toBe('cpa-codex-computer-use@latest')
                return {
                    name: 'cpa-codex-computer-use',
                    version: '2.1.0',
                    dist: { integrity: 'sha512-autoLatestIntegrity==' },
                }
            })

            const installer = new ManagedNpmInstaller({
                pluginsDir,
                fetchManifest: fetchManifestSpy,
                extractPackage: extractSpy,
            })

            // Spec without '@' version
            const installed = await installer.install('cpa-codex-computer-use')
            expect(installed.name).toBe('cpa-codex-computer-use')
            expect(installed.version).toBe('2.1.0')
            expect(installed.packageRoot).toBe(
                path.join(pluginsDir, 'npm', 'cpa-codex-computer-use', '2.1.0'),
            )
            expect(fetchManifestSpy).toHaveBeenCalledTimes(1)
            expect(extractSpy).toHaveBeenCalledWith(
                'cpa-codex-computer-use@2.1.0',
                expect.stringContaining('.tmp-'),
                expect.objectContaining({ runScripts: false }),
            )

            // Verify lockfile contains both requested spec and exact spec
            const lock = new PluginPackageLock(lockfilePath)
            const lockContent = await lock.load()
            expect(lockContent.packages['cpa-codex-computer-use']?.resolvedVersion).toBe('2.1.0')
            expect(
                lockContent.packages['npm:cpa-codex-computer-use@2.1.0']?.resolvedVersion,
            ).toBe('2.1.0')
        })

        it('automatically queries latest version on subsequent install when new version is published', async () => {
            let currentVersion = '1.0.0'
            const extractSpy = vi.fn(async (spec: string, dest: string) => {
                const version = spec.split('@')[1]
                await fs.mkdir(dest, { recursive: true })
                await fs.writeFile(
                    path.join(dest, 'package.json'),
                    JSON.stringify({ name: 'cpa-codex-computer-use', version }),
                    'utf-8',
                )
            })

            const installer = new ManagedNpmInstaller({
                pluginsDir,
                fetchManifest: async () => ({
                    name: 'cpa-codex-computer-use',
                    version: currentVersion,
                    dist: { integrity: `sha512-integrity-${currentVersion}==` },
                }),
                extractPackage: extractSpy,
            })

            // 1st install: version 1.0.0
            const first = await installer.install('cpa-codex-computer-use')
            expect(first.version).toBe('1.0.0')

            // 2nd install: remote releases 1.0.1
            currentVersion = '1.0.1'
            const second = await installer.install('cpa-codex-computer-use')
            expect(second.version).toBe('1.0.1')
            expect(second.packageRoot).toBe(
                path.join(pluginsDir, 'npm', 'cpa-codex-computer-use', '1.0.1'),
            )
        })
    })

    describe('Helper Utilities', () => {
        it('parseNpmSpec correctly parses various spec formats', () => {
            const spec1 = parseNpmSpec('npm:@scope/package@^1.2.0')
            expect(spec1.name).toBe('@scope/package')
            expect(spec1.range).toBe('^1.2.0')
            expect(spec1.pacoteSpec).toBe('@scope/package@^1.2.0')
            expect(spec1.normalizedSpec).toBe('npm:@scope/package@^1.2.0')

            const spec2 = parseNpmSpec('npm:@scope/package')
            expect(spec2.name).toBe('@scope/package')
            expect(spec2.range).toBe('latest')
            expect(spec2.pacoteSpec).toBe('@scope/package@latest')
            expect(spec2.normalizedSpec).toBe('npm:@scope/package')

            const spec3 = parseNpmSpec('npm:my-pkg@~2.1.0')
            expect(spec3.name).toBe('my-pkg')
            expect(spec3.range).toBe('~2.1.0')
            expect(spec3.pacoteSpec).toBe('my-pkg@~2.1.0')

            const spec4 = parseNpmSpec('my-unscoped-pkg')
            expect(spec4.name).toBe('my-unscoped-pkg')
            expect(spec4.range).toBe('latest')

            expect(() => parseNpmSpec('npm:@invalid')).toThrow(/invalid npm package/i)
            expect(() => parseNpmSpec('')).toThrow(/invalid npm package/i)
        })

        it('rejects non-exact semver in strict mode', () => {
            expect(() =>
                parseNpmSpec('npm:@scope/pkg@^1.0.0', { strictExact: true }),
            ).toThrow(/only exact semver is allowed in strict mode/i)

            expect(() =>
                parseNpmSpec('npm:@scope/pkg@~1.0.0', { strictExact: true }),
            ).toThrow(/only exact semver is allowed in strict mode/i)

            expect(() =>
                parseNpmSpec('npm:@scope/pkg@latest', { strictExact: true }),
            ).toThrow(/only exact semver is allowed in strict mode/i)

            const exact = parseNpmSpec('npm:@scope/pkg@1.2.3', { strictExact: true })
            expect(exact.name).toBe('@scope/pkg')
            expect(exact.range).toBe('1.2.3')
        })

        it('detects tampering and rejects cached package if files are modified', async () => {
            const fixtureManifest = {
                name: 'tamper-test',
                version: '1.0.0',
                dist: { integrity: 'sha512-fixtureIntegrity==' },
            }

            const extractSpy = vi.fn(async (_spec: string, dest: string) => {
                await fs.mkdir(dest, { recursive: true })
                await fs.writeFile(
                    path.join(dest, 'manifest.json'),
                    JSON.stringify({
                        id: 'tamper-test',
                        name: 'Tamper Test',
                        version: '1.0.0',
                        apiVersion: '1.0.0',
                        engines: { cpa: '>=1.0.0' },
                        entries: { main: './index.js' },
                    }),
                    'utf-8',
                )
                await fs.writeFile(path.join(dest, 'index.js'), 'export default {};', 'utf-8')
            })

            const installer = new ManagedNpmInstaller({
                pluginsDir,
                fetchManifest: async () => fixtureManifest,
                extractPackage: extractSpy,
            })

            // First install calculates and locks content digest
            const installed = await installer.install('npm:tamper-test@1.0.0')
            expect(installed.packageRoot).toBeTruthy()

            // Modify index.js on disk (simulating disk tampering)
            await fs.writeFile(
                path.join(installed.packageRoot, 'index.js'),
                'console.log("tampered evil payload");',
                'utf-8',
            )

            // Subsequent install (even in offline mode) must detect tampering and throw
            const offlineInstaller = new ManagedNpmInstaller({
                pluginsDir,
                offline: true,
            })

            await expect(offlineInstaller.install('npm:tamper-test@1.0.0')).rejects.toThrow(
                /tamper|digest mismatch|corrupted/i,
            )
        })

        it('rejects installation if manifest entries attempt directory traversal', async () => {
            const fixtureManifest = {
                name: 'traversal-plugin',
                version: '1.0.0',
                dist: { integrity: 'sha512-trav==' },
            }

            const extractSpy = vi.fn(async (_spec: string, dest: string) => {
                await fs.mkdir(dest, { recursive: true })
                await fs.writeFile(
                    path.join(dest, 'manifest.json'),
                    JSON.stringify({
                        id: 'traversal-plugin',
                        name: 'Traversal Plugin',
                        version: '1.0.0',
                        apiVersion: '1.0.0',
                        engines: { cpa: '>=1.0.0' },
                        entries: { main: '../../outside.js' },
                    }),
                    'utf-8',
                )
            })

            const installer = new ManagedNpmInstaller({
                pluginsDir,
                fetchManifest: async () => fixtureManifest,
                extractPackage: extractSpy,
            })

            await expect(installer.install('npm:traversal-plugin@1.0.0')).rejects.toThrow(
                /source guard|directory traversal|outside/i,
            )
        })

        it('cleans up orphan packages without deleting active or locked versions', async () => {
            // Setup 3 packages on disk: active-pkg@1.0.0, locked-pkg@1.0.0, orphan-pkg@1.0.0
            const activeDir = path.join(pluginsDir, 'npm', 'active-pkg', '1.0.0')
            const lockedDir = path.join(pluginsDir, 'npm', 'locked-pkg', '1.0.0')
            const orphanDir = path.join(pluginsDir, 'npm', 'orphan-pkg', '1.0.0')

            await fs.mkdir(activeDir, { recursive: true })
            await fs.mkdir(lockedDir, { recursive: true })
            await fs.mkdir(orphanDir, { recursive: true })

            const lock = new PluginPackageLock(lockfilePath)
            await lock.save({
                version: 1,
                packages: {
                    'npm:locked-pkg@1.0.0': {
                        requested: 'npm:locked-pkg@1.0.0',
                        resolvedVersion: '1.0.0',
                        integrity: 'sha512-lock==',
                        packageRoot: lockedDir,
                    },
                },
            })

            const installer = new ManagedNpmInstaller({ pluginsDir })
            const activeRoots = new Set([activeDir])

            const cleaned = await installer.cleanOrphans(activeRoots)
            expect(cleaned).toContain(orphanDir)

            // orphanDir deleted
            expect(await fs.access(orphanDir).then(() => true).catch(() => false)).toBe(false)
            // active and locked preserved
            expect(await fs.access(activeDir).then(() => true).catch(() => false)).toBe(true)
            expect(await fs.access(lockedDir).then(() => true).catch(() => false)).toBe(true)
        })

        it('escapePackageName replaces forward slashes with plus signs', () => {
            expect(escapePackageName('@cpa/core-plugin')).toBe('@cpa+core-plugin')
            expect(escapePackageName('standard-pkg')).toBe('standard-pkg')
        })
    })

    describe('PluginPackageLock', () => {
        it('initializes empty lockfile when file does not exist', async () => {
            const lock = new PluginPackageLock(lockfilePath)
            const content = await lock.load()
            expect(content).toEqual({ version: 1, packages: {} })
        })

        it('writes atomically and preserves multiple entries', async () => {
            const lock = new PluginPackageLock(lockfilePath)
            await lock.set('npm:pkg-a@1.0.0', {
                requested: 'npm:pkg-a@1.0.0',
                resolvedVersion: '1.0.0',
                integrity: 'sha512-a==',
                packageRoot: '/path/a',
            })
            await lock.set('npm:pkg-b@2.0.0', {
                requested: 'npm:pkg-b@2.0.0',
                resolvedVersion: '2.0.0',
                integrity: 'sha512-b==',
                packageRoot: '/path/b',
            })

            const loaded = await lock.load()
            expect(loaded.version).toBe(1)
            expect(loaded.packages['npm:pkg-a@1.0.0']?.resolvedVersion).toBe('1.0.0')
            expect(loaded.packages['npm:pkg-b@2.0.0']?.resolvedVersion).toBe('2.0.0')

            // Verify raw file on disk is valid JSON
            const raw = JSON.parse(await fs.readFile(lockfilePath, 'utf-8'))
            expect(raw.version).toBe(1)
            expect(Object.keys(raw.packages).length).toBe(2)
        })

        it('removes entries cleanly', async () => {
            const lock = new PluginPackageLock(lockfilePath)
            await lock.set('npm:removable@1.0.0', {
                requested: 'npm:removable@1.0.0',
                resolvedVersion: '1.0.0',
                integrity: 'sha512-rem==',
                packageRoot: '/path/rem',
            })
            expect(await lock.get('npm:removable@1.0.0')).toBeDefined()

            await lock.remove('npm:removable@1.0.0')
            expect(await lock.get('npm:removable@1.0.0')).toBeUndefined()
        })

        it('rejects unsupported lockfile versions', async () => {
            await fs.writeFile(
                lockfilePath,
                JSON.stringify({ version: 2, packages: {} }),
                'utf-8',
            )
            const lock = new PluginPackageLock(lockfilePath)
            await expect(lock.load()).rejects.toThrow(/unsupported.*version/i)
        })

        it('rejects non-object or malformed lockfiles', async () => {
            await fs.writeFile(lockfilePath, 'not json', 'utf-8')
            const lock = new PluginPackageLock(lockfilePath)
            await expect(lock.load()).rejects.toThrow(/invalid json/i)

            await fs.writeFile(lockfilePath, '["an", "array"]', 'utf-8')
            await expect(lock.load()).rejects.toThrow(/expected an object/i)
        })
    })

    describe('NpmPluginSource', () => {
        it('discovers and loads npm plugins into ResolvedPluginPackage', async () => {
            const extractSpy = vi.fn(async (_s: string, dest: string) => {
                await fs.mkdir(dest, { recursive: true })
                await fs.writeFile(
                    path.join(dest, 'package.json'),
                    JSON.stringify({
                        name: '@tools/formatter',
                        version: '1.5.0',
                        cpa: {
                            id: 'tools-formatter',
                            apiVersion: '1.0.0',
                            engines: { cpa: '^1.0.0' },
                            entries: { main: './main.js' },
                        },
                    }),
                    'utf-8',
                )
                await fs.writeFile(
                    path.join(dest, 'main.js'),
                    'export default {};',
                    'utf-8',
                )
            })

            const installer = new ManagedNpmInstaller({
                pluginsDir,
                fetchManifest: async () => ({
                    name: '@tools/formatter',
                    version: '1.5.0',
                    dist: { integrity: 'sha512-formatterHash==' },
                }),
                extractPackage: extractSpy,
            })

            const source = new NpmPluginSource({
                installer,
                entries: [
                    { source: 'npm:@tools/formatter@^1.0.0', enabled: true },
                    { source: 'npm:disabled-plugin@1.0.0', enabled: false },
                ],
            })

            const packages = await source.discover()
            expect(packages.length).toBe(1)
            const pkg = packages[0]
            expect(pkg.manifest.id).toBe('tools-formatter')
            expect(pkg.manifest.version).toBe('1.5.0')
            expect(pkg.source.kind).toBe('npm')
            expect(pkg.source.spec).toBe('npm:@tools/formatter@^1.0.0')
            expect(pkg.integrity).toBe('sha512-formatterHash==')
            expect(pkg.entries.main).toBe(
                await fs.realpath(path.join(pkg.sourceRoot, 'main.js')),
            )
        })

        it('throws DuplicatePluginSourceError for duplicate IDs in npm source', async () => {
            const extractSpy = vi.fn(async (spec: string, dest: string) => {
                await fs.mkdir(dest, { recursive: true })
                await fs.writeFile(
                    path.join(dest, 'manifest.json'),
                    JSON.stringify({
                        id: 'same-id',
                        name: 'Same ID',
                        version: '1.0.0',
                        apiVersion: '1.0.0',
                        engines: { cpa: '^1.0.0' },
                        entries: { main: './index.js' },
                    }),
                    'utf-8',
                )
                await fs.writeFile(path.join(dest, 'index.js'), 'export default {};', 'utf-8')
            })

            const installer = new ManagedNpmInstaller({
                pluginsDir,
                fetchManifest: async (spec: string) => ({
                    name: spec.includes('pkg1') ? 'pkg1' : 'pkg2',
                    version: '1.0.0',
                    dist: { integrity: 'sha512-hash==' },
                }),
                extractPackage: extractSpy,
            })

            const source = new NpmPluginSource({
                installer,
                entries: [
                    { source: 'npm:pkg1@1.0.0' },
                    { source: 'npm:pkg2@1.0.0' },
                ],
            })

            await expect(source.discover()).rejects.toThrow(DuplicatePluginSourceError)
        })

        it('integrates with createPluginCatalog via configured sources', async () => {
            const extractSpy = vi.fn(async (_s: string, dest: string) => {
                await fs.mkdir(dest, { recursive: true })
                await fs.writeFile(
                    path.join(dest, 'manifest.json'),
                    JSON.stringify({
                        id: 'configured-npm-plugin',
                        name: 'Configured NPM Plugin',
                        version: '3.0.0',
                        apiVersion: '1.0.0',
                        engines: { cpa: '^1.0.0' },
                        entries: { main: './index.js' },
                    }),
                    'utf-8',
                )
                await fs.writeFile(path.join(dest, 'index.js'), 'export default {};', 'utf-8')
            })

            const installer = new ManagedNpmInstaller({
                pluginsDir,
                fetchManifest: async () => ({
                    name: '@org/npm-plugin',
                    version: '3.0.0',
                    dist: { integrity: 'sha512-orgHash==' },
                }),
                extractPackage: extractSpy,
            })

            const packages = await createPluginCatalog({
                homeDir: tempRoot,
                bundledPackages: [],
                npmInstaller: installer,
                globalConfig: {
                    sources: [{ source: 'npm:@org/npm-plugin@^3.0.0' }],
                },
            })

            expect(packages.length).toBe(1)
            expect(packages[0].manifest.id).toBe('configured-npm-plugin')
            expect(packages[0].source.kind).toBe('global-config')
            expect(packages[0].integrity).toBe('sha512-orgHash==')
        })
    })
})
