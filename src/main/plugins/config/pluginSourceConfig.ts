import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { CapabilityId, PluginSourceSpec, ResolvedPluginPackage } from '@cpa/plugin-api'
import type { ManagedNpmInstaller } from '../packages/ManagedNpmInstaller.js'
import { getAppConfigDirName } from '../../utils/version.js'

export interface PluginSourceConfigEntry {
    source: PluginSourceSpec | string
    enabled?: boolean
    capabilities?: CapabilityId[]
}

export interface PluginSourceConfig {
    version?: number
    sources: PluginSourceConfigEntry[]
    disabled?: string[]
}

export interface ConfigFileMutation {
    targetPath: string
    tempPath: string
    oldContent: string | null
    oldHash: string | null
    newContent: string
    newHash: string
}

export interface PluginGraphJournal {
    transactionId: string
    status: 'prepared' | 'committed'
    candidateRevision: string
    generation: number
    timestamp: number
    files: ConfigFileMutation[]
}

export interface PrepareDurableConfigOptions {
    homeDir: string
    projectPath?: string
    globalConfig: PluginSourceConfig
    projectConfig?: PluginSourceConfig
    candidateRevision: string
    generation: number
    transactionId?: string
    configDirName?: string
    isDev?: boolean
}

export interface CreatePluginCatalogOptions {
    projectPath?: string
    homeDir: string
    bundledPackages: readonly ResolvedPluginPackage[]
    globalConfig: PluginSourceConfig
    projectConfig?: PluginSourceConfig
    projectConfigDir?: string
    globalConfigDir?: string
    npmInstaller?: ManagedNpmInstaller
    npmSources?: readonly PluginSourceConfigEntry[]
    npmSpecs?: readonly string[]
    npmPackages?: readonly ResolvedPluginPackage[]
    configDirName?: string
    isDev?: boolean
}

function sha256(content: string | Buffer): string {
    return createHash('sha256').update(content).digest('hex')
}

async function fsyncDirectory(dirPath: string): Promise<void> {
    try {
        const handle = await fs.open(dirPath, 'r')
        try {
            await handle.sync()
        } finally {
            await handle.close()
        }
    } catch {
        // Directory fsync not supported on all platforms; ignore
    }
}

async function writeAndSyncFile(filePath: string, content: string): Promise<void> {
    const handle = await fs.open(filePath, 'w')
    try {
        await handle.writeFile(content, 'utf-8')
        await handle.sync()
    } finally {
        await handle.close()
    }
}

/**
 * Normalize an arbitrary JSON value into a valid PluginSourceConfig object.
 */
export function normalizePluginSourceConfig(raw: unknown): PluginSourceConfig {
    if (!raw || typeof raw !== 'object') {
        return { version: 1, sources: [], disabled: [] }
    }

    const obj = raw as Record<string, unknown>

    let rawSources: unknown
    let rawDisabled: unknown

    if (Array.isArray(obj.sources)) {
        rawSources = obj.sources
    } else if (Array.isArray(raw)) {
        rawSources = raw
    } else if (
        obj.plugins &&
        typeof obj.plugins === 'object' &&
        Array.isArray((obj.plugins as Record<string, unknown>).sources)
    ) {
        rawSources = (obj.plugins as Record<string, unknown>).sources
        rawDisabled = (obj.plugins as Record<string, unknown>).disabled
    } else if (Array.isArray(obj.plugins)) {
        rawSources = obj.plugins
    } else {
        rawSources = []
    }

    if (rawDisabled === undefined && Array.isArray(obj.disabled)) {
        rawDisabled = obj.disabled
    }

    const sources: PluginSourceConfigEntry[] = []
    for (const item of rawSources as unknown[]) {
        if (!item || typeof item !== 'object') {
            continue
        }
        const itemObj = item as Record<string, unknown>
        if (typeof itemObj.source === 'string' && itemObj.source.trim().length > 0) {
            const entry: PluginSourceConfigEntry = {
                source: itemObj.source.trim() as PluginSourceSpec,
            }
            if (typeof itemObj.enabled === 'boolean') {
                entry.enabled = itemObj.enabled
            }
            if (Array.isArray(itemObj.capabilities)) {
                entry.capabilities = itemObj.capabilities.filter(
                    (c): c is CapabilityId => typeof c === 'string' && c.trim().length > 0,
                )
            }
            sources.push(entry)
        }
    }

    const disabled: string[] = []
    if (Array.isArray(rawDisabled)) {
        for (const d of rawDisabled) {
            if (typeof d === 'string' && d.trim().length > 0) {
                disabled.push(d.trim())
            }
        }
    }

    return {
        version: typeof obj.version === 'number' ? obj.version : 1,
        sources,
        disabled,
    }
}

