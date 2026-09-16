import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PluginEntryDefinition, ResolvedPluginPackage } from '@cpa/plugin-api'
import { RendererPluginModuleLoader } from './RendererPluginModuleLoader'

describe('RendererPluginModuleLoader', () => {
    let mockPkg: ResolvedPluginPackage

    beforeEach(() => {
        mockPkg = {
            manifest: {
                id: 'sample-renderer-plugin',
                name: 'Sample Renderer Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '^1.0.0' },
                dependencies: {},
                capabilities: [],
                contributes: {},
                entries: {
                    renderer: './dist/renderer.js',
                    agent: './dist/agent.js',
                },
            },
            source: {
                kind: 'project-directory',
                spec: 'path:/workspace/sample-renderer-plugin',
            },
            sourceRoot: '/workspace/sample-renderer-plugin',
            entries: {
                renderer: '/workspace/sample-renderer-plugin/dist/renderer.js',
                agent: '/workspace/sample-renderer-plugin/dist/agent.js',
            },
        }
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('returns undefined if entry for the runtime kind is missing', async () => {
        const loader = new RendererPluginModuleLoader()
        const result = await loader.load(
            {
                ...mockPkg,
                entries: {},
            },
            'renderer',
        )
        expect(result).toBeUndefined()
    })

    it('constructs correct Electron cpa-plugin:// URL in Electron environment', () => {
        const loader = new RendererPluginModuleLoader({ isElectron: true })
        const url = loader.resolveEntryUrl(mockPkg, 'renderer')
        expect(url).toBe('cpa-plugin://sample-renderer-plugin/dist/renderer.js')
    })

    it('constructs correct Browser /api/plugins/resources/ URL in Browser environment', () => {
        const loader = new RendererPluginModuleLoader({ isElectron: false, baseUrl: 'http://localhost:18080' })
        const url = loader.resolveEntryUrl(mockPkg, 'renderer')
        expect(url).toBe('http://localhost:18080/api/plugins/resources/sample-renderer-plugin/dist/renderer.js')
    })

    it('loads and validates a valid PluginEntryDefinition module', async () => {
        const expectedPlugin: PluginEntryDefinition = {
            runtime: 'renderer',
            activate: vi.fn(),
            deactivate: vi.fn(),
        }

        const mockImportModule = vi.fn().mockResolvedValue({
            default: expectedPlugin,
        })

        const loader = new RendererPluginModuleLoader({
            importModule: mockImportModule,
        })

        const loaded = await loader.load(mockPkg, 'renderer')
        expect(loaded).toBeDefined()
        expect(loaded?.runtime).toBe('renderer')
        expect(loaded?.activate).toBe(expectedPlugin.activate)
        expect(mockImportModule).toHaveBeenCalledWith(
            expect.stringContaining('sample-renderer-plugin/dist/renderer.js'),
        )
    })

    it('loads direct PluginEntryDefinition export when default export is omitted', async () => {
        const expectedPlugin: PluginEntryDefinition = {
            runtime: 'renderer',
            activate: vi.fn(),
        }

        const mockImportModule = vi.fn().mockResolvedValue(expectedPlugin)

        const loader = new RendererPluginModuleLoader({
            importModule: mockImportModule,
        })

        const loaded = await loader.load(mockPkg, 'renderer')
        expect(loaded?.runtime).toBe('renderer')
        expect(loaded?.activate).toBe(expectedPlugin.activate)
    })

    it('throws error when loaded module is missing activate function', async () => {
        const invalidModule = {
            runtime: 'renderer',
        }

        const mockImportModule = vi.fn().mockResolvedValue(invalidModule)
        const loader = new RendererPluginModuleLoader({
            importModule: mockImportModule,
        })

        await expect(loader.load(mockPkg, 'renderer')).rejects.toThrow(
            'Plugin module must export an entry with an activate function',
        )
    })

    it('throws error when loaded module is null or invalid object', async () => {
        const mockImportModule = vi.fn().mockResolvedValue(null)
        const loader = new RendererPluginModuleLoader({
            importModule: mockImportModule,
        })

        await expect(loader.load(mockPkg, 'renderer')).rejects.toThrow(
            'Invalid plugin module: module must be a non-null object',
        )
    })

    it('handles relative subpaths inside sourceRoot properly', () => {
        const loader = new RendererPluginModuleLoader({ isElectron: true })
        const pkgWithNestedEntry: ResolvedPluginPackage = {
            ...mockPkg,
            entries: {
                renderer: '/workspace/sample-renderer-plugin/packages/ui/dist/bundle.js',
            },
        }

        const url = loader.resolveEntryUrl(pkgWithNestedEntry, 'renderer')
        expect(url).toBe('cpa-plugin://sample-renderer-plugin/packages/ui/dist/bundle.js')
    })

    it('supports dynamic chunk resolution via importModuleFn', async () => {
        const pluginWithChunk: PluginEntryDefinition = {
            runtime: 'renderer',
            activate: vi.fn(),
        }

        const mockImport = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes('chunk-main')) {
                return { default: pluginWithChunk }
            }
            throw new Error(`Cannot find module '${url}'`)
        })

        const loader = new RendererPluginModuleLoader({
            importModule: mockImport,
            isElectron: true,
        })

        const pkg: ResolvedPluginPackage = {
            ...mockPkg,
            entries: {
                renderer: './dist/chunk-main.js',
            },
        }

        const loaded = await loader.load(pkg, 'renderer')
        expect(loaded?.activate).toBe(pluginWithChunk.activate)
    })

    it('falls back to fetching content and loading via Blob URL when direct import fails', async () => {
        const expectedPlugin: PluginEntryDefinition = {
            runtime: 'agent',
            activate: vi.fn(),
            deactivate: vi.fn(),
        }

        const createObjectURLSpy = vi.fn().mockReturnValue('blob:http://localhost/mock-blob-uuid')
        const revokeObjectURLSpy = vi.fn()
        vi.stubGlobal('URL', {
            ...URL,
            createObjectURL: createObjectURLSpy,
            revokeObjectURL: revokeObjectURLSpy,
        })

        const fetchSpy = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => 'export default { runtime: "agent", activate() {} }',
        })
        vi.stubGlobal('fetch', fetchSpy)

        const mockImport = vi.fn().mockImplementation(async (url: string) => {
            if (url.startsWith('blob:')) {
                return { default: expectedPlugin }
            }
            throw new TypeError(`Failed to fetch dynamically imported module: ${url}`)
        })

        const loader = new RendererPluginModuleLoader({
            importModule: mockImport,
            isElectron: true,
        })

        const loaded = await loader.load(mockPkg, 'agent')
        expect(fetchSpy).toHaveBeenCalledWith('cpa-plugin://sample-renderer-plugin/dist/agent.js')
        expect(createObjectURLSpy).toHaveBeenCalled()
        expect(mockImport).toHaveBeenCalledWith('blob:http://localhost/mock-blob-uuid')
        expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:http://localhost/mock-blob-uuid')
        expect(loaded?.activate).toBe(expectedPlugin.activate)

        vi.unstubAllGlobals()
    })
})
