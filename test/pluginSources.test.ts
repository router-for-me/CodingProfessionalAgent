import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
    createPluginCatalog,
    type CreatePluginCatalogOptions,
} from '../src/main/plugins/catalog/createPluginCatalog.js'
import {
    loadGlobalPluginConfig,
    type PluginSourceConfig,
} from '../src/main/plugins/config/pluginSourceConfig.js'
import {
    assertPathInsideSourceRoot,
    validatePluginEntries,
} from '../src/main/plugins/sources/sourceRootGuard.js'
import {
    DuplicatePluginSourceError,
    PluginValidationError,
    PluginManifestError,
    type ResolvedPluginPackage,
} from '@cpa/plugin-api'

describe('Plugin Sources & Catalog Discovery', () => {
    let tempRoot: string
    let homeDir: string
    let projectDir: string
    let globalPluginsDir: string
    let outsideWorkspace: string

    async function createPluginFixture(
        dir: string,
        manifestOverrides: Record<string, unknown> = {},
        entryFiles: Record<string, string> = { 'index.js': 'export default {};' },
    ): Promise<string> {
        await fs.mkdir(dir, { recursive: true })
        const manifest = {
            id: path.basename(dir),
            name: path.basename(dir),
            version: '1.0.0',
            apiVersion: '1.0.0',
            engines: { cpa: '^1.0.0' },
            entries: { main: './index.js' },
            ...manifestOverrides,
        }
        await fs.writeFile(
            path.join(dir, 'manifest.json'),
            JSON.stringify(manifest, null, 2),
            'utf-8',
        )
        for (const [filename, content] of Object.entries(entryFiles)) {
            const filePath = path.join(dir, filename)
            await fs.mkdir(path.dirname(filePath), { recursive: true })
            await fs.writeFile(filePath, content, 'utf-8')
        }
        return dir
    }

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-plugin-sources-test-'))
        homeDir = path.join(tempRoot, 'home')
        projectDir = path.join(tempRoot, 'project')
        outsideWorkspace = path.join(tempRoot, 'outside-workspace')

        globalPluginsDir = path.join(homeDir, '.coding-professional-agent', 'plugins')

        await fs.mkdir(globalPluginsDir, { recursive: true })
        await fs.mkdir(outsideWorkspace, { recursive: true })
    })

    afterEach(async () => {
        try {
            await fs.rm(tempRoot, { recursive: true, force: true })
        } catch {
            // Ignore cleanup errors in tests
        }
    })

    describe('Source Precedence Ordering', () => {
        it('uses global configured source before global directory and bundled', async () => {
            const bundledPkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'same',
                    name: 'Same (Bundled)',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                },
                source: { kind: 'bundled', spec: 'bundled:same' },
                sourceRoot: '/bundled/same',
                entries: {},
            }

            // 1. Bundled
            const bundledPackages = [bundledPkg]

            // 2. Global Directory
            const globalDirPlugin = path.join(globalPluginsDir, 'same')
            await createPluginFixture(globalDirPlugin, { id: 'same', name: 'Same (Global Dir)' })

            // 3. Global Config
            const globalConfiguredDir = path.join(tempRoot, 'global-custom-same')
            await createPluginFixture(globalConfiguredDir, { id: 'same', name: 'Same (Global Config)' })
            const globalConfig: PluginSourceConfig = {
                sources: [{ source: `path:${globalConfiguredDir}` }],
            }

            const fixtureOptions: CreatePluginCatalogOptions = {
                homeDir,
                bundledPackages,
                globalConfig,
            }

            const packages = await createPluginCatalog(fixtureOptions)
            const samePlugin = packages.find((item) => item.manifest.id === 'same')
            expect(samePlugin).toBeDefined()
            expect(samePlugin?.source.kind).toBe('global-config')
            expect(samePlugin?.manifest.name).toBe('Same (Global Config)')
        })

        it('falls back to global directory when global config is not present', async () => {
            const bundledPkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'same',
                    name: 'Same (Bundled)',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                },
                source: { kind: 'bundled', spec: 'bundled:same' },
                sourceRoot: '/bundled/same',
                entries: {},
            }

            await createPluginFixture(path.join(globalPluginsDir, 'same'), {
                id: 'same',
                name: 'Same (Global Dir)',
            })

            const packages = await createPluginCatalog({
                homeDir,
                bundledPackages: [bundledPkg],
                globalConfig: { sources: [] },
            })

            const samePlugin = packages.find((item) => item.manifest.id === 'same')
            expect(samePlugin?.source.kind).toBe('global-directory')
            expect(samePlugin?.manifest.name).toBe('Same (Global Dir)')
        })

        it('falls back to bundled when global sources are absent', async () => {
            const bundledPkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'same',
                    name: 'Same (Bundled)',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                },
                source: { kind: 'bundled', spec: 'bundled:same' },
                sourceRoot: '/bundled/same',
                entries: {},
            }

            const packages = await createPluginCatalog({
                homeDir,
                bundledPackages: [bundledPkg],
                globalConfig: { sources: [] },
            })

            const samePlugin = packages.find((item) => item.manifest.id === 'same')
            expect(samePlugin?.source.kind).toBe('bundled')
            expect(samePlugin?.manifest.name).toBe('Same (Bundled)')
        })

        it('falls back to global directory when global config is absent', async () => {
            const bundledPkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'same',
                    name: 'Same (Bundled)',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                },
                source: { kind: 'bundled', spec: 'bundled:same' },
                sourceRoot: '/bundled/same',
                entries: {},
            }

            await createPluginFixture(path.join(globalPluginsDir, 'same'), {
                id: 'same',
                name: 'Same (Global Dir)',
            })

            const packages = await createPluginCatalog({
                projectPath: projectDir,
                homeDir,
                bundledPackages: [bundledPkg],
                globalConfig: { sources: [] },
            })

            const samePlugin = packages.find((item) => item.manifest.id === 'same')
            expect(samePlugin?.source.kind).toBe('global-directory')
            expect(samePlugin?.manifest.name).toBe('Same (Global Dir)')
        })

        it('falls back to bundled when no local or directory source is present', async () => {
            const bundledPkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'bundled-only',
                    name: 'Bundled Only',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                },
                source: { kind: 'bundled', spec: 'bundled:bundled-only' },
                sourceRoot: '/bundled/bundled-only',
                entries: {},
            }

            const packages = await createPluginCatalog({
                projectPath: projectDir,
                homeDir,
                bundledPackages: [bundledPkg],
                globalConfig: { sources: [] },
            })

            const pkg = packages.find((item) => item.manifest.id === 'bundled-only')
            expect(pkg?.source.kind).toBe('bundled')
        })
    })

    describe('Arbitrary Directory and Path Resolution', () => {
        it('allows an arbitrary configured directory as the source root', async () => {
            const customDir = path.join(outsideWorkspace, 'arbitrary-plugin')
            await createPluginFixture(customDir, { id: 'arbitrary-plugin' })

            const packages = await createPluginCatalog({
                homeDir,
                bundledPackages: [],
                globalConfig: { sources: [{ source: `path:${customDir}` }] },
            })

            expect(packages.length).toBe(1)
            expect(packages[0].manifest.id).toBe('arbitrary-plugin')
            expect(packages[0].sourceRoot).toBe(await fs.realpath(customDir))
        })

        it('resolves relative paths relative to the config file directory', async () => {
            const baseDir = path.join(homeDir, '.coding-professional-agent')
            const relDir = path.join(baseDir, 'custom-relative-plugin')
            await createPluginFixture(relDir, { id: 'relative-plugin' })

            const packages = await createPluginCatalog({
                homeDir,
                bundledPackages: [],
                globalConfig: { sources: [{ source: 'path:./custom-relative-plugin' }] },
                globalConfigDir: baseDir,
            })

            expect(packages.length).toBe(1)
            expect(packages[0].manifest.id).toBe('relative-plugin')
            expect(packages[0].sourceRoot).toBe(await fs.realpath(relDir))
        })
    })

    describe('Duplicate ID Error Handling', () => {
        it('throws DuplicatePluginSourceError for duplicate IDs within globalConfig', async () => {
            const dir1 = path.join(tempRoot, 'dup1')
            const dir2 = path.join(tempRoot, 'dup2')
            await createPluginFixture(dir1, { id: 'dup-plugin' })
            await createPluginFixture(dir2, { id: 'dup-plugin' })

            await expect(
                createPluginCatalog({
                    homeDir,
                    bundledPackages: [],
                    globalConfig: {
                        sources: [{ source: `path:${dir1}` }, { source: `path:${dir2}` }],
                    },
                }),
            ).rejects.toThrow(DuplicatePluginSourceError)
        })

        it('throws DuplicatePluginSourceError for duplicate IDs within global directory', async () => {
            const dirA = path.join(globalPluginsDir, 'folder-a')
            const dirB = path.join(globalPluginsDir, 'folder-b')
            await createPluginFixture(dirA, { id: 'conflict-id' })
            await createPluginFixture(dirB, { id: 'conflict-id' })

            await expect(
                createPluginCatalog({
                    homeDir,
                    bundledPackages: [],
                    globalConfig: { sources: [] },
                }),
            ).rejects.toThrow(DuplicatePluginSourceError)
        })

        it('throws DuplicatePluginSourceError for duplicate IDs within bundledPackages', async () => {
            const bundledPkg1: ResolvedPluginPackage = {
                manifest: {
                    id: 'dup-bundled',
                    name: 'Bundled 1',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                },
                source: { kind: 'bundled', spec: 'bundled:dup-bundled' },
                sourceRoot: '/bundled/1',
                entries: {},
            }
            const bundledPkg2: ResolvedPluginPackage = {
                manifest: {
                    id: 'dup-bundled',
                    name: 'Bundled 2',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                },
                source: { kind: 'bundled', spec: 'bundled:dup-bundled' },
                sourceRoot: '/bundled/2',
                entries: {},
            }

            await expect(
                createPluginCatalog({
                    homeDir,
                    bundledPackages: [bundledPkg1, bundledPkg2],
                    globalConfig: { sources: [] },
                }),
            ).rejects.toThrow(DuplicatePluginSourceError)
        })
    })

    describe('sourceRootGuard Security Checks', () => {
        it('validates canonical realpath when target is strictly inside sourceRoot', async () => {
            const pluginDir = path.join(tempRoot, 'valid-plugin')
            await createPluginFixture(pluginDir, {}, { 'src/index.js': 'export default {};' })
            const realDir = await fs.realpath(pluginDir)

            const resolved = await assertPathInsideSourceRoot('src/index.js', pluginDir)
            expect(resolved).toBe(path.join(realDir, 'src', 'index.js'))
        })

        it('rejects relative entry escaping source root using ../', async () => {
            const pluginDir = path.join(tempRoot, 'escape-plugin')
            await createPluginFixture(pluginDir, {
                entries: { main: '../outside.js' },
            })
            await fs.writeFile(path.join(tempRoot, 'outside.js'), 'malicious();', 'utf-8')

            await expect(
                validatePluginEntries(pluginDir, { main: '../outside.js' }),
            ).rejects.toThrow(/escapes|outside/)
        })

        it('rejects absolute entry pointing outside source root', async () => {
            const pluginDir = path.join(tempRoot, 'abs-escape-plugin')
            await createPluginFixture(pluginDir)
            const outsideFile = path.join(tempRoot, 'outside-secret.js')
            await fs.writeFile(outsideFile, 'secret();', 'utf-8')

            await expect(
                validatePluginEntries(pluginDir, { main: outsideFile }),
            ).rejects.toThrow(/escapes|outside/)
        })

        it('rejects symlink pointing outside source root', async () => {
            const pluginDir = path.join(tempRoot, 'symlink-plugin')
            await createPluginFixture(pluginDir)
            const outsideFile = path.join(tempRoot, 'outside-target.js')
            await fs.writeFile(outsideFile, 'target();', 'utf-8')

            const symlinkPath = path.join(pluginDir, 'symlink-entry.js')
            await fs.symlink(outsideFile, symlinkPath)

            await expect(
                validatePluginEntries(pluginDir, { main: './symlink-entry.js' }),
            ).rejects.toThrow(/escapes|outside/)
        })

        it('allows symlink pointing inside source root', async () => {
            const pluginDir = path.join(tempRoot, 'safe-symlink-plugin')
            await createPluginFixture(pluginDir, {}, {
                'lib/core.js': 'export default {};',
            })

            const symlinkPath = path.join(pluginDir, 'index.js')
            await fs.symlink(path.join(pluginDir, 'lib', 'core.js'), symlinkPath)

            const validated = await validatePluginEntries(pluginDir, { main: './index.js' })
            expect(validated.main).toBe(await fs.realpath(path.join(pluginDir, 'lib', 'core.js')))
        })
    })

    describe('Config Loaders', () => {
        it('loadGlobalPluginConfig loads plugins from settings.json', async () => {
            const settingsDir = path.join(homeDir, '.coding-professional-agent')
            await fs.mkdir(settingsDir, { recursive: true })
            const settingsPath = path.join(settingsDir, 'settings.json')
            const settings = {
                plugins: {
                    sources: [{ source: 'path:/global/custom', enabled: true }],
                },
            }
            await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')

            const loaded = await loadGlobalPluginConfig(homeDir)
            expect(loaded.sources).toEqual([{ source: 'path:/global/custom', enabled: true }])
        })
    })

    describe('Package.json fallback and Manifest validation', () => {
        it('supports package.json with cpa field', async () => {
            const pluginDir = path.join(tempRoot, 'pkg-plugin')
            await fs.mkdir(pluginDir, { recursive: true })
            const pkgJson = {
                name: 'pkg-plugin',
                version: '1.2.3',
                cpa: {
                    id: 'pkg-plugin-cpa',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                    entries: { main: './main.js' },
                },
            }
            await fs.writeFile(
                path.join(pluginDir, 'package.json'),
                JSON.stringify(pkgJson, null, 2),
                'utf-8',
            )
            await fs.writeFile(path.join(pluginDir, 'main.js'), 'export default 1;', 'utf-8')

            const packages = await createPluginCatalog({
                homeDir,
                bundledPackages: [],
                globalConfig: { sources: [{ source: `path:${pluginDir}` }] },
            })

            expect(packages.length).toBe(1)
            expect(packages[0].manifest.id).toBe('pkg-plugin-cpa')
            expect(packages[0].manifest.version).toBe('1.2.3')
        })

        it('auto-resolves default entries if entries field is omitted', async () => {
            const pluginDir = path.join(tempRoot, 'auto-entry-plugin')
            await fs.mkdir(pluginDir, { recursive: true })
            const manifest = {
                id: 'auto-entry-plugin',
                name: 'Auto Entry',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '^1.0.0' },
            }
            await fs.writeFile(
                path.join(pluginDir, 'manifest.json'),
                JSON.stringify(manifest, null, 2),
                'utf-8',
            )
            await fs.writeFile(path.join(pluginDir, 'main.js'), 'export default 1;', 'utf-8')

            const packages = await createPluginCatalog({
                homeDir,
                bundledPackages: [],
                globalConfig: { sources: [{ source: `path:${pluginDir}` }] },
            })

            expect(packages[0].entries.main).toBe(await fs.realpath(path.join(pluginDir, 'main.js')))
        })

        it('throws PluginManifestError when directory does not exist for loadPluginPackageFromDirectory', async () => {
            const { loadPluginPackageFromDirectory } = await import(
                '../src/main/plugins/sources/loadPluginPackage.js'
            )
            const missingDir = path.join(tempRoot, 'non-existent-plugin-dir')
            await expect(
                loadPluginPackageFromDirectory({
                    directory: missingDir,
                    sourceKind: 'global-config',
                    sourceSpec: 'path:./missing',
                }),
            ).rejects.toThrow(PluginManifestError)
        })

        it('supports bare npm spec in configured sources when installer is provided', async () => {
            const { ManagedNpmInstaller } = await import(
                '../src/main/plugins/packages/ManagedNpmInstaller.js'
            )
            const installer = new ManagedNpmInstaller({
                pluginsDir: globalPluginsDir,
                fetchManifest: async () => ({
                    name: '@custom/bare-source-pkg',
                    version: '1.0.0',
                    dist: { integrity: 'sha512-test==' },
                }),
                extractPackage: async (_spec, dest) => {
                    await createPluginFixture(dest, {
                        id: 'bare-source-plugin',
                        name: 'Bare Source Plugin',
                        version: '1.0.0',
                    })
                },
            })

            const packages = await createPluginCatalog({
                homeDir,
                bundledPackages: [],
                npmInstaller: installer,
                globalConfig: {
                    sources: [{ source: '@custom/bare-source-pkg@1.0.0' }],
                },
            })

            expect(packages.length).toBe(1)
            expect(packages[0].manifest.id).toBe('bare-source-plugin')
            expect(packages[0].source.kind).toBe('global-config')
        })
    })
})