/**
 * Load project plugin configuration from `<project>/.cpa/plugins.json`.
 * Returns `undefined` if the file does not exist.
 */
export async function loadProjectPluginConfig(
    projectPath: string,
): Promise<PluginSourceConfig | undefined> {
    if (!projectPath || typeof projectPath !== 'string' || projectPath.trim().length === 0) {
        return undefined
    }

    const configPath = path.join(path.resolve(projectPath), '.cpa', 'plugins.json')
    try {
        const content = await fs.readFile(configPath, 'utf-8')
        const parsed = JSON.parse(content)
        return normalizePluginSourceConfig(parsed)
    } catch (err: any) {
        if (err?.code === 'ENOENT') {
            return undefined
        }
        return { version: 1, sources: [], disabled: [] }
    }
}

/**
 * Atomically save project plugin configuration to `<project>/.cpa/plugins.json`.
 */
export async function saveProjectPluginConfig(
    projectPath: string,
    config: PluginSourceConfig,
): Promise<void> {
    if (!projectPath || typeof projectPath !== 'string' || projectPath.trim().length === 0) {
        return
    }

    const targetDir = path.join(path.resolve(projectPath), '.cpa')
    await fs.mkdir(targetDir, { recursive: true })

    const configPath = path.join(targetDir, 'plugins.json')
    const tempPath = path.join(
        targetDir,
        `.plugins.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    )

    const payload = {
        version: 1,
        sources: config.sources,
        disabled: config.disabled ?? [],
    }

    const content = JSON.stringify(payload, null, 2) + '\n'
    await writeAndSyncFile(tempPath, content)
    await fs.rename(tempPath, configPath)
    await fsyncDirectory(targetDir)
}

/**
 * Load global plugin configuration from `~/.coding-professional-agent/settings.json`.
 */
export async function loadGlobalPluginConfig(
    homeDir: string,
    configDirName = getAppConfigDirName(),
): Promise<PluginSourceConfig> {
    const settingsPath = path.join(
        path.resolve(homeDir),
        configDirName,
        'settings.json',
    )
    try {
        const content = await fs.readFile(settingsPath, 'utf-8')
        const parsed = JSON.parse(content)
        if (parsed && typeof parsed === 'object') {
            if (parsed.plugins && typeof parsed.plugins === 'object') {
                return normalizePluginSourceConfig(parsed.plugins)
            }
            if (Array.isArray(parsed.pluginSources)) {
                return normalizePluginSourceConfig({ sources: parsed.pluginSources })
            }
        }
        return { version: 1, sources: [], disabled: [] }
    } catch {
        return { version: 1, sources: [], disabled: [] }
    }
}

/**
 * Atomically save global plugin configuration into `~/.coding-professional-agent/settings.json`.
 */
export async function saveGlobalPluginConfig(
    homeDir: string,
    config: PluginSourceConfig,
    configDirName = getAppConfigDirName(),
): Promise<void> {
    if (!homeDir || typeof homeDir !== 'string' || homeDir.trim().length === 0) {
        return
    }

    const baseDir = path.join(path.resolve(homeDir), configDirName)
    await fs.mkdir(baseDir, { recursive: true })

    const settingsPath = path.join(baseDir, 'settings.json')
    let currentSettings: Record<string, unknown> = {}

    try {
        const content = await fs.readFile(settingsPath, 'utf-8')
        const parsed = JSON.parse(content)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            currentSettings = parsed as Record<string, unknown>
        }
    } catch {
        currentSettings = {}
    }

    currentSettings.plugins = {
        version: 1,
        sources: config.sources,
        disabled: config.disabled ?? [],
    }

    const tempPath = path.join(
        baseDir,
        `.settings.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    )

    const content = JSON.stringify(currentSettings, null, 2) + '\n'
    await writeAndSyncFile(tempPath, content)
    await fs.rename(tempPath, settingsPath)
    await fsyncDirectory(baseDir)
}

/**
 * Durably prepares candidate configuration files on disk, writing new contents to temporary files,
 * fsyncing all file handles, and recording a transaction journal with old/new contents and SHA256 hashes.
 * If any write or sync fails, temp files are cleaned up and an error is thrown without touching runtime.
 */
