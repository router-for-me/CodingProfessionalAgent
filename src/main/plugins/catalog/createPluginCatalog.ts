import * as path from 'node:path'
import type { ResolvedPluginPackage } from '@cpa/plugin-api'
import type { CreatePluginCatalogOptions } from '../config/pluginSourceConfig.js'
import { BundledPluginSource } from '../sources/BundledPluginSource.js'
import { DirectoryPluginSource } from '../sources/DirectoryPluginSource.js'
import { ConfiguredPluginSource } from '../sources/ConfiguredPluginSource.js'
import { NpmPluginSource } from '../sources/NpmPluginSource.js'
import { ManagedNpmInstaller } from '../packages/ManagedNpmInstaller.js'

export type { CreatePluginCatalogOptions }


/**
 * Discover and normalize all plugin packages across all tiers in strict precedence order:
 * 1. Project Config (`project-config`)
 * 2. Project Directory (`project-directory`: `<project>/.cpa/plugins/`)
 * 3. Global Config (`global-config`)
 * 4. Global Directory (`global-directory`: `~/.coding-professional-agent/plugins/`)
 * 5. Managed NPM (`npm`)
 * 6. Bundled (`bundled`)
 *
 * Duplicate IDs within the same priority tier throw `DuplicatePluginSourceError`.
 * Higher priority tiers override lower priority tiers cleanly without error.
 */
export async function createPluginCatalog(
    options: CreatePluginCatalogOptions,
): Promise<readonly ResolvedPluginPackage[]> {
    const {
        projectPath,
        homeDir,
        bundledPackages = [],
        globalConfig,
        projectConfig,
        projectConfigDir,
        globalConfigDir,
        npmInstaller,
        npmSources,
        npmSpecs,
        npmPackages,
    } = options

    const installer =
        npmInstaller ??
        (homeDir && homeDir.trim().length > 0
            ? new ManagedNpmInstaller({
                  pluginsDir: path.join(
                      path.resolve(homeDir),
                      '.coding-professional-agent',
                      'plugins',
                  ),
              })
            : undefined)

    // Tier 1: Project Config
    let projectConfigPackages: ResolvedPluginPackage[] = []
    if (projectConfig?.sources && projectConfig.sources.length > 0) {
        const baseDir =
            projectConfigDir ??
            (projectPath ? path.join(path.resolve(projectPath), '.cpa') : process.cwd())
        const source = new ConfiguredPluginSource({
            entries: projectConfig.sources,
            baseDir,
            kind: 'project-config',
            installer,
        })
        projectConfigPackages = await source.discover()
    }

    // Tier 2: Project Directory (<project>/.cpa/plugins)
    let projectDirPackages: ResolvedPluginPackage[] = []
    if (projectPath && projectPath.trim().length > 0) {
        const projectPluginsDir = path.join(path.resolve(projectPath), '.cpa', 'plugins')
        const source = new DirectoryPluginSource({
            directory: projectPluginsDir,
            kind: 'project-directory',
        })
        projectDirPackages = await source.discover()
    }

    // Tier 3: Global Config
    let globalConfigPackages: ResolvedPluginPackage[] = []
    if (globalConfig?.sources && globalConfig.sources.length > 0) {
        const baseDir =
            globalConfigDir ??
            path.join(path.resolve(homeDir), '.coding-professional-agent')
        const source = new ConfiguredPluginSource({
            entries: globalConfig.sources,
            baseDir,
            kind: 'global-config',
            installer,
        })
        globalConfigPackages = await source.discover()
    }

    // Tier 4: Global Directory (~/.coding-professional-agent/plugins)
    let globalDirPackages: ResolvedPluginPackage[] = []
    if (homeDir && homeDir.trim().length > 0) {
        const globalPluginsDir = path.join(
            path.resolve(homeDir),
            '.coding-professional-agent',
            'plugins',
        )
        const source = new DirectoryPluginSource({
            directory: globalPluginsDir,
            kind: 'global-directory',
        })
        globalDirPackages = await source.discover()
    }

    // Tier 5: Managed NPM
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

    // Tier 6: Bundled
    const bundledSource = new BundledPluginSource(bundledPackages)
    const discoveredBundled = await bundledSource.discover()

    // Merge tiers according to fixed precedence order:
    // Project Config > Project Directory > Global Config > Global Directory > Managed NPM > Bundled
    const resolvedMap = new Map<string, ResolvedPluginPackage>()
    const tiers = [
        projectConfigPackages,
        projectDirPackages,
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
