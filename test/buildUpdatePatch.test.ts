import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import * as asarModule from '@electron/asar'
import { createRequire } from 'node:module'
import { buildUpdatePatch } from '../scripts/build-update-patch.mjs'

const asar = asarModule.default?.createPackage ? asarModule.default : asarModule

describe('buildUpdatePatch', () => {
    let mockRoot: string
    let mockOutDir: string

    beforeEach(() => {
        mockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-patch-test-'))
        mockOutDir = path.join(mockRoot, 'bin', 'dist')

        // Set up mock project structure
        fs.mkdirSync(path.join(mockRoot, 'dist-electron', 'src', 'main'), { recursive: true })
        fs.writeFileSync(
            path.join(mockRoot, 'dist-electron', 'src', 'main', 'index.js'),
            'console.log("main index")',
            'utf8',
        )

        fs.mkdirSync(path.join(mockRoot, 'frontend', 'dist'), { recursive: true })
        fs.writeFileSync(path.join(mockRoot, 'frontend', 'dist', 'index.html'), '<html></html>', 'utf8')

        fs.mkdirSync(path.join(mockRoot, 'plugins', 'bundled', 'core-plugin'), { recursive: true })
        fs.writeFileSync(
            path.join(mockRoot, 'plugins', 'bundled', 'core-plugin', 'manifest.json'),
            '{"id":"core-plugin"}',
            'utf8',
        )

        fs.mkdirSync(path.join(mockRoot, 'build'), { recursive: true })
        fs.writeFileSync(path.join(mockRoot, 'build', 'appicon.png'), 'appicon data', 'utf8')
        fs.writeFileSync(path.join(mockRoot, 'build', 'trayTemplate.png'), 'tray data', 'utf8')
        fs.writeFileSync(path.join(mockRoot, 'build', 'ignored.txt'), 'ignored file', 'utf8')

        // Mock workspace packages
        fs.mkdirSync(path.join(mockRoot, 'packages', 'plugin-kernel', 'dist'), { recursive: true })
        fs.writeFileSync(
            path.join(mockRoot, 'packages', 'plugin-kernel', 'package.json'),
            JSON.stringify({ name: '@cpa/plugin-kernel', version: '1.0.0', main: './dist/index.js' }),
            'utf8',
        )
        fs.writeFileSync(
            path.join(mockRoot, 'packages', 'plugin-kernel', 'dist', 'index.js'),
            'export const kernel = "mock";',
            'utf8',
        )

        fs.mkdirSync(path.join(mockRoot, 'packages', 'plugin-sdk', 'dist'), { recursive: true })
        fs.writeFileSync(
            path.join(mockRoot, 'packages', 'plugin-sdk', 'package.json'),
            JSON.stringify({
                name: '@cpa/plugin-sdk',
                version: '1.0.0',
                main: './dist/index.js',
                dependencies: {
                    '@cpa/plugin-api': 'workspace:*',
                    diff: '^5.2.0',
                    yaml: '^2.9.0',
                },
            }),
            'utf8',
        )
        fs.writeFileSync(
            path.join(mockRoot, 'packages', 'plugin-sdk', 'dist', 'index.js'),
            'export const sdk = "mock";',
            'utf8',
        )

        // Mock workspace package dependencies (diff and yaml inside plugin-sdk/node_modules)
        fs.mkdirSync(path.join(mockRoot, 'packages', 'plugin-sdk', 'node_modules', 'diff'), { recursive: true })
        fs.writeFileSync(
            path.join(mockRoot, 'packages', 'plugin-sdk', 'node_modules', 'diff', 'package.json'),
            JSON.stringify({ name: 'diff', version: '5.2.0', main: './index.js' }),
            'utf8',
        )
        fs.writeFileSync(
            path.join(mockRoot, 'packages', 'plugin-sdk', 'node_modules', 'diff', 'index.js'),
            'module.exports = { diffLines: () => {} };',
            'utf8',
        )

        fs.mkdirSync(path.join(mockRoot, 'packages', 'plugin-sdk', 'node_modules', 'yaml'), { recursive: true })
        fs.writeFileSync(
            path.join(mockRoot, 'packages', 'plugin-sdk', 'node_modules', 'yaml', 'package.json'),
            JSON.stringify({ name: 'yaml', version: '2.9.0', main: './index.js' }),
            'utf8',
        )
        fs.writeFileSync(
            path.join(mockRoot, 'packages', 'plugin-sdk', 'node_modules', 'yaml', 'index.js'),
            'module.exports = { parse: () => {} };',
            'utf8',
        )

        // Mock pure JS node_modules dependency
        fs.mkdirSync(path.join(mockRoot, 'node_modules', 'semver'), { recursive: true })
        fs.writeFileSync(
            path.join(mockRoot, 'node_modules', 'semver', 'package.json'),
            JSON.stringify({ name: 'semver', version: '7.8.5' }),
            'utf8',
        )
        fs.writeFileSync(
            path.join(mockRoot, 'node_modules', 'semver', 'index.js'),
            'module.exports = {};',
            'utf8',
        )

        // Mock native dependency that should remain in base app
        fs.mkdirSync(path.join(mockRoot, 'node_modules', 'better-sqlite3'), { recursive: true })
        fs.writeFileSync(
            path.join(mockRoot, 'node_modules', 'better-sqlite3', 'package.json'),
            JSON.stringify({ name: 'better-sqlite3', version: '12.11.1' }),
            'utf8',
        )

        fs.writeFileSync(
            path.join(mockRoot, 'package.json'),
            JSON.stringify(
                {
                    name: 'mock-cpa',
                    version: '2.5.0',
                    devDependencies: {
                        electron: '^44.0.0',
                    },
                    dependencies: {
                        '@cpa/plugin-kernel': 'workspace:*',
                        '@cpa/plugin-sdk': 'workspace:*',
                        semver: '^7.8.5',
                        'better-sqlite3': '^12.11.1',
                    },
                },
                null,
                2,
            ),
            'utf8',
        )
    })

    afterEach(() => {
        if (fs.existsSync(mockRoot)) {
            fs.rmSync(mockRoot, { recursive: true, force: true })
        }
    })

    it('packages app into asar and generates initial release manifest', async () => {
        const result = await buildUpdatePatch({
            rootDir: mockRoot,
            outDir: mockOutDir,
            skipBuild: true,
        })

        expect(result.version).toBe('2.5.0')
        expect(fs.existsSync(result.asarPath)).toBe(true)
        expect(fs.existsSync(result.manifestPath)).toBe(true)

        // Verify asar contents
        const filesInAsar = asar.listPackage(result.asarPath)
        expect(filesInAsar).toContain(path.sep + 'dist-electron' + path.sep + 'src' + path.sep + 'main' + path.sep + 'index.js')
        expect(filesInAsar).toContain(path.sep + 'frontend' + path.sep + 'dist' + path.sep + 'index.html')
        expect(filesInAsar).toContain(path.sep + 'plugins' + path.sep + 'bundled' + path.sep + 'core-plugin' + path.sep + 'manifest.json')
        expect(filesInAsar).toContain(path.sep + 'package.json')
        expect(filesInAsar).toContain(path.sep + 'build' + path.sep + 'appicon.png')
        expect(filesInAsar).toContain(path.sep + 'build' + path.sep + 'trayTemplate.png')
        expect(filesInAsar).not.toContain(path.sep + 'build' + path.sep + 'ignored.txt')

        // Verify workspace packages and pure JS dependencies are bundled into asar
        expect(filesInAsar).toContain(path.sep + 'node_modules' + path.sep + '@cpa' + path.sep + 'plugin-kernel' + path.sep + 'package.json')
        expect(filesInAsar).toContain(path.sep + 'node_modules' + path.sep + '@cpa' + path.sep + 'plugin-kernel' + path.sep + 'dist' + path.sep + 'index.js')
        expect(filesInAsar).toContain(path.sep + 'node_modules' + path.sep + '@cpa' + path.sep + 'plugin-sdk' + path.sep + 'package.json')
        expect(filesInAsar).toContain(path.sep + 'node_modules' + path.sep + '@cpa' + path.sep + 'plugin-sdk' + path.sep + 'dist' + path.sep + 'index.js')
        expect(filesInAsar).toContain(path.sep + 'node_modules' + path.sep + 'semver' + path.sep + 'package.json')
        expect(filesInAsar).toContain(path.sep + 'node_modules' + path.sep + 'semver' + path.sep + 'index.js')
        // Transitive workspace dependencies (diff and yaml from plugin-sdk) must be bundled into asar
        expect(filesInAsar).toContain(path.sep + 'node_modules' + path.sep + 'diff' + path.sep + 'package.json')
        expect(filesInAsar).toContain(path.sep + 'node_modules' + path.sep + 'diff' + path.sep + 'index.js')
        expect(filesInAsar).toContain(path.sep + 'node_modules' + path.sep + 'yaml' + path.sep + 'package.json')
        expect(filesInAsar).toContain(path.sep + 'node_modules' + path.sep + 'yaml' + path.sep + 'index.js')
        // Native modules should NOT be in the asar patch
        expect(filesInAsar).not.toContain(path.sep + 'node_modules' + path.sep + 'better-sqlite3' + path.sep + 'package.json')

        // Verify SHA256 and size matching
        const asarBuf = fs.readFileSync(result.asarPath)
        const expectedSha256 = crypto.createHash('sha256').update(asarBuf).digest('hex')
        expect(result.sha256).toBe(expectedSha256)
        expect(result.size).toBe(asarBuf.length)

        // Verify initial manifest
        const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
        expect(manifest.version).toBe('2.5.0')
        expect(manifest.asar).toEqual({
            filename: 'app-update-2.5.0.asar',
            url: expect.stringContaining('/app-update-2.5.0.asar'),
            sha256: expectedSha256,
            size: asarBuf.length,
        })
        expect(manifest.nativeRequirements).toEqual({
            electron: '44.0.0',
            modules: '149',
            minNativeBaseVersion: '1.0.0',
        })
    })

    it('throws when required directories are missing', async () => {
        fs.rmSync(path.join(mockRoot, 'dist-electron'), { recursive: true, force: true })

        await expect(
            buildUpdatePatch({
                rootDir: mockRoot,
                outDir: mockOutDir,
                skipBuild: true,
            }),
        ).rejects.toThrow('Required directory missing')
    })

    it('scans all packages/*/package.json and bundles their dependencies (diff, yaml) into asar', async () => {
        // Root package.json only contains @cpa/plugin-sdk and no diff/yaml
        fs.writeFileSync(
            path.join(mockRoot, 'package.json'),
            JSON.stringify(
                {
                    name: 'mock-cpa',
                    version: '2.5.0',
                    dependencies: {
                        '@cpa/plugin-sdk': 'workspace:*',
                    },
                },
                null,
                2,
            ),
            'utf8',
        )

        const result = await buildUpdatePatch({
            rootDir: mockRoot,
            outDir: mockOutDir,
            skipBuild: true,
        })

        const filesInAsar = asar.listPackage(result.asarPath)
        expect(filesInAsar).toContain(path.sep + 'node_modules' + path.sep + 'diff' + path.sep + 'package.json')
        expect(filesInAsar).toContain(path.sep + 'node_modules' + path.sep + 'yaml' + path.sep + 'package.json')
        expect(filesInAsar).not.toContain(path.sep + 'node_modules' + path.sep + 'better-sqlite3' + path.sep + 'package.json')
    })

    it('recursively resolves and bundles transitive dependency closure without ERR_MODULE_NOT_FOUND', async () => {
        // Mock a direct dependency 'foo-parent' declared in package.json
        // 'foo-parent' depends on 'foo-child'
        // 'foo-child' depends on '@test-scope/foo-grandchild'
        // Simulating pnpm monorepo structure where child dependencies reside in .pnpm store or sibling node_modules

        const pnpmStoreDir = path.join(mockRoot, 'node_modules', '.pnpm')
        const parentStoreDir = path.join(pnpmStoreDir, 'foo-parent@1.0.0', 'node_modules')

        // 1. foo-parent package
        fs.mkdirSync(path.join(parentStoreDir, 'foo-parent'), { recursive: true })
        fs.writeFileSync(
            path.join(parentStoreDir, 'foo-parent', 'package.json'),
            JSON.stringify({
                name: 'foo-parent',
                version: '1.0.0',
                main: './index.js',
                dependencies: {
                    'foo-child': '^2.0.0',
                },
            }),
            'utf8',
        )
        fs.writeFileSync(
            path.join(parentStoreDir, 'foo-parent', 'index.js'),
            'const child = require("foo-child");\nmodule.exports = { name: "foo-parent", childValue: child.getValue() };',
            'utf8',
        )

        // Symlink foo-parent into root node_modules/foo-parent (as pnpm does)
        fs.mkdirSync(path.join(mockRoot, 'node_modules'), { recursive: true })
        fs.symlinkSync(
            path.join(parentStoreDir, 'foo-parent'),
            path.join(mockRoot, 'node_modules', 'foo-parent'),
        )

        // 2. foo-child package inside .pnpm virtual store as sibling of foo-parent
        fs.mkdirSync(path.join(parentStoreDir, 'foo-child'), { recursive: true })
        fs.writeFileSync(
            path.join(parentStoreDir, 'foo-child', 'package.json'),
            JSON.stringify({
                name: 'foo-child',
                version: '2.0.0',
                main: './index.js',
                dependencies: {
                    '@test-scope/foo-grandchild': '^1.5.0',
                },
            }),
            'utf8',
        )
        fs.writeFileSync(
            path.join(parentStoreDir, 'foo-child', 'index.js'),
            'const grandchild = require("@test-scope/foo-grandchild");\nmodule.exports = { name: "foo-child", getValue: () => "child-data:" + grandchild.data };',
            'utf8',
        )

        // 3. @test-scope/foo-grandchild package inside .pnpm virtual store
        fs.mkdirSync(path.join(parentStoreDir, '@test-scope', 'foo-grandchild'), { recursive: true })
        fs.writeFileSync(
            path.join(parentStoreDir, '@test-scope', 'foo-grandchild', 'package.json'),
            JSON.stringify({
                name: '@test-scope/foo-grandchild',
                version: '1.5.0',
                main: './index.js',
            }),
            'utf8',
        )
        fs.writeFileSync(
            path.join(parentStoreDir, '@test-scope', 'foo-grandchild', 'index.js'),
            'module.exports = { data: "grandchild-data" };',
            'utf8',
        )

        // Add foo-parent to root package.json dependencies
        fs.writeFileSync(
            path.join(mockRoot, 'package.json'),
            JSON.stringify(
                {
                    name: 'mock-cpa',
                    version: '2.5.0',
                    dependencies: {
                        'foo-parent': '^1.0.0',
                    },
                },
                null,
                2,
            ),
            'utf8',
        )

        const result = await buildUpdatePatch({
            rootDir: mockRoot,
            outDir: mockOutDir,
            skipBuild: true,
            keepStagingDir: true,
        })

        // 1. Verify transitive dependencies are resolved and copied into stagingDir/node_modules/
        expect(result.stagingDir).toBeDefined()
        expect(fs.existsSync(path.join(result.stagingDir, 'node_modules', 'foo-parent', 'package.json'))).toBe(true)
        expect(fs.existsSync(path.join(result.stagingDir, 'node_modules', 'foo-child', 'package.json'))).toBe(true)
        expect(fs.existsSync(path.join(result.stagingDir, 'node_modules', '@test-scope', 'foo-grandchild', 'package.json'))).toBe(true)

        // 2. Verify asar package contains all transitive dependencies
        const filesInAsar = asar.listPackage(result.asarPath)
        expect(filesInAsar).toContain(path.sep + 'node_modules' + path.sep + 'foo-parent' + path.sep + 'package.json')
        expect(filesInAsar).toContain(path.sep + 'node_modules' + path.sep + 'foo-parent' + path.sep + 'index.js')
        expect(filesInAsar).toContain(path.sep + 'node_modules' + path.sep + 'foo-child' + path.sep + 'package.json')
        expect(filesInAsar).toContain(path.sep + 'node_modules' + path.sep + 'foo-child' + path.sep + 'index.js')
        expect(filesInAsar).toContain(path.sep + 'node_modules' + path.sep + '@test-scope' + path.sep + 'foo-grandchild' + path.sep + 'package.json')
        expect(filesInAsar).toContain(path.sep + 'node_modules' + path.sep + '@test-scope' + path.sep + 'foo-grandchild' + path.sep + 'index.js')

        // 3. Extract asar to an isolated directory and test importing foo-parent
        const extractDir = path.join(mockRoot, 'extracted-asar')
        asar.extractAll(result.asarPath, extractDir)

        const req = createRequire(path.join(extractDir, 'dummy.js'))
        // Should successfully require foo-parent which in turn requires foo-child and @test-scope/foo-grandchild without ERR_MODULE_NOT_FOUND
        const parentMod = req('foo-parent')
        expect(parentMod.name).toBe('foo-parent')
        expect(parentMod.childValue).toBe('child-data:grandchild-data')

        // Verify that without transitive child, importing would fail with ERR_MODULE_NOT_FOUND / MODULE_NOT_FOUND
        const brokenExtractDir = path.join(mockRoot, 'broken-extract')
        fs.mkdirSync(path.join(brokenExtractDir, 'node_modules', 'foo-parent'), { recursive: true })
        fs.copyFileSync(
            path.join(extractDir, 'node_modules', 'foo-parent', 'package.json'),
            path.join(brokenExtractDir, 'node_modules', 'foo-parent', 'package.json'),
        )
        fs.copyFileSync(
            path.join(extractDir, 'node_modules', 'foo-parent', 'index.js'),
            path.join(brokenExtractDir, 'node_modules', 'foo-parent', 'index.js'),
        )
        const brokenReq = createRequire(path.join(brokenExtractDir, 'dummy.js'))
        expect(() => brokenReq('foo-parent')).toThrow(/Cannot find module 'foo-child'/)
    })

    it('supports multi-version dependencies by nesting conflicting versions without collision', async () => {
        // Setup:
        // parent-a depends on shared-child@1.0.0
        // parent-b depends on shared-child@2.0.0
        // shared-child@1.0.0 depends on sub-child@1.0.0
        // shared-child@2.0.0 depends on sub-child@2.0.0

        // 1. parent-a package
        const parentADir = path.join(mockRoot, 'node_modules', 'parent-a')
        fs.mkdirSync(parentADir, { recursive: true })
        fs.writeFileSync(
            path.join(parentADir, 'package.json'),
            JSON.stringify({
                name: 'parent-a',
                version: '1.0.0',
                main: './index.js',
                dependencies: {
                    'shared-child': '^1.0.0',
                },
            }),
            'utf8',
        )
        fs.writeFileSync(
            path.join(parentADir, 'index.js'),
            'const child = require("shared-child");\nmodule.exports = { name: "parent-a", childVersion: child.version, childMessage: child.getMessage() };',
            'utf8',
        )

        // shared-child@1.0.0 inside parent-a
        const sharedChildV1Dir = path.join(parentADir, 'node_modules', 'shared-child')
        fs.mkdirSync(sharedChildV1Dir, { recursive: true })
        fs.writeFileSync(
            path.join(sharedChildV1Dir, 'package.json'),
            JSON.stringify({
                name: 'shared-child',
                version: '1.0.0',
                main: './index.js',
                dependencies: {
                    'sub-child': '^1.0.0',
                },
            }),
            'utf8',
        )
        fs.writeFileSync(
            path.join(sharedChildV1Dir, 'index.js'),
            'const sub = require("sub-child");\nmodule.exports = { version: "1.0.0", getMessage: () => "v1 with " + sub.val };',
            'utf8',
        )

        // sub-child@1.0.0 inside shared-child@1.0.0
        const subChildV1Dir = path.join(sharedChildV1Dir, 'node_modules', 'sub-child')
        fs.mkdirSync(subChildV1Dir, { recursive: true })
        fs.writeFileSync(
            path.join(subChildV1Dir, 'package.json'),
            JSON.stringify({
                name: 'sub-child',
                version: '1.0.0',
                main: './index.js',
            }),
            'utf8',
        )
        fs.writeFileSync(
            path.join(subChildV1Dir, 'index.js'),
            'module.exports = { val: "sub-v1" };',
            'utf8',
        )

        // 2. parent-b package
        const parentBDir = path.join(mockRoot, 'node_modules', 'parent-b')
        fs.mkdirSync(parentBDir, { recursive: true })
        fs.writeFileSync(
            path.join(parentBDir, 'package.json'),
            JSON.stringify({
                name: 'parent-b',
                version: '2.0.0',
                main: './index.js',
                dependencies: {
                    'shared-child': '^2.0.0',
                },
            }),
            'utf8',
        )
        fs.writeFileSync(
            path.join(parentBDir, 'index.js'),
            'const child = require("shared-child");\nmodule.exports = { name: "parent-b", childVersion: child.version, childMessage: child.getMessage() };',
            'utf8',
        )

        // shared-child@2.0.0 inside parent-b
        const sharedChildV2Dir = path.join(parentBDir, 'node_modules', 'shared-child')
        fs.mkdirSync(sharedChildV2Dir, { recursive: true })
        fs.writeFileSync(
            path.join(sharedChildV2Dir, 'package.json'),
            JSON.stringify({
                name: 'shared-child',
                version: '2.0.0',
                main: './index.js',
                dependencies: {
                    'sub-child': '^2.0.0',
                },
            }),
            'utf8',
        )
        fs.writeFileSync(
            path.join(sharedChildV2Dir, 'index.js'),
            'const sub = require("sub-child");\nmodule.exports = { version: "2.0.0", getMessage: () => "v2 with " + sub.val };',
            'utf8',
        )

        // sub-child@2.0.0 inside shared-child@2.0.0
        const subChildV2Dir = path.join(sharedChildV2Dir, 'node_modules', 'sub-child')
        fs.mkdirSync(subChildV2Dir, { recursive: true })
        fs.writeFileSync(
            path.join(subChildV2Dir, 'package.json'),
            JSON.stringify({
                name: 'sub-child',
                version: '2.0.0',
                main: './index.js',
            }),
            'utf8',
        )
        fs.writeFileSync(
            path.join(subChildV2Dir, 'index.js'),
            'module.exports = { val: "sub-v2" };',
            'utf8',
        )

        // Add parent-a and parent-b to mockRoot package.json dependencies
        fs.writeFileSync(
            path.join(mockRoot, 'package.json'),
            JSON.stringify(
                {
                    name: 'mock-cpa',
                    version: '2.5.0',
                    dependencies: {
                        'parent-a': '^1.0.0',
                        'parent-b': '^2.0.0',
                    },
                },
                null,
                2,
            ),
            'utf8',
        )

        const result = await buildUpdatePatch({
            rootDir: mockRoot,
            outDir: mockOutDir,
            skipBuild: true,
            keepStagingDir: true,
        })

        // Verify that stagingDir has both top-level and nested versions
        expect(result.stagingDir).toBeDefined()
        const topShared = path.join(result.stagingDir, 'node_modules', 'shared-child', 'package.json')
        expect(fs.existsSync(topShared)).toBe(true)

        // Nested version exists under parent-b
        const nestedShared = path.join(
            result.stagingDir,
            'node_modules',
            'parent-b',
            'node_modules',
            'shared-child',
            'package.json',
        )
        expect(fs.existsSync(nestedShared)).toBe(true)

        // Extract ASAR to an isolated directory and test requiring both parent-a and parent-b
        const extractDir = path.join(mockRoot, 'extracted-multi-version')
        asar.extractAll(result.asarPath, extractDir)

        const req = createRequire(path.join(extractDir, 'dummy.js'))
        const parentA = req('parent-a')
        const parentB = req('parent-b')

        expect(parentA.childVersion).toBe('1.0.0')
        expect(parentA.childMessage).toBe('v1 with sub-v1')

        expect(parentB.childVersion).toBe('2.0.0')
        expect(parentB.childMessage).toBe('v2 with sub-v2')
    })
})