export async function prepareDurableConfig(
    options: PrepareDurableConfigOptions,
): Promise<PluginGraphJournal> {
    const { homeDir, projectPath, globalConfig, projectConfig, candidateRevision, generation } =
        options
    const transactionId =
        options.transactionId ??
        `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const configDirName = options.configDirName || getAppConfigDirName(options.isDev)
    const globalBaseDir = path.join(path.resolve(homeDir), configDirName)
    await fs.mkdir(globalBaseDir, { recursive: true })

    const journalPath = path.join(globalBaseDir, 'plugin-graph-journal.json')
    const files: ConfigFileMutation[] = []
    const createdTempPaths: string[] = []

    try {
        // 1. Prepare global settings file mutation
        const settingsPath = path.join(globalBaseDir, 'settings.json')
        let oldSettingsContent: string | null = null
        let currentSettings: Record<string, unknown> = {}

        try {
            oldSettingsContent = await fs.readFile(settingsPath, 'utf-8')
            const parsed = JSON.parse(oldSettingsContent)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                currentSettings = parsed as Record<string, unknown>
            }
        } catch {
            oldSettingsContent = null
            currentSettings = {}
        }

        currentSettings.plugins = {
            version: 1,
            sources: globalConfig.sources,
            disabled: globalConfig.disabled ?? [],
        }

        const newSettingsContent = JSON.stringify(currentSettings, null, 2) + '\n'
        const globalTempPath = path.join(
            globalBaseDir,
            `.settings.tmp-${transactionId}-${Math.random().toString(36).slice(2, 8)}`,
        )

        await writeAndSyncFile(globalTempPath, newSettingsContent)
        createdTempPaths.push(globalTempPath)

        files.push({
            targetPath: settingsPath,
            tempPath: globalTempPath,
            oldContent: oldSettingsContent,
            oldHash: oldSettingsContent ? sha256(oldSettingsContent) : null,
            newContent: newSettingsContent,
            newHash: sha256(newSettingsContent),
        })

        // 2. Prepare project config file mutation if projectPath is set
        if (projectPath && projectConfig) {
            const projBaseDir = path.join(path.resolve(projectPath), '.cpa')
            await fs.mkdir(projBaseDir, { recursive: true })

            const projConfigPath = path.join(projBaseDir, 'plugins.json')
            let oldProjContent: string | null = null
            try {
                oldProjContent = await fs.readFile(projConfigPath, 'utf-8')
            } catch {
                oldProjContent = null
            }

            const projPayload = {
                version: 1,
                sources: projectConfig.sources,
                disabled: projectConfig.disabled ?? [],
            }
            const newProjContent = JSON.stringify(projPayload, null, 2) + '\n'
            const projTempPath = path.join(
                projBaseDir,
                `.plugins.tmp-${transactionId}-${Math.random().toString(36).slice(2, 8)}`,
            )

            await writeAndSyncFile(projTempPath, newProjContent)
            createdTempPaths.push(projTempPath)

            files.push({
                targetPath: projConfigPath,
                tempPath: projTempPath,
                oldContent: oldProjContent,
                oldHash: oldProjContent ? sha256(oldProjContent) : null,
                newContent: newProjContent,
                newHash: sha256(newProjContent),
            })
        }

        const journal: PluginGraphJournal = {
            transactionId,
            status: 'prepared',
            candidateRevision,
            generation,
            timestamp: Date.now(),
            files,
        }

        // 3. Atomically write journal file with status: 'prepared'
        const journalTempPath = path.join(
            globalBaseDir,
            `.plugin-graph-journal.tmp-${transactionId}-${Math.random().toString(36).slice(2, 8)}`,
        )
        await writeAndSyncFile(journalTempPath, JSON.stringify(journal, null, 2) + '\n')
        await fs.rename(journalTempPath, journalPath)
        await fsyncDirectory(globalBaseDir)

        return journal
    } catch (err) {
        // Cleanup any staged temp files on prepare failure
        for (const tempPath of createdTempPaths) {
            await fs.rm(tempPath, { force: true }).catch(() => {})
        }
        await fs.rm(journalPath, { force: true }).catch(() => {})
        throw err
    }
}

/**
 * Finalize durable config after successful runtime commit:
 * updates journal to status 'committed', atomically renames temporary files to target paths,
 * fsyncs directories, and removes the journal file.
 */
export async function finalizeDurableConfig(
    journal: PluginGraphJournal,
    homeDir: string,
    configDirName = getAppConfigDirName(),
): Promise<void> {
    const globalBaseDir = path.join(path.resolve(homeDir), configDirName)
    const journalPath = path.join(globalBaseDir, 'plugin-graph-journal.json')

    // 1. Mark journal as committed
    journal.status = 'committed'
    const journalTempPath = path.join(
        globalBaseDir,
        `.plugin-graph-journal.tmp-${journal.transactionId}-committed`,
    )
    await writeAndSyncFile(journalTempPath, JSON.stringify(journal, null, 2) + '\n')
    await fs.rename(journalTempPath, journalPath)
    await fsyncDirectory(globalBaseDir)

    // 2. Atomically rename prepared temp files to final target files
    for (const file of journal.files) {
        let tempExists = false
        try {
            await fs.stat(file.tempPath)
            tempExists = true
        } catch {
            tempExists = false
        }

        if (tempExists) {
            const targetDir = path.dirname(file.targetPath)
            await fs.mkdir(targetDir, { recursive: true })
            await fs.rename(file.tempPath, file.targetPath)
            await fsyncDirectory(targetDir)
        } else {
            // If temp does not exist, write target directly if content differs
            let currentTargetContent = ''
            try {
                currentTargetContent = await fs.readFile(file.targetPath, 'utf-8')
            } catch {
                currentTargetContent = ''
            }
            if (sha256(currentTargetContent) !== file.newHash) {
                const targetDir = path.dirname(file.targetPath)
                await fs.mkdir(targetDir, { recursive: true })
                const recoveryTemp = path.join(
                    targetDir,
                    `.recovery.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                )
                await writeAndSyncFile(recoveryTemp, file.newContent)
                await fs.rename(recoveryTemp, file.targetPath)
                await fsyncDirectory(targetDir)
            }
        }
    }

    // 3. Remove completed journal file
    await fs.rm(journalPath, { force: true }).catch(() => {})
    await fsyncDirectory(globalBaseDir)
}

