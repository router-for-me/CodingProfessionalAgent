import type {
    PluginEntryDefinition,
    PluginEntryKind,
    ResolvedPluginPackage,
} from '@cpa/plugin-api'
import { isNativeRuntime } from '@/application/services/hostTransport'

export interface RendererPluginModuleLoaderOptions {
    isElectron?: boolean
    baseUrl?: string
    importModule?: (url: string) => Promise<unknown>
    sharedModules?: Record<string, unknown>
}

function normalizePath(p: string): string {
    return p.replace(/\\/g, '/')
}

function isAbsolutePath(p: string): boolean {
    const norm = normalizePath(p)
    return norm.startsWith('/') || /^[a-zA-Z]:\//.test(norm)
}

function joinPath(root: string, rel: string): string {
    const cleanRoot = normalizePath(root).replace(/\/+$/, '')
    const cleanRel = normalizePath(rel).replace(/^\.?\/+/, '')
    return `${cleanRoot}/${cleanRel}`
}

function resolveDiskPath(sourceRoot: string | undefined, entry: string): string {
    if (isAbsolutePath(entry)) {
        return normalizePath(entry)
    }
    if (!sourceRoot) {
        return normalizePath(entry)
    }
    return joinPath(sourceRoot, entry)
}

function convertToFileUrl(filePath: string): string {
    const norm = normalizePath(filePath)
    if (norm.startsWith('file://')) {
        return norm
    }
    if (norm.startsWith('/')) {
        return `file://${norm}`
    }
    return `file:///${norm}`
}

/**
 * Renderer and Agent runtime plugin module loader.
 * Resolves entry points via cpa-plugin:// scheme in Electron or /api/plugins/resources/ in Browser.
 */
export class RendererPluginModuleLoader {
    private readonly isElectron: boolean
    private readonly baseUrl: string
    private readonly importModuleFn: (url: string) => Promise<unknown>

    constructor(options?: RendererPluginModuleLoaderOptions) {
        this.isElectron =
            options?.isElectron ??
            (typeof window !== 'undefined' &&
                (isNativeRuntime() ||
                    navigator?.userAgent?.toLowerCase()?.includes('electron')))
        this.baseUrl = (options?.baseUrl ?? '').replace(/\/+$/, '')
        this.importModuleFn =
            options?.importModule ??
            (async (url: string) => {
                /* @vite-ignore */
                return import(/* @vite-ignore */ url)
            })
    }

    /**
     * Resolves the entry URI for a package and runtime kind.
     * In production Electron / Web environments, this never leaks local file system paths.
     */
    resolveEntryUrl(
        pluginPackage: ResolvedPluginPackage,
        runtime: PluginEntryKind,
    ): string | undefined {
        const rawEntry = pluginPackage.entries[runtime]
        if (!rawEntry) {
            return undefined
        }

        let relPath = rawEntry
        if (
            pluginPackage.sourceRoot &&
            rawEntry.startsWith(pluginPackage.sourceRoot)
        ) {
            relPath = rawEntry.slice(pluginPackage.sourceRoot.length)
        }
        relPath = relPath.replace(/^(\/|\\)+/, '').replace(/^\.\//, '')

        const encodedId = encodeURIComponent(pluginPackage.manifest.id)

        if (this.isElectron) {
            return `cpa-plugin://${encodedId}/${relPath}`
        }

        const prefix = this.baseUrl ? this.baseUrl : ''
        return `${prefix}/api/plugins/resources/${encodedId}/${relPath}`
    }

    /**
     * Load and validate a plugin entry definition for the specified runtime.
     */
    async load(
        pluginPackage: ResolvedPluginPackage,
        runtime: PluginEntryKind,
    ): Promise<PluginEntryDefinition | undefined> {
        const rawEntry = pluginPackage.entries[runtime]
        if (!rawEntry) {
            return undefined
        }

        const entryUrl = this.resolveEntryUrl(pluginPackage, runtime)
        if (!entryUrl) {
            return undefined
        }

        let rawModule: unknown

        // In Node.js testing harness (without browser/Electron protocol handler), load disk file directly with cache-busting
        const isNodeHarness =
            typeof process !== 'undefined' &&
            Boolean(process.versions?.node) &&
            (typeof window === 'undefined' || typeof (window as any).document === 'undefined' || !isNativeRuntime())

        if (isNodeHarness && (!this.baseUrl && !this.isElectron)) {
            const diskPath = resolveDiskPath(pluginPackage.sourceRoot, rawEntry)
            const cacheBust = `${Date.now()}_${Math.random().toString(36).slice(2)}`
            const fileUrl = `${convertToFileUrl(diskPath)}?rev=${cacheBust}`
            rawModule = await this.importModuleFn(fileUrl)
        } else {
            try {
                rawModule = await this.importModuleFn(entryUrl)
            } catch (directImportErr: any) {
                // If direct dynamic import fails (e.g. Chromium rejects custom scheme dynamic imports),
                // fetch the module content and load via Blob URL (universally supported for ES modules).
                if (
                    typeof fetch === 'function' &&
                    typeof URL !== 'undefined' &&
                    typeof URL.createObjectURL === 'function' &&
                    typeof Blob !== 'undefined'
                ) {
                    const response = await fetch(entryUrl)
                    if (!response.ok) {
                        const detail = await response.text().catch(() => '')
                        const err = new Error(
                            `Failed to fetch plugin module from '${entryUrl}': HTTP ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`,
                        )
                        ;(err as any).cause = directImportErr
                        throw err
                    }
                    const sourceCode = await response.text()
                    const blob = new Blob([sourceCode], { type: 'text/javascript' })
                    const blobUrl = URL.createObjectURL(blob)
                    try {
                        rawModule = await this.importModuleFn(blobUrl)
                    } finally {
                        URL.revokeObjectURL(blobUrl)
                    }
                } else {
                    throw directImportErr
                }
            }
        }

        if (!rawModule || typeof rawModule !== 'object') {
            throw new Error('Invalid plugin module: module must be a non-null object')
        }

        const candidate =
            (rawModule as Record<string, unknown>).default ??
            (rawModule as Record<string, unknown>).entry ??
            rawModule

        if (!candidate || typeof candidate !== 'object') {
            throw new Error('Invalid plugin module: module must be a non-null object')
        }

        const pluginDef = candidate as Partial<PluginEntryDefinition>

        if (typeof pluginDef.activate !== 'function') {
            throw new Error('Plugin module must export an entry with an activate function')
        }

        return {
            runtime: pluginDef.runtime ?? runtime,
            activate: pluginDef.activate,
            deactivate: pluginDef.deactivate,
        }
    }
}
