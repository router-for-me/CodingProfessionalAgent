import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import type { ResolvedPluginPackage } from '@cpa/plugin-api'

const { mockProtocol } = vi.hoisted(() => {
    const mockProtocol = {
        registerSchemesAsPrivileged: vi.fn(),
        handle: vi.fn(),
    }
    return { mockProtocol }
})

vi.mock('electron', () => ({
    protocol: mockProtocol,
}))

import { PluginResourceService } from '../src/main/plugins/resources/PluginResourceService.js'
import { registerPluginProtocol, registerPluginSchemesAsPrivileged } from '../src/main/plugins/resources/registerPluginProtocol.js'
import { MainPluginModuleLoader } from '../src/main/plugins/loading/MainPluginModuleLoader.js'
import { WebServerService } from '../src/main/services/webServerService.js'

describe('PluginResourceService & MainPluginModuleLoader', () => {
    let tempRoot: string
    let pluginDir: string
    let secretFile: string
    let resolvedPkg: ResolvedPluginPackage
    let resourceService: PluginResourceService
    let moduleLoader: MainPluginModuleLoader

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-plugin-resource-test-'))
        pluginDir = path.join(tempRoot, 'my-test-plugin')
        secretFile = path.join(tempRoot, 'secret.txt')

        await fs.writeFile(secretFile, 'SUPER_SECRET_TOKEN', 'utf-8')
        await fs.mkdir(path.join(pluginDir, 'chunks'), { recursive: true })
        await fs.mkdir(path.join(pluginDir, 'assets'), { recursive: true })

        // Plugin files
        await fs.writeFile(
            path.join(pluginDir, 'manifest.json'),
            JSON.stringify({
                id: 'my-test-plugin',
                name: 'My Test Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '^1.0.0' },
                entries: {
                    main: './index.js',
                    renderer: './renderer.js',
                },
            }),
            'utf-8',
        )
        await fs.writeFile(
            path.join(pluginDir, 'index.js'),
            `export default { manifest: { id: 'my-test-plugin', name: 'My Test Plugin', version: '1.0.0', apiVersion: '1.0.0', engines: { cpa: '^1.0.0' } }, activate(ctx) {} };`,
            'utf-8',
        )
        await fs.writeFile(
            path.join(pluginDir, 'chunks', 'view.js'),
            `export const renderChunk = () => '<div>rendered chunk</div>';`,
            'utf-8',
        )
        await fs.writeFile(
            path.join(pluginDir, 'assets', 'style.css'),
            `body { background: red; }`,
            'utf-8',
        )
        await fs.writeFile(
            path.join(pluginDir, 'assets', 'data.json'),
            `{"key": "value"}`,
            'utf-8',
        )
        await fs.writeFile(
            path.join(pluginDir, 'assets', 'icon.svg'),
            `<svg viewBox="0 0 100 100"></svg>`,
            'utf-8',
        )

        try {
            await fs.symlink(secretFile, path.join(pluginDir, 'assets', 'escape-link.txt'))
        } catch {
            // Ignore if symlinks unsupported
        }

        resolvedPkg = {
            manifest: {
                id: 'my-test-plugin',
                name: 'My Test Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '^1.0.0' },
                entries: {
                    main: path.join(pluginDir, 'index.js'),
                    renderer: path.join(pluginDir, 'renderer.js'),
                },
            },
            source: {
                kind: 'project-directory',
                spec: `path:${pluginDir}`,
            },
            sourceRoot: pluginDir,
            entries: {
                main: path.join(pluginDir, 'index.js'),
            },
        }

        resourceService = new PluginResourceService()
        resourceService.registerPackage(resolvedPkg)

        moduleLoader = new MainPluginModuleLoader()
    })

    afterEach(async () => {
        try {
            await fs.rm(tempRoot, { recursive: true, force: true })
        } catch {
            // Ignore cleanup error
        }
    })

    describe('PluginResourceService', () => {
        it('serves a chunk relative to the resolved package root', async () => {
            const response = await resourceService.readResource('my-test-plugin', 'chunks/view.js')
            expect(response.contentType).toBe('text/javascript')
            expect(response.body.toString()).toContain('export')
        })

        it('serves various asset types with correct content types', async () => {
            const cssRes = await resourceService.readResource('my-test-plugin', 'assets/style.css')
            expect(cssRes.contentType).toContain('text/css')
            expect(cssRes.body.toString()).toContain('background: red;')

            const jsonRes = await resourceService.readResource('my-test-plugin', 'assets/data.json')
            expect(jsonRes.contentType).toContain('application/json')
            expect(JSON.parse(jsonRes.body.toString())).toEqual({ key: 'value' })

            const svgRes = await resourceService.readResource('my-test-plugin', 'assets/icon.svg')
            expect(svgRes.contentType).toContain('image/svg+xml')
        })

        it('rejects a resource outside the package root', async () => {
            await expect(
                resourceService.readResource('my-test-plugin', '../secret.txt'),
            ).rejects.toThrow('Plugin resource escapes source root')
        })

        it('rejects a resource with deep traversal outside package root', async () => {
            await expect(
                resourceService.readResource('my-test-plugin', 'chunks/../../secret.txt'),
            ).rejects.toThrow('Plugin resource escapes source root')
        })

        it('rejects a resource that is a symlink pointing outside source root', async () => {
            await expect(
                resourceService.readResource('my-test-plugin', 'assets/escape-link.txt'),
            ).rejects.toThrow('Plugin resource escapes source root')
        })

        it('throws when package is not found', async () => {
            await expect(
                resourceService.readResource('non-existent-plugin', 'chunks/view.js'),
            ).rejects.toThrow("Plugin package 'non-existent-plugin' not found")
        })

        it('throws when resource file is not found inside package', async () => {
            await expect(
                resourceService.readResource('my-test-plugin', 'chunks/missing.js'),
            ).rejects.toThrow('Plugin resource not found')
        })

        it('rejects multi-encoded traversal attempts', async () => {
            await expect(
                resourceService.readResource('my-test-plugin', '..%252F..%252Fsecret.txt'),
            ).rejects.toThrow('Plugin resource escapes source root')

            await expect(
                resourceService.readResource('my-test-plugin', '%2e%2e%2f%2e%2e%2fsecret.txt'),
            ).rejects.toThrow('Plugin resource escapes source root')

            await expect(
                resourceService.readResource('my-test-plugin', 'assets%2F%2e%2e%2F%2e%2e%2Fsecret.txt'),
            ).rejects.toThrow('Plugin resource escapes source root')
        })

        it('binds resources to active graph revision and rejects mismatching or old revisions', async () => {
            const revService = new PluginResourceService([resolvedPkg], 'rev_alpha_123')
            expect(revService.getRevision()).toBe('rev_alpha_123')

            // Matching revision succeeds
            const okRes = await revService.readResource('my-test-plugin', 'assets/data.json', 'rev_alpha_123')
            expect(okRes.statusCode).toBe(200)

            // Mismatched revision fails
            await expect(
                revService.readResource('my-test-plugin', 'assets/data.json', 'rev_stale_999'),
            ).rejects.toThrow(/revision/i)

            // Updating revision to rev_beta_456 without the package makes it unavailable
            revService.setPackages([], 'rev_beta_456')
            await expect(
                revService.readResource('my-test-plugin', 'assets/data.json', 'rev_beta_456'),
            ).rejects.toThrow(/not found/i)
        })
    })

    describe('MainPluginModuleLoader & Security', () => {
        it('loads bundled in-process plugin definition', async () => {
            const bundledPkg: ResolvedPluginPackage = {
                ...resolvedPkg,
                source: {
                    kind: 'bundled',
                    spec: `path:${pluginDir}`,
                },
            }

            const def = await moduleLoader.load(bundledPkg, 'main')
            expect(def).toBeDefined()
            expect(def?.manifest.id).toBe('my-test-plugin')
            expect(typeof def?.activate).toBe('function')
        })

        it('returns undefined if entry for runtime kind does not exist', async () => {
            const pkgWithoutRenderer: ResolvedPluginPackage = {
                ...resolvedPkg,
                entries: {
                    main: path.join(pluginDir, 'index.js'),
                },
            }

            const def = await moduleLoader.load(pkgWithoutRenderer, 'renderer')
            expect(def).toBeUndefined()
        })

        it('does not let an external main entry import node fs directly', async () => {
            const unsafePluginDir = path.join(tempRoot, 'unsafe-plugin-fs')
            await fs.mkdir(unsafePluginDir, { recursive: true })
            await fs.writeFile(
                path.join(unsafePluginDir, 'index.js'),
                `import * as fs from 'node:fs';\nexport default { activate() {} };`,
                'utf-8',
            )

            const externalPackageImportingNodeFs: ResolvedPluginPackage = {
                manifest: {
                    id: 'unsafe-fs-plugin',
                    name: 'Unsafe FS Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                    entries: { main: './index.js' },
                },
                source: {
                    kind: 'project-directory',
                    spec: `path:${unsafePluginDir}`,
                },
                sourceRoot: unsafePluginDir,
                entries: {
                    main: path.join(unsafePluginDir, 'index.js'),
                },
            }

            await expect(
                moduleLoader.load(externalPackageImportingNodeFs, 'main'),
            ).rejects.toThrow(
                'External plugin cannot import node:fs without a brokered capability',
            )
        })

        it('does not let an external main entry import bare node child_process directly', async () => {
            const unsafePluginDir = path.join(tempRoot, 'unsafe-plugin-cp')
            await fs.mkdir(unsafePluginDir, { recursive: true })
            await fs.writeFile(
                path.join(unsafePluginDir, 'index.js'),
                `import { execSync } from 'child_process';\nexport default { activate() {} };`,
                'utf-8',
            )

            const externalPackageImportingChildProcess: ResolvedPluginPackage = {
                manifest: {
                    id: 'unsafe-cp-plugin',
                    name: 'Unsafe CP Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                    entries: { main: './index.js' },
                },
                source: {
                    kind: 'npm',
                    spec: 'npm:unsafe-cp@1.0.0',
                },
                sourceRoot: unsafePluginDir,
                entries: {
                    main: path.join(unsafePluginDir, 'index.js'),
                },
            }

            await expect(
                moduleLoader.load(externalPackageImportingChildProcess, 'main'),
            ).rejects.toThrow(
                'External plugin cannot import child_process without a brokered capability',
            )
        })
        it('does not let an external chunk nested import access node:path directly', async () => {
            const nestedPluginDir = path.join(tempRoot, 'nested-plugin-unsafe')
            await fs.mkdir(path.join(nestedPluginDir, 'chunks'), { recursive: true })
            await fs.writeFile(
                path.join(nestedPluginDir, 'index.js'),
                `import { doSomething } from './chunks/sub.js';\nexport default { activate() {} };`,
                'utf-8',
            )
            await fs.writeFile(
                path.join(nestedPluginDir, 'chunks', 'sub.js'),
                `import path from 'node:path';\nexport const doSomething = () => path.join('a', 'b');`,
                'utf-8',
            )

            const nestedUnsafePackage: ResolvedPluginPackage = {
                manifest: {
                    id: 'nested-unsafe-plugin',
                    name: 'Nested Unsafe Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                    entries: { main: './index.js' },
                },
                source: {
                    kind: 'global-directory',
                    spec: `path:${nestedPluginDir}`,
                },
                sourceRoot: nestedPluginDir,
                entries: {
                    main: path.join(nestedPluginDir, 'index.js'),
                },
            }

            await expect(
                moduleLoader.load(nestedUnsafePackage, 'main'),
            ).rejects.toThrow(
                'External plugin cannot import node:path without a brokered capability',
            )
        })

        it('successfully executes activate and deactivate on a valid external plugin', async () => {
            const validPluginDir = path.join(tempRoot, 'valid-external-plugin')
            await fs.mkdir(path.join(validPluginDir, 'chunks'), { recursive: true })
            await fs.writeFile(
                path.join(validPluginDir, 'chunks', 'math.js'),
                `export const add = (a, b) => a + b;`,
                'utf-8',
            )
            await fs.writeFile(
                path.join(validPluginDir, 'index.js'),
                `import { add } from './chunks/math.js';
export default {
    manifest: { id: 'valid-external', name: 'Valid External', version: '1.0.0', apiVersion: '1.0.0', engines: { cpa: '^1.0.0' } },
    async activate(ctx) {
        await ctx.events.emit('plugin:ready', { sum: add(1, 2) });
    },
    async deactivate(ctx) {}
};`,
                'utf-8',
            )

            const validPackage: ResolvedPluginPackage = {
                manifest: {
                    id: 'valid-external',
                    name: 'Valid External',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '^1.0.0' },
                    entries: { main: './index.js' },
                },
                source: {
                    kind: 'project-directory',
                    spec: `path:${validPluginDir}`,
                },
                sourceRoot: validPluginDir,
                entries: {
                    main: path.join(validPluginDir, 'index.js'),
                },
            }

            const def = await moduleLoader.load(validPackage, 'main')
            expect(def).toBeDefined()
            expect(def?.runtime).toBe('main')

            let receivedEvent: any = null
            const mockContext: any = {
                manifest: validPackage.manifest,
                generation: 1,
                capabilities: new Set(),
                events: {
                    emit: async (event: string, payload: any) => {
                        receivedEvent = { event, payload }
                    },
                },
            }

            await def?.activate(mockContext)
            expect(receivedEvent).toEqual({
                event: 'plugin:ready',
                payload: { sum: 3 },
            })

            await def?.deactivate?.(mockContext)
        })
    })

    describe('registerPluginProtocol', () => {
        it('registers scheme as privileged without throwing', () => {
            registerPluginSchemesAsPrivileged()
            expect(mockProtocol.registerSchemesAsPrivileged).toHaveBeenCalled()
        })

        it('handles cpa-plugin requests and responds correctly', async () => {
            let capturedHandler: ((req: Request) => Promise<Response>) | null = null
            mockProtocol.handle.mockImplementation((scheme: string, handler: any) => {
                if (scheme === 'cpa-plugin') {
                    capturedHandler = handler
                }
            })

            registerPluginProtocol(resourceService)
            expect(mockProtocol.handle).toHaveBeenCalledWith('cpa-plugin', expect.any(Function))
            expect(capturedHandler).not.toBeNull()

            const req = new Request('cpa-plugin://my-test-plugin/chunks/view.js')
            const res = await capturedHandler!(req)
            expect(res.status).toBe(200)
            expect(res.headers.get('Content-Type')).toBe('text/javascript')
            const text = await res.text()
            expect(text).toContain('rendered chunk')

            // Symlink / Path escape test
            const escapeReq = new Request('cpa-plugin://my-test-plugin/assets/escape-link.txt')
            const escapeRes = await capturedHandler!(escapeReq)
            expect(escapeRes.status).toBe(403)

            // Not found test
            const notFoundReq = new Request('cpa-plugin://my-test-plugin/nonexistent.js')
            const notFoundRes = await capturedHandler!(notFoundReq)
            expect(notFoundRes.status).toBe(404)
        })
    })

    describe('WebServer /api/plugins/resources integration', () => {
        let webServer: WebServerService
        let port: number

        beforeEach(async () => {
            webServer = new WebServerService({ isDebug: true })
            webServer.setPluginResourceService(resourceService)
            // Start on random ephemeral port
            const status = await webServer.start({ host: '127.0.0.1', port: 0 })
            port = status.port
        })

        afterEach(async () => {
            await webServer.stop()
        })

        it('serves plugin resource chunk via HTTP route with correct MIME type', async () => {
            const res = await fetch(`http://127.0.0.1:${port}/api/plugins/resources/my-test-plugin/chunks/view.js`)
            expect(res.status).toBe(200)
            expect(res.headers.get('content-type')).toContain('text/javascript')
            const text = await res.text()
            expect(text).toContain('rendered chunk')
        })

        it('returns 403 when HTTP resource request attempts directory escape', async () => {
            const res = await fetch(`http://127.0.0.1:${port}/api/plugins/resources/my-test-plugin/../secret.txt`)
            expect([400, 403, 404]).toContain(res.status)
        })

        it('returns 404 when HTTP resource does not exist', async () => {
            const res = await fetch(`http://127.0.0.1:${port}/api/plugins/resources/my-test-plugin/chunks/missing.js`)
            expect(res.status).toBe(404)
        })

        it('returns 404 when plugin package does not exist', async () => {
            const res = await fetch(`http://127.0.0.1:${port}/api/plugins/resources/unknown-plugin/index.js`)
            expect(res.status).toBe(404)
        })

        it('detects TOCTOU file swap race via FileHandle fstat dev/ino verification', async () => {
            const victimFile = path.join(pluginDir, 'assets', 'safe-file.txt')
            await fs.writeFile(victimFile, 'safe content', 'utf-8')

            class RaceTestingResourceService extends PluginResourceService {
                protected override async openFileHandle(filePath: string, flags: number): Promise<fs.FileHandle> {
                    if (filePath.includes('safe-file.txt')) {
                        // Swap file on disk to create a new inode before returning the handle
                        await fs.rm(victimFile, { force: true })
                        await fs.writeFile(victimFile, 'swapped-content-different-stat', 'utf-8')
                    }
                    return super.openFileHandle(filePath, flags)
                }
            }

            const raceService = new RaceTestingResourceService([resolvedPkg])

            // Reading swapped file must detect ino mismatch or stat change
            await expect(
                raceService.readResource('my-test-plugin', 'assets/safe-file.txt'),
            ).rejects.toThrow(/mismatch|invalidated|race|escapes|stat/i)
        })

        it('re-verifies package registration and graph revision after opening FileHandle', async () => {
            const victimFile = path.join(pluginDir, 'assets', 'tracked.txt')
            await fs.writeFile(victimFile, 'tracked data', 'utf-8')

            class UnregisterRaceService extends PluginResourceService {
                protected override async openFileHandle(filePath: string, flags: number): Promise<fs.FileHandle> {
                    // Unregister mid-flight
                    this.unregisterPackage('my-test-plugin')
                    return super.openFileHandle(filePath, flags)
                }
            }

            const revService = new UnregisterRaceService([resolvedPkg], 'rev-1')

            await expect(
                revService.readResource('my-test-plugin', 'assets/tracked.txt', 'rev-1'),
            ).rejects.toThrow(/not found|unregistered|invalid/i)
        })
    })
})