/**
 * Rollback durable config after runtime commit failure:
 * removes temporary files and restores original target files if needed, then deletes journal.
 */
export async function rollbackDurableConfig(
    journal: PluginGraphJournal,
    homeDir: string,
    configDirName = getAppConfigDirName(),
): Promise<void> {
    const globalBaseDir = path.join(path.resolve(homeDir), configDirName)
    const journalPath = path.join(globalBaseDir, 'plugin-graph-journal.json')

    for (const file of journal.files) {
        // Clean up staged temp file
        await fs.rm(file.tempPath, { force: true }).catch(() => {})

        // Restore original target file if target exists but differs from oldContent
        if (file.oldContent !== null) {
            let currentTargetContent = ''
            try {
                currentTargetContent = await fs.readFile(file.targetPath, 'utf-8')
            } catch {
                currentTargetContent = ''
            }
            if (sha256(currentTargetContent) !== file.oldHash) {
                const targetDir = path.dirname(file.targetPath)
                await fs.mkdir(targetDir, { recursive: true })
                const restoreTemp = path.join(
                    targetDir,
                    `.restore.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                )
                await writeAndSyncFile(restoreTemp, file.oldContent)
                await fs.rename(restoreTemp, file.targetPath)
                await fsyncDirectory(targetDir)
            }
        }
    }

    await fs.rm(journalPath, { force: true }).catch(() => {})
    await fsyncDirectory(globalBaseDir)
}

/**
 * Bootstrap crash recovery:
 * Inspects `plugin-graph-journal.json` upon startup:
 * - If journal status is 'committed': finalizes disk configs to candidate state.
 * - If journal status is 'prepared': rolls back temp files and preserves original config.
 */
export async function recoverFromJournal(
    homeDir: string,
    projectPath?: string,
): Promise<void> {
    if (!homeDir || typeof homeDir !== 'string' || homeDir.trim().length === 0) {
        return
    }

    const configDirName = getAppConfigDirName()
    const journalPath = path.join(
        path.resolve(homeDir),
        configDirName,
        'plugin-graph-journal.json',
    )

    let content: string
    try {
        content = await fs.readFile(journalPath, 'utf-8')
    } catch {
        return // No recovery journal found
    }

    let journal: PluginGraphJournal
    try {
        journal = JSON.parse(content)
    } catch {
        // Corrupted journal file: clean up and return
        await fs.rm(journalPath, { force: true }).catch(() => {})
        return
    }

    if (journal.status === 'committed') {
        await finalizeDurableConfig(journal, homeDir)
    } else {
        await rollbackDurableConfig(journal, homeDir)
    }
}
