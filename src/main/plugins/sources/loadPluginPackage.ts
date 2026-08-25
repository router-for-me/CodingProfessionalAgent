import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
    PluginManifestError,
    type CapabilityId,
    type PluginEntryKind,
    type PluginManifest,
    type PluginSourceKind,
    type ResolvedPluginPackage,
} from '@cpa/plugin-api'
import { validatePluginManifest } from '@cpa/plugin-sdk'
import { validatePluginEntries } from './sourceRootGuard.js'

export interface LoadPluginOptions {
    directory: string
    sourceKind: PluginSourceKind
    sourceSpec: string
    overrideCapabilities?: CapabilityId[]
}

/**
 * Load and validate a plugin package from a directory on disk.
 * Canonicalizes sourceRoot and validates all declared entry paths.
 */
export async function loadPluginPackageFromDirectory(
    options: LoadPluginOptions,
): Promise<ResolvedPluginPackage> {
    const { directory, sourceKind, sourceSpec, overrideCapabilities } = options
    const realSourceRoot = await fs.realpath(directory)

    let rawManifest: Record<string, unknown> | null = null
    const manifestPath = path.join(realSourceRoot, 'manifest.json')
    const pkgPath = path.join(realSourceRoot, 'package.json')

    try {
        const manifestRaw = await fs.readFile(manifestPath, 'utf-8')
        rawManifest = JSON.parse(manifestRaw)
    } catch (manifestErr: any) {
        if (manifestErr?.code !== 'ENOENT') {
            throw new PluginManifestError(
                `Failed to parse manifest.json in '${directory}': ${manifestErr.message}`,
                { cause: manifestErr },
            )
        }

        // Fallback to package.json
        try {
            const pkgRaw = await fs.readFile(pkgPath, 'utf-8')
            const pkg = JSON.parse(pkgRaw)
            if (pkg && typeof pkg === 'object') {
                if (pkg.cpa && typeof pkg.cpa === 'object') {
                    rawManifest = {
                        id: pkg.cpa.id ?? pkg.name,
                        name: pkg.cpa.name ?? pkg.name,
                        version: pkg.cpa.version ?? pkg.version,
                        apiVersion: pkg.cpa.apiVersion ?? '1.0.0',
                        engines: pkg.cpa.engines ?? pkg.engines ?? { cpa: '^1.0.0' },
                        ...pkg,
                        ...pkg.cpa,
                    }
                } else if (pkg.id || pkg.apiVersion) {
                    rawManifest = pkg
                } else if (pkg.name && pkg.version) {
                    rawManifest = {
                        id: pkg.name,
                        name: pkg.name,
                        version: pkg.version,
                        apiVersion: '1.0.0',
                        engines: pkg.engines ?? { cpa: '^1.0.0' },
                        entries: pkg.main ? { main: pkg.main } : undefined,
                        description: pkg.description,
                        author: pkg.author,
                        homepage: pkg.homepage,
                        license: pkg.license,
                    }
                }
            }
        } catch (pkgErr: any) {
            if (pkgErr?.code !== 'ENOENT') {
                throw new PluginManifestError(
                    `Failed to parse package.json in '${directory}': ${pkgErr.message}`,
                    { cause: pkgErr },
                )
            }
        }
    }

    if (!rawManifest) {
        throw new PluginManifestError(
            `No valid manifest.json or package.json found in plugin directory: ${directory}`,
        )
    }

    if (rawManifest.dependencies === undefined) {
        rawManifest.dependencies = {}
    }
    if (rawManifest.capabilities === undefined) {
        rawManifest.capabilities = []
    }
    if (rawManifest.contributes === undefined) {
        rawManifest.contributes = {}
    }
    if (rawManifest.apiVersion === undefined) {
        rawManifest.apiVersion = '1.0.0'
    }
    if (rawManifest.engines === undefined) {
        rawManifest.engines = { cpa: '>=1.0.0' }
    }

    if (!rawManifest.entries || typeof rawManifest.entries !== 'object' || Object.keys(rawManifest.entries).length === 0) {
        const detected: Partial<Record<PluginEntryKind, string>> = {}
        for (const candidate of [
            'index.js',
            'main.js',
            'index.mjs',
            'dist/index.js',
            'dist/main.js',
        ]) {
            try {
                const candPath = path.join(realSourceRoot, candidate)
                const st = await fs.stat(candPath)
                if (st.isFile()) {
                    detected.main = `./${candidate}`
                    break
                }
            } catch {
                // Ignore missing candidate
            }
        }
        for (const candidate of ['renderer.js', 'dist/renderer.js']) {
            try {
                const candPath = path.join(realSourceRoot, candidate)
                const st = await fs.stat(candPath)
                if (st.isFile()) {
                    detected.renderer = `./${candidate}`
                    break
                }
            } catch {
                // Ignore missing candidate
            }
        }
        for (const candidate of ['agent.js', 'dist/agent.js']) {
            try {
                const candPath = path.join(realSourceRoot, candidate)
                const st = await fs.stat(candPath)
                if (st.isFile()) {
                    detected.agent = `./${candidate}`
                    break
                }
            } catch {
                // Ignore missing candidate
            }
        }
        rawManifest.entries = detected
    }

    const validation = validatePluginManifest(rawManifest)
    if (!validation.valid || !validation.manifest) {
        throw new PluginManifestError(
            `Invalid plugin manifest in '${directory}': ${validation.errors.join('; ')}`,
            {
                pluginId: typeof rawManifest?.id === 'string' ? rawManifest.id : undefined,
            },
        )
    }

    const manifest: PluginManifest = { ...validation.manifest }
    if (overrideCapabilities) {
        manifest.capabilities = overrideCapabilities
    }

    const declaredEntries: Partial<Record<PluginEntryKind, string>> = manifest.entries ?? {}
    const validatedEntries = await validatePluginEntries(realSourceRoot, declaredEntries)

    return {
        manifest,
        source: {
            kind: sourceKind,
            spec: sourceSpec,
        },
        sourceRoot: realSourceRoot,
        entries: validatedEntries,
    }
}
