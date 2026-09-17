import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
    PluginDependencyError,
    resolvePackageCriticality,
    type PluginCriticality,
    type ResolvedPluginGraphDTO,
    type ResolvedPluginPackage,
} from '@cpa/plugin-api'
import {
    PluginCatalog,
    type ResolvedPluginGraph,
} from '@cpa/plugin-kernel'
import {
    createPluginCatalog,
    type CreatePluginCatalogOptions,
} from './createPluginCatalog.js'
import {
    loadGlobalPluginConfig,
    recoverFromJournal,
    type PluginSourceConfig,
    type PluginSourceConfigEntry,
} from '../config/pluginSourceConfig.js'
import { PluginResourceService } from '../resources/PluginResourceService.js'
import { loadPluginPackageFromDirectory } from '../sources/loadPluginPackage.js'
import { createResolvedPluginGraphDTO } from './graphRevision.js'
import type { ManagedNpmInstaller } from '../packages/ManagedNpmInstaller.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface BootstrapPluginGraphOptions {
    projectPath?: string
    homeDir?: string
    cpaVersion?: string
    bundledPackages?: readonly ResolvedPluginPackage[]
    bundledDir?: string
    globalConfig?: PluginSourceConfig
    globalConfigDir?: string
    npmInstaller?: ManagedNpmInstaller
    npmSources?: readonly PluginSourceConfigEntry[]
    npmSpecs?: readonly string[]
    npmPackages?: readonly ResolvedPluginPackage[]
    enabledPluginIds?: Iterable<string>
    resourceService?: PluginResourceService
}

export interface BootstrapPluginGraphResult {
    catalog: PluginCatalog
    graph: ResolvedPluginGraphDTO
    rawGraph: ResolvedPluginGraph
    resourceService: PluginResourceService
    resourcePackageIds: readonly string[]
}

/**
 * Resolve both source-tree and compiled application layouts without relying on cwd.
 */
export function getBundledPluginDirectoryCandidates(moduleDir: string): readonly string[] {
    return [
        path.resolve(moduleDir, '../../../../plugins/bundled'),
        path.resolve(moduleDir, '../../../../../plugins/bundled'),
    ]
}

/**
 * Discovers bundled plugin packages directly from disk if not explicitly supplied.
 */
export async function discoverBundledPluginPackages(
    bundledDir?: string,
): Promise<readonly ResolvedPluginPackage[]> {
    const candidateDirs = bundledDir
        ? [bundledDir]
        : [
              ...getBundledPluginDirectoryCandidates(__dirname),
              path.resolve(process.cwd(), 'plugins/bundled'),
          ]

    for (const dir of candidateDirs) {
        try {
            const stat = await fs.stat(dir)
            if (!stat.isDirectory()) {
                continue
            }

            const entries = await fs.readdir(dir, { withFileTypes: true })
            const packages: ResolvedPluginPackage[] = []

            for (const entry of entries) {
                if (!entry.isDirectory()) {
                    continue
                }

                const pluginDir = path.join(dir, entry.name)
                try {
                    const pkg = await loadPluginPackageFromDirectory({
                        directory: pluginDir,
                        sourceKind: 'bundled',
                        sourceSpec: `bundled:${entry.name}`,
                    })
                    packages.push(pkg)
                } catch {
                    // Skip folders that do not contain valid plugin manifests
                }
            }

            if (packages.length > 0) {
                return Object.freeze(packages)
            }
        } catch {
            // Try next candidate directory
        }
    }

    return Object.freeze([])
}

/**
 * Main process production bootstrap:
 * 1. Loads global plugin configuration;
 * 2. Creates unified PluginCatalog across all source tiers in precedence order;
 * 3. Resolves dependency graph and checks criticality failure semantics;
 * 4. Freezes immutable ResolvedPluginGraphDTO with canonical SHA-256 revision;
 * 5. Registers every resolved package in PluginResourceService.
 */
export async function bootstrapPluginGraph(
    options: BootstrapPluginGraphOptions = {},
): Promise<BootstrapPluginGraphResult> {
    const homeDir =
        options.homeDir && options.homeDir.trim().length > 0
            ? options.homeDir
            : typeof os.homedir === 'function'
              ? os.homedir()
              : ''
    const projectPath = options.projectPath
    const cpaVersion = options.cpaVersion ?? '1.0.0'

    // 0. Crash recovery from any pending transaction journal
    if (homeDir.length > 0) {
        await recoverFromJournal(homeDir)
    }

    // 1. Configs
    const globalConfig =
        options.globalConfig ??
        (homeDir.length > 0 ? await loadGlobalPluginConfig(homeDir) : { sources: [] })

    // 2. Bundled packages
    const bundledPackages =
        options.bundledPackages ?? (await discoverBundledPluginPackages(options.bundledDir))

    // 3. Multi-tier discovery
    const catalogOptions: CreatePluginCatalogOptions = {
        homeDir,
        bundledPackages,
        globalConfig,
        globalConfigDir: options.globalConfigDir,
        npmInstaller: options.npmInstaller,
        npmSources: options.npmSources,
        npmSpecs: options.npmSpecs,
        npmPackages: options.npmPackages,
    }

    const discoveredPackages = await createPluginCatalog(catalogOptions)

    // 4. Construct Catalog & Resolve Graph
    const disabledSet = new Set<string>()
    if (globalConfig?.disabled) {
        for (const id of globalConfig.disabled) {
            disabledSet.add(id)
        }
    }

    const initialEnabledList = options.enabledPluginIds
        ? Array.from(options.enabledPluginIds).filter((id) => !disabledSet.has(id))
        : discoveredPackages
              .map((p) => p.manifest.id)
              .filter((id) => !disabledSet.has(id))

    const catalog = new PluginCatalog({
        cpaVersion,
        packages: discoveredPackages,
        enabledPluginIds: initialEnabledList,
    })

    const rawGraph = catalog.resolveGraph()

    // 5. Criticality Enforcement
    for (const blocked of rawGraph.blocked) {
        const pkg = catalog.getPackage(blocked.pluginId)
        const criticality: PluginCriticality = pkg ? resolvePackageCriticality(pkg) : 'optional'
        if (criticality === 'platform' || criticality === 'required') {
            const reasonDetail = blocked.dependencyId ? ` (${blocked.dependencyId})` : ''
            throw new PluginDependencyError(
                `Critical plugin '${blocked.pluginId}' (${criticality}) failed to resolve: ${blocked.reason}${reasonDetail}`,
                { pluginId: blocked.pluginId },
            )
        }
    }

    // 6. Freeze Immutable Graph DTO
    const graphDTO = createResolvedPluginGraphDTO(rawGraph)

    // 7. Register Packages in PluginResourceService
    const resourceService = options.resourceService ?? new PluginResourceService()
    for (const pkg of rawGraph.activationOrder) {
        resourceService.registerPackage(pkg)
    }

    const resourcePackageIds = Object.freeze(rawGraph.activationOrder.map((p) => p.manifest.id))

    return {
        catalog,
        graph: graphDTO,
        rawGraph,
        resourceService,
        resourcePackageIds,
    }
}
