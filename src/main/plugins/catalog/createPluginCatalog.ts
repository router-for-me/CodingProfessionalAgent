import * as path from 'node:path'
import type { ResolvedPluginPackage } from '@cpa/plugin-api'
import type { CreatePluginCatalogOptions } from '../config/pluginSourceConfig.js'
import { getAppConfigDirName } from '../../utils/version.js'
import { BundledPluginSource } from '../sources/BundledPluginSource.js'
import { DirectoryPluginSource } from '../sources/DirectoryPluginSource.js'
import { ConfiguredPluginSource } from '../sources/ConfiguredPluginSource.js'
import { NpmPluginSource } from '../sources/NpmPluginSource.js'
import { ManagedNpmInstaller } from '../packages/ManagedNpmInstaller.js'

export type { CreatePluginCatalogOptions }


/**
 * Discover and normalize all plugin packages across all tiers in strict precedence order:
 * 1. Global Config (`global-config`)
 * 2. Global Directory (`global-directory`: `~/.coding-professional-agent/plugins/`)
 * 3. Managed NPM (`npm`)
 * 4. Bundled (`bundled`)
 *
 * Duplicate IDs within the same priority tier throw `DuplicatePluginSourceError`.
 * Higher priority tiers override lower priority tiers cleanly without error.
 */
export async function createPluginCatalog(
    options: CreatePluginCatalogOptions,
): Promise<readonly ResolvedPluginPackage[]> {
    const {
        homeDir,
        bundledPackages = [],
        globalConfig,
        globalConfigDir,
        npmInstaller,
        npmSources,
        npmSpecs,
        npmPackages,
    } = options

    const configDirName = options.configDirName || getAppConfigDirName(options.isDev)

    const installer =
        npmInstaller ??
        (homeDir && homeDir.trim().length > 0
            ? new ManagedNpmInstaller({
                  pluginsDir: path.join(
                      path.resolve(homeDir),
                      configDirName,
                      'plugins',
                  ),
              })
            : undefined)

    // Tier 1: Global Config
    let globalConfigPackages: ResolvedPluginPackage[] = []
    if (globalConfig?.sources && globalConfig.sources.length > 0) {
        const baseDir =
            globalConfigDir ??
            path.join(path.resolve(homeDir), configDirName)
        const source = new ConfiguredPluginSource({
            entries: globalConfig.sources,
            baseDir,
            kind: 'global-config',
            installer,
        })
        globalConfigPackages = await source.discover()
    }

    // Tier 2: Global Directory
    let globalDirPackages: ResolvedPluginPackage[] = []
    if (homeDir && homeDir.trim().length > 0) {
        const globalPluginsDir = path.join(
            path.resolve(homeDir),
            configDirName,
            'plugins',
        )
        const source = new DirectoryPluginSource({
            directory: globalPluginsDir,
            kind: 'global-directory',
        })
        globalDirPackages = await source.discover()
    }

    // Tier 3: Managed NPM
    let npmDiscoveredPackages: ResolvedPluginPackage[] = []
    if (npmPackages && npmPackages.length > 0) {
        npmDiscoveredPackages = [...npmPackages]
    } else if (installer && (npmSources || npmSpecs)) {
        const source = new NpmPluginSource({
            installer,
            entries: npmSources ? [...npmSources] : undefined,
            specs: npmSpecs ? [...npmSpecs] : undefined,
            kind: 'npm',
        })
        npmDiscoveredPackages = await source.discover()
    }

    // Tier 4: Bundled
    const bundledSource = new BundledPluginSource(bundledPackages)
    const discoveredBundled = await bundledSource.discover()

    // Merge tiers according to fixed precedence order:
    // Global Config > Global Directory > Managed NPM > Bundled
    const resolvedMap = new Map<string, ResolvedPluginPackage>()
    const tiers = [
        globalConfigPackages,
        globalDirPackages,
        npmDiscoveredPackages,
        discoveredBundled,
    ]

    for (const tierPackages of tiers) {
        for (const pkg of tierPackages) {
            if (!resolvedMap.has(pkg.manifest.id)) {
                resolvedMap.set(pkg.manifest.id, pkg)
            }
        }
    }

    return Object.freeze(Array.from(resolvedMap.values()))
}
