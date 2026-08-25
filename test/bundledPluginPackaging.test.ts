import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    discoverBundledPluginPackages,
    getBundledPluginDirectoryCandidates,
} from '../src/main/plugins/catalog/bootstrapPluginGraph.js'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const temporaryRoots: string[] = []

afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('Bundled plugin release packaging', () => {
    it('ships complete authoritative packages, including declared source entries', async () => {
        const config = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'))
        // Manifests alone are insufficient: discovery validates every declared entry on disk.
        expect(config.build.files).toContain('plugins/bundled/**/*')
    })

    it('includes native and WebSocket services as production dependencies', async () => {
        const config = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'))
        for (const dependency of ['ws', 'node-pty', 'better-sqlite3']) {
            expect(config.dependencies[dependency]).toBeDefined()
            expect(config.devDependencies[dependency]).toBeUndefined()
        }
    })

    it.each(['src/main/plugins/catalog', 'dist-electron/src/main/plugins/catalog'])(
        'discovers all packages from %s outside the repository working directory',
        async (moduleRelativePath) => {
            const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-packaged-plugins-'))
            temporaryRoots.push(root)
            const appRoot = path.join(root, 'Application Resources', 'app.asar')
            const bundledRoot = path.join(appRoot, 'plugins', 'bundled')
            const sourceRoot = path.join(repoRoot, 'plugins', 'bundled')
            await fs.cp(sourceRoot, bundledRoot, { recursive: true })

            const expectedIds = (await discoverBundledPluginPackages(sourceRoot))
                .map((pkg) => pkg.manifest.id).sort()
            expect(expectedIds.length).toBeGreaterThan(0)

            // Compiled JS without manifests must not mask the authoritative packages.
            await fs.mkdir(path.join(appRoot, 'dist-electron', 'plugins', 'bundled'), { recursive: true })
            const candidates = getBundledPluginDirectoryCandidates(path.join(appRoot, moduleRelativePath))
            let packages: Awaited<ReturnType<typeof discoverBundledPluginPackages>> = []
            for (const candidate of candidates) {
                packages = await discoverBundledPluginPackages(candidate)
                if (packages.length > 0) break
            }

            expect(packages.map((pkg) => pkg.manifest.id).sort()).toEqual(expectedIds)
            for (const pkg of packages) {
                expect(pkg.sourceRoot).toBe(await fs.realpath(path.join(bundledRoot, pkg.manifest.id)))
                for (const entry of Object.values(pkg.entries ?? {})) {
                    expect((await fs.stat(entry!)).isFile()).toBe(true)
                }
            }
        },
    )
})
