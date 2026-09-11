import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
    generateSavedShortcutsConfig,
    normalizeSavedShortcutsConfig,
    extractShortcutsOverrides,
    type SavedShortcutItem,
} from '../../../../src/shared/shortcuts.js'
import { DEFAULT_SHORTCUT_ITEMS } from '../shared/defaultShortcuts.js'
import {
    normalizePluginSourceConfig,
    type PluginSourceConfig,
} from '../../../../src/main/plugins/config/pluginSourceConfig.js'
import { getAppConfigDirName } from '@cpa/plugin-api'

export interface KVStoreServiceOptions {
    customPath?: string
    homeDir?: string
    getHomeDir?: () => string
    configDirName?: string
    isDev?: boolean
}

export const UI_SETTING_KEYS = [
    'theme',
    'themePreset',
    'accentColor',
    'backgroundColor',
    'foregroundColor',
    'uiFontFamily',
    'uiFontWeight',
    'codeFontFamily',
    'codeFontWeight',
    'contrast',
    'compactMode',
    'showLineNumbers',
    'wordWrap',
    'uiScale',
    'uiFontSize',
    'codeFontSize',
    'fontSmoothing',
    'showInMenuBar',
    'showBottomPanel',
    'terminalPosition',
] as const

export const UI_LAYOUT_KEYS = [
    'collapsedGroups',
    'sidebarCollapsed',
    'sidebarWidth',
    'rightSidebarCollapsed',
    'rightSidebarMaximized',
    'rightSidebarWidth',
    'pinnedSummaryVisible',
    'bottomPanelVisible',
    'bottomPanelHeight',
] as const

export class KVStoreService {
    private data: Record<string, unknown> = {}
    private projectsData: unknown = undefined
    private cachedModelsData: unknown = undefined
    private shortcutsData: SavedShortcutItem[] | undefined = undefined
    private uiData: unknown = undefined
    private scheduleData: unknown = undefined

    private storePath: string = ''
    private projectsPath: string = ''
    private cachedModelsPath: string = ''
    private shortcutsPath: string = ''
    private uiPath: string = ''
    private schedulePath: string = ''
    private isCustomPath = false

    private loaded = false
    private loadPromise: Promise<void> | null = null

    private dirtySettings = false
    private dirtyProjects = false
    private dirtyCachedModels = false
    private dirtyShortcuts = false
    private dirtyUi = false
    private dirtySchedule = false
    private savePromise: Promise<void> | null = null

    private readonly getHomeDir: () => string

    constructor(optionsOrPath?: string | KVStoreServiceOptions) {
        const options: KVStoreServiceOptions =
            typeof optionsOrPath === 'string' ? { customPath: optionsOrPath } : optionsOrPath ?? {}
        this.getHomeDir = options.getHomeDir ?? (() => os.homedir())

        if (options.customPath) {
            this.isCustomPath = true
            const dir = path.dirname(options.customPath)
            const base = path.basename(options.customPath)
            if (base === 'app-data.json') {
                this.storePath = path.join(dir, 'settings.json')
            } else {
                this.storePath = options.customPath
            }
            this.projectsPath = path.join(dir, 'projects.json')
            this.cachedModelsPath = path.join(dir, 'cached_models.json')
            this.shortcutsPath = path.join(dir, 'shortcuts.json')
            this.uiPath = path.join(dir, 'ui.json')
            this.schedulePath = path.join(dir, 'schedule.json')
        } else {
            const rawHome = options.homeDir || process.env.CPA_HOME || this.getHomeDir()
            const configDirName = options.configDirName || getAppConfigDirName(options.isDev)
            const isAlreadyAppDir =
                rawHome.endsWith(configDirName) ||
                path.basename(rawHome) === configDirName ||
                rawHome.endsWith('.coding-professional-agent') ||
                path.basename(rawHome) === '.coding-professional-agent' ||
                rawHome.endsWith('.coding-professional-agent-dev') ||
                path.basename(rawHome) === '.coding-professional-agent-dev'
            const appDir = isAlreadyAppDir ? rawHome : path.join(rawHome, configDirName)
            this.storePath = path.join(appDir, 'settings.json')
            this.projectsPath = path.join(appDir, 'projects.json')
            this.cachedModelsPath = path.join(appDir, 'cached_models.json')
            this.shortcutsPath = path.join(appDir, 'shortcuts.json')
            this.uiPath = path.join(appDir, 'ui.json')
            this.schedulePath = path.join(appDir, 'schedule.json')
            this.isCustomPath = false
        }
    }

    private getLegacyStorePath(): string | null {
        if (this.isCustomPath) return null
        const homeDir = this.getHomeDir()
        let userConfigDir: string
        if (process.platform === 'win32') {
            userConfigDir = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming')
        } else if (process.platform === 'darwin') {
            userConfigDir = path.join(homeDir, 'Library', 'Application Support')
        } else {
            userConfigDir = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config')
        }
        return path.join(userConfigDir, 'coding-professional-agent', 'app-data.json')
    }

    private getLegacyUiStorePath(): string | null {
        if (this.isCustomPath) return null
        const homeDir = this.getHomeDir()
        const localLegacy = path.join(homeDir, getAppConfigDirName(), 'window-state.json')
        if (fsSync.existsSync(localLegacy)) {
            return localLegacy
        }
        let userConfigDir: string
        if (process.platform === 'win32') {
            userConfigDir = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming')
        } else if (process.platform === 'darwin') {
            userConfigDir = path.join(homeDir, 'Library', 'Application Support')
        } else {
            userConfigDir = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config')
        }
        const legacyUiPath = path.join(userConfigDir, 'coding-professional-agent', 'ui.json')
        if (fsSync.existsSync(legacyUiPath)) {
            return legacyUiPath
        }
        return path.join(userConfigDir, 'coding-professional-agent', 'window-state.json')
    }

    private getLocalLegacyStorePath(): string {
        const dir = path.dirname(this.storePath)
        return path.join(dir, 'app-data.json')
    }

    private getLocalLegacyUiStorePath(): string {
        const dir = path.dirname(this.storePath)
        return path.join(dir, 'window-state.json')
    }

    private extractAndMigrateUiFields(obj: Record<string, unknown>): boolean {
        let mutated = false
        if (!this.uiData || typeof this.uiData !== 'object' || Array.isArray(this.uiData)) {
            this.uiData = {}
        }
        const uiObj = this.uiData as Record<string, unknown>

        if (obj.settings && typeof obj.settings === 'object' && !Array.isArray(obj.settings)) {
            const settingsObj = obj.settings as Record<string, unknown>
            for (const key of UI_SETTING_KEYS) {
                if (key in settingsObj) {
                    if (uiObj[key] === undefined) {
                        uiObj[key] = settingsObj[key]
                        this.dirtyUi = true
                    }
                    delete settingsObj[key]
                    mutated = true
                }
            }
        }

        for (const key of UI_SETTING_KEYS) {
            if (key in obj) {
                if (uiObj[key] === undefined) {
                    uiObj[key] = obj[key]
                    this.dirtyUi = true
                }
                delete obj[key]
                mutated = true
            }
        }

        for (const key of UI_LAYOUT_KEYS) {
            if (key in obj) {
                if (uiObj[key] === undefined) {
                    uiObj[key] = obj[key]
                    this.dirtyUi = true
                }
                delete obj[key]
                mutated = true
            }
        }

        return mutated
    }

    private extractAndSanitizeLegacyData(legacyContent: Record<string, unknown>): void {
        const appState = legacyContent['app-state']
        if (appState && typeof appState === 'object' && !Array.isArray(appState)) {
            const stateObj = { ...(appState as Record<string, unknown>) }
            if ('projects' in stateObj && this.projectsData === undefined) {
                this.projectsData = stateObj.projects
                this.dirtyProjects = true
                delete stateObj.projects
            }
            if ('cachedModels' in stateObj && this.cachedModelsData === undefined) {
                this.cachedModelsData = stateObj.cachedModels
                this.dirtyCachedModels = true
                delete stateObj.cachedModels
            }
            // Never migrate legacy sessions or message entries
            delete stateObj.sessions
            delete stateObj.messagesBySession
            delete stateObj.subAgents
            if (this.extractAndMigrateUiFields(stateObj)) {
                this.dirtyUi = true
            }
            this.data['app-state'] = stateObj
        }

        if ('projects' in legacyContent && this.projectsData === undefined) {
            this.projectsData = legacyContent.projects
            this.dirtyProjects = true
        }
        if (
            ('cachedModels' in legacyContent || 'cached_models' in legacyContent) &&
            this.cachedModelsData === undefined
        ) {
            this.cachedModelsData = legacyContent.cachedModels ?? legacyContent.cached_models
            this.dirtyCachedModels = true
        }
        if ('shortcuts' in legacyContent && this.shortcutsData === undefined) {
            this.shortcutsData = normalizeSavedShortcutsConfig(legacyContent.shortcuts, DEFAULT_SHORTCUT_ITEMS)
            this.dirtyShortcuts = true
        }

        for (const [k, v] of Object.entries(legacyContent)) {
            if (k !== 'projects' && k !== 'cachedModels' && k !== 'cached_models' && k !== 'shortcuts') {
                if (k === 'app-state') continue
                this.data[k] = v
            }
        }
        if (this.extractAndMigrateUiFields(this.data)) {
            this.dirtyUi = true
        }
        this.dirtySettings = true
    }

    private async ensureLoaded(): Promise<void> {
        if (this.loaded) return
        if (this.loadPromise) return this.loadPromise

        this.loadPromise = (async () => {
            try {
                const dir = path.dirname(this.storePath)
                await fs.mkdir(dir, { recursive: true })

                // 1. Load ui.json or migrate from legacy window-state.json
                if (fsSync.existsSync(this.uiPath)) {
                    const content = await fs.readFile(this.uiPath, 'utf8')
                    this.uiData = JSON.parse(content)
                } else {
                    const localLegacyUiPath = this.getLocalLegacyUiStorePath()
                    if (fsSync.existsSync(localLegacyUiPath)) {
                        const content = await fs.readFile(localLegacyUiPath, 'utf8')
                        this.uiData = JSON.parse(content)
                        this.dirtyUi = true
                    } else {
                        const legacyUiPath = this.getLegacyUiStorePath()
                        if (legacyUiPath && legacyUiPath !== this.uiPath && fsSync.existsSync(legacyUiPath)) {
                            const content = await fs.readFile(legacyUiPath, 'utf8')
                            this.uiData = JSON.parse(content)
                            this.dirtyUi = true
                        }
                    }
                }

                // 2. Load settings.json or migrate from legacy app-data.json
                if (fsSync.existsSync(this.storePath)) {
                    const content = await fs.readFile(this.storePath, 'utf8')
                    this.data = JSON.parse(content)
                } else {
                    const localLegacyPath = this.getLocalLegacyStorePath()
                    if (fsSync.existsSync(localLegacyPath)) {
                        const content = await fs.readFile(localLegacyPath, 'utf8')
                        const parsed = JSON.parse(content)
                        this.extractAndSanitizeLegacyData(parsed)
                    } else {
                        const legacyPath = this.getLegacyStorePath()
                        if (legacyPath && legacyPath !== this.storePath && fsSync.existsSync(legacyPath)) {
                            const content = await fs.readFile(legacyPath, 'utf8')
                            const parsed = JSON.parse(content)
                            this.extractAndSanitizeLegacyData(parsed)
                        } else {
                            this.data = {}
                        }
                    }
                }

                // 3. Load projects.json if exists
                if (fsSync.existsSync(this.projectsPath)) {
                    const content = await fs.readFile(this.projectsPath, 'utf8')
                    this.projectsData = JSON.parse(content)
                }

                // 4. Load cached_models.json if exists
                if (fsSync.existsSync(this.cachedModelsPath)) {
                    const content = await fs.readFile(this.cachedModelsPath, 'utf8')
                    this.cachedModelsData = JSON.parse(content)
                }

                // 5. Load shortcuts.json if exists, otherwise initialize default shortcuts
                if (fsSync.existsSync(this.shortcutsPath)) {
                    const content = await fs.readFile(this.shortcutsPath, 'utf8')
                    this.shortcutsData = normalizeSavedShortcutsConfig(JSON.parse(content), DEFAULT_SHORTCUT_ITEMS)
                }

                // 6. Load schedule.json if exists
                if (fsSync.existsSync(this.schedulePath)) {
                    const content = await fs.readFile(this.schedulePath, 'utf8')
                    this.scheduleData = JSON.parse(content)
                }

                // 7. Sanitize in-memory settings.json data if it still contains projects/cachedModels/shortcuts/ui
                const appState = this.data['app-state']
                if (appState && typeof appState === 'object' && !Array.isArray(appState)) {
                    const stateObj = appState as Record<string, unknown>
                    let mutated = false
                    if ('projects' in stateObj) {
                        if (this.projectsData === undefined) {
                            this.projectsData = stateObj.projects
                            this.dirtyProjects = true
                        }
                        delete stateObj.projects
                        mutated = true
                    }
                    if ('cachedModels' in stateObj) {
                        if (this.cachedModelsData === undefined) {
                            this.cachedModelsData = stateObj.cachedModels
                            this.dirtyCachedModels = true
                        }
                        delete stateObj.cachedModels
                        mutated = true
                    }
                    if ('shortcuts' in stateObj) {
                        if (this.shortcutsData === undefined) {
                            this.shortcutsData = normalizeSavedShortcutsConfig(stateObj.shortcuts, DEFAULT_SHORTCUT_ITEMS)
                            this.dirtyShortcuts = true
                        }
                        delete stateObj.shortcuts
                        mutated = true
                    }
                    if ('sessions' in stateObj) {
                        delete stateObj.sessions
                        mutated = true
                    }
                    if ('messagesBySession' in stateObj) {
                        delete stateObj.messagesBySession
                        mutated = true
                    }
                    if ('subAgents' in stateObj) {
                        delete stateObj.subAgents
                        mutated = true
                    }
                    if (stateObj.settings && typeof stateObj.settings === 'object' && !Array.isArray(stateObj.settings)) {
                        const settingsObj = stateObj.settings as Record<string, unknown>
                        if ('shortcuts' in settingsObj) {
                            if (this.shortcutsData === undefined) {
                                this.shortcutsData = normalizeSavedShortcutsConfig(settingsObj.shortcuts, DEFAULT_SHORTCUT_ITEMS)
                                this.dirtyShortcuts = true
                            }
                            delete settingsObj.shortcuts
                            mutated = true
                        }
                    }
                    if (this.extractAndMigrateUiFields(stateObj)) {
                        mutated = true
                    }
                    if (mutated) {
                        this.dirtySettings = true
                    }
                }

                if ('projects' in this.data) {
                    if (this.projectsData === undefined) {
                        this.projectsData = this.data.projects
                        this.dirtyProjects = true
                    }
                    delete this.data.projects
                    this.dirtySettings = true
                }

                if ('cachedModels' in this.data || 'cached_models' in this.data) {
                    if (this.cachedModelsData === undefined) {
                        this.cachedModelsData = this.data.cachedModels ?? this.data.cached_models
                        this.dirtyCachedModels = true
                    }
                    delete this.data.cachedModels
                    delete this.data.cached_models
                    this.dirtySettings = true
                }

                if ('shortcuts' in this.data) {
                    if (this.shortcutsData === undefined) {
                        this.shortcutsData = normalizeSavedShortcutsConfig(this.data.shortcuts, DEFAULT_SHORTCUT_ITEMS)
                        this.dirtyShortcuts = true
                    }
                    delete this.data.shortcuts
                    this.dirtySettings = true
                }

                if (this.extractAndMigrateUiFields(this.data)) {
                    this.dirtySettings = true
                }

                if (this.shortcutsData === undefined) {
                    this.shortcutsData = generateSavedShortcutsConfig(undefined, DEFAULT_SHORTCUT_ITEMS)
                    this.dirtyShortcuts = true
                }

                if (
                    this.dirtySettings ||
                    this.dirtyProjects ||
                    this.dirtyCachedModels ||
                    this.dirtyShortcuts ||
                    this.dirtyUi
                ) {
                    await this.save()
                }
            } catch {
                this.data = {}
            } finally {
                this.loaded = true
                this.loadPromise = null
            }
        })()

        return this.loadPromise
    }

    private ensureLoadedSync(): void {
        if (this.loaded) return
        try {
            const dir = path.dirname(this.storePath)
            fsSync.mkdirSync(dir, { recursive: true })

            // 1. Load ui.json or migrate from legacy window-state.json
            if (fsSync.existsSync(this.uiPath)) {
                const content = fsSync.readFileSync(this.uiPath, 'utf8')
                this.uiData = JSON.parse(content)
            } else {
                const localLegacyUiPath = this.getLocalLegacyUiStorePath()
                if (fsSync.existsSync(localLegacyUiPath)) {
                    const content = fsSync.readFileSync(localLegacyUiPath, 'utf8')
                    this.uiData = JSON.parse(content)
                    this.dirtyUi = true
                } else {
                    const legacyUiPath = this.getLegacyUiStorePath()
                    if (legacyUiPath && legacyUiPath !== this.uiPath && fsSync.existsSync(legacyUiPath)) {
                        const content = fsSync.readFileSync(legacyUiPath, 'utf8')
                        this.uiData = JSON.parse(content)
                        this.dirtyUi = true
                    }
                }
            }

            // 2. Load settings.json or migrate from legacy app-data.json
            if (fsSync.existsSync(this.storePath)) {
                const content = fsSync.readFileSync(this.storePath, 'utf8')
                this.data = JSON.parse(content)
            } else {
                const localLegacyPath = this.getLocalLegacyStorePath()
                if (fsSync.existsSync(localLegacyPath)) {
                    const content = fsSync.readFileSync(localLegacyPath, 'utf8')
                    const parsed = JSON.parse(content)
                    this.extractAndSanitizeLegacyData(parsed)
                } else {
                    const legacyPath = this.getLegacyStorePath()
                    if (legacyPath && legacyPath !== this.storePath && fsSync.existsSync(legacyPath)) {
                        const content = fsSync.readFileSync(legacyPath, 'utf8')
                        const parsed = JSON.parse(content)
                        this.extractAndSanitizeLegacyData(parsed)
                    } else {
                        this.data = {}
                    }
                }
            }

            // 3. Load projects.json if exists
            if (fsSync.existsSync(this.projectsPath)) {
                const content = fsSync.readFileSync(this.projectsPath, 'utf8')
                this.projectsData = JSON.parse(content)
            }

            // 4. Load cached_models.json if exists
            if (fsSync.existsSync(this.cachedModelsPath)) {
                const content = fsSync.readFileSync(this.cachedModelsPath, 'utf8')
                this.cachedModelsData = JSON.parse(content)
            }

            // 5. Load shortcuts.json if exists, otherwise initialize default shortcuts
            if (fsSync.existsSync(this.shortcutsPath)) {
                const content = fsSync.readFileSync(this.shortcutsPath, 'utf8')
                this.shortcutsData = normalizeSavedShortcutsConfig(JSON.parse(content), DEFAULT_SHORTCUT_ITEMS)
            }

            // 6. Load schedule.json if exists
            if (fsSync.existsSync(this.schedulePath)) {
                const content = fsSync.readFileSync(this.schedulePath, 'utf8')
                this.scheduleData = JSON.parse(content)
            }

            const appState = this.data['app-state']
            if (appState && typeof appState === 'object' && !Array.isArray(appState)) {
                const stateObj = appState as Record<string, unknown>
                let mutated = false
                if ('projects' in stateObj) {
                    if (this.projectsData === undefined) {
                        this.projectsData = stateObj.projects
                        this.dirtyProjects = true
                    }
                    delete stateObj.projects
                    mutated = true
                }
                if ('cachedModels' in stateObj) {
                    if (this.cachedModelsData === undefined) {
                        this.cachedModelsData = stateObj.cachedModels
                        this.dirtyCachedModels = true
                    }
                    delete stateObj.cachedModels
                    mutated = true
                }
                if ('shortcuts' in stateObj) {
                    if (this.shortcutsData === undefined) {
                        this.shortcutsData = normalizeSavedShortcutsConfig(stateObj.shortcuts, DEFAULT_SHORTCUT_ITEMS)
                        this.dirtyShortcuts = true
                    }
                    delete stateObj.shortcuts
                    mutated = true
                }
                if ('sessions' in stateObj) {
                    delete stateObj.sessions
                    mutated = true
                }
                if ('messagesBySession' in stateObj) {
                    delete stateObj.messagesBySession
                    mutated = true
                }
                if ('subAgents' in stateObj) {
                    delete stateObj.subAgents
                    mutated = true
                }
                if (stateObj.settings && typeof stateObj.settings === 'object' && !Array.isArray(stateObj.settings)) {
                    const settingsObj = stateObj.settings as Record<string, unknown>
                    if ('shortcuts' in settingsObj) {
                        if (this.shortcutsData === undefined) {
                            this.shortcutsData = normalizeSavedShortcutsConfig(settingsObj.shortcuts, DEFAULT_SHORTCUT_ITEMS)
                            this.dirtyShortcuts = true
                        }
                        delete settingsObj.shortcuts
                        mutated = true
                    }
                }
                if (this.extractAndMigrateUiFields(stateObj)) {
                    mutated = true
                }
                if (mutated) {
                    this.dirtySettings = true
                }
            }

            if ('projects' in this.data) {
                if (this.projectsData === undefined) {
                    this.projectsData = this.data.projects
                    this.dirtyProjects = true
                }
                delete this.data.projects
                this.dirtySettings = true
            }

            if ('cachedModels' in this.data || 'cached_models' in this.data) {
                if (this.cachedModelsData === undefined) {
                    this.cachedModelsData = this.data.cachedModels ?? this.data.cached_models
                    this.dirtyCachedModels = true
                }
                delete this.data.cachedModels
                delete this.data.cached_models
                this.dirtySettings = true
            }

            if ('shortcuts' in this.data) {
                if (this.shortcutsData === undefined) {
                    this.shortcutsData = normalizeSavedShortcutsConfig(this.data.shortcuts, DEFAULT_SHORTCUT_ITEMS)
                    this.dirtyShortcuts = true
                }
                delete this.data.shortcuts
                this.dirtySettings = true
            }

            if (this.extractAndMigrateUiFields(this.data)) {
                this.dirtySettings = true
            }

            if (this.shortcutsData === undefined) {
                this.shortcutsData = generateSavedShortcutsConfig(undefined, DEFAULT_SHORTCUT_ITEMS)
                this.dirtyShortcuts = true
            }

            if (
                this.dirtySettings ||
                this.dirtyProjects ||
                this.dirtyCachedModels ||
                this.dirtyShortcuts ||
                this.dirtyUi
            ) {
                this.saveSync()
            }
        } catch {
            this.data = {}
        } finally {
            this.loaded = true
        }
    }

    async get(key: string): Promise<unknown> {
        await this.ensureLoaded()
        if (key === 'ui') {
            return this.uiData
        }
        if (key === 'projects') {
            return this.projectsData
        }
        if (key === 'cachedModels' || key === 'cached_models') {
            return this.cachedModelsData
        }
        if (key === 'shortcuts') {
            return this.shortcutsData
        }
        if (key === 'schedule' || key === 'scheduledTasks' || key === 'scheduled_tasks') {
            return this.scheduleData
        }
        return this.data[key]
    }

    getSync(key: string): unknown {
        this.ensureLoadedSync()
        if (key === 'ui') {
            return this.uiData
        }
        if (key === 'projects') {
            return this.projectsData
        }
        if (key === 'cachedModels' || key === 'cached_models') {
            return this.cachedModelsData
        }
        if (key === 'shortcuts') {
            return this.shortcutsData
        }
        if (key === 'schedule' || key === 'scheduledTasks' || key === 'scheduled_tasks') {
            return this.scheduleData
        }
        return this.data[key]
    }

    async getPluginConfig(): Promise<PluginSourceConfig> {
        await this.ensureLoaded()
        const plugins = this.data.plugins
        if (plugins && typeof plugins === 'object') {
            return normalizePluginSourceConfig(plugins)
        }
        const pluginSources = this.data.pluginSources
        if (Array.isArray(pluginSources)) {
            return normalizePluginSourceConfig({ sources: pluginSources })
        }
        return { sources: [] }
    }

    getPluginConfigSync(): PluginSourceConfig {
        this.ensureLoadedSync()
        const plugins = this.data.plugins
        if (plugins && typeof plugins === 'object') {
            return normalizePluginSourceConfig(plugins)
        }
        const pluginSources = this.data.pluginSources
        if (Array.isArray(pluginSources)) {
            return normalizePluginSourceConfig({ sources: pluginSources })
        }
        return { sources: [] }
    }

    async setPluginConfig(config: PluginSourceConfig): Promise<void> {
        await this.ensureLoaded()
        const normalized = normalizePluginSourceConfig(config)
        const currentPlugins =
            this.data.plugins && typeof this.data.plugins === 'object' && !Array.isArray(this.data.plugins)
                ? (this.data.plugins as Record<string, unknown>)
                : {}
        this.data.plugins = {
            ...currentPlugins,
            sources: normalized.sources,
        }
        this.dirtySettings = true
        await this.save()
    }

    setPluginConfigSync(config: PluginSourceConfig): void {
        this.ensureLoadedSync()
        const normalized = normalizePluginSourceConfig(config)
        const currentPlugins =
            this.data.plugins && typeof this.data.plugins === 'object' && !Array.isArray(this.data.plugins)
                ? (this.data.plugins as Record<string, unknown>)
                : {}
        this.data.plugins = {
            ...currentPlugins,
            sources: normalized.sources,
        }
        this.dirtySettings = true
        this.saveSync()
    }

    async set(key: string, value: unknown): Promise<void> {
        await this.ensureLoaded()
        if (key === 'ui') {
            if (
                this.uiData &&
                typeof this.uiData === 'object' &&
                !Array.isArray(this.uiData) &&
                value &&
                typeof value === 'object' &&
                !Array.isArray(value)
            ) {
                this.uiData = {
                    ...(this.uiData as Record<string, unknown>),
                    ...(value as Record<string, unknown>),
                }
            } else {
                this.uiData = value
            }
            this.dirtyUi = true
            await this.save()
            return
        }
        if (key === 'projects') {
            this.projectsData = value
            this.dirtyProjects = true
            await this.save()
            return
        }
        if (key === 'cachedModels' || key === 'cached_models') {
            this.cachedModelsData = value
            this.dirtyCachedModels = true
            await this.save()
            return
        }
        if (key === 'shortcuts') {
            this.shortcutsData = normalizeSavedShortcutsConfig(value, DEFAULT_SHORTCUT_ITEMS)
            this.dirtyShortcuts = true
            await this.save()
            return
        }
        if (key === 'schedule' || key === 'scheduledTasks' || key === 'scheduled_tasks') {
            this.scheduleData = value
            this.dirtySchedule = true
            await this.save()
            return
        }

        if (key === 'app-state' && value && typeof value === 'object' && !Array.isArray(value)) {
            const stateObj = { ...(value as Record<string, unknown>) }
            if ('projects' in stateObj) {
                if (this.projectsData === undefined) {
                    this.projectsData = stateObj.projects
                    this.dirtyProjects = true
                }
                delete stateObj.projects
            }
            if ('cachedModels' in stateObj) {
                if (this.cachedModelsData === undefined) {
                    this.cachedModelsData = stateObj.cachedModels
                    this.dirtyCachedModels = true
                }
                delete stateObj.cachedModels
            }
            if ('shortcuts' in stateObj) {
                if (this.shortcutsData === undefined) {
                    this.shortcutsData = normalizeSavedShortcutsConfig(stateObj.shortcuts, DEFAULT_SHORTCUT_ITEMS)
                    this.dirtyShortcuts = true
                }
                delete stateObj.shortcuts
            }
            delete stateObj.sessions
            delete stateObj.messagesBySession
            delete stateObj.subAgents
            if (stateObj.settings && typeof stateObj.settings === 'object' && !Array.isArray(stateObj.settings)) {
                const settingsObj = { ...(stateObj.settings as Record<string, unknown>) }
                if ('shortcuts' in settingsObj) {
                    this.shortcutsData = normalizeSavedShortcutsConfig(settingsObj.shortcuts, DEFAULT_SHORTCUT_ITEMS)
                    this.dirtyShortcuts = true
                    delete settingsObj.shortcuts
                }
                stateObj.settings = settingsObj
            }
            if (this.extractAndMigrateUiFields(stateObj)) {
                this.dirtyUi = true
            }
            this.data[key] = stateObj
        } else {
            this.data[key] = value
        }

        this.dirtySettings = true
        await this.save()
    }

    setSync(key: string, value: unknown): void {
        this.ensureLoadedSync()
        if (key === 'ui') {
            if (
                this.uiData &&
                typeof this.uiData === 'object' &&
                !Array.isArray(this.uiData) &&
                value &&
                typeof value === 'object' &&
                !Array.isArray(value)
            ) {
                this.uiData = {
                    ...(this.uiData as Record<string, unknown>),
                    ...(value as Record<string, unknown>),
                }
            } else {
                this.uiData = value
            }
            this.dirtyUi = true
            this.saveSync()
            return
        }
        if (key === 'projects') {
            this.projectsData = value
            this.dirtyProjects = true
            this.saveSync()
            return
        }
        if (key === 'cachedModels' || key === 'cached_models') {
            this.cachedModelsData = value
            this.dirtyCachedModels = true
            this.saveSync()
            return
        }
        if (key === 'shortcuts') {
            this.shortcutsData = normalizeSavedShortcutsConfig(value, DEFAULT_SHORTCUT_ITEMS)
            this.dirtyShortcuts = true
            this.saveSync()
            return
        }
        if (key === 'schedule' || key === 'scheduledTasks' || key === 'scheduled_tasks') {
            this.scheduleData = value
            this.dirtySchedule = true
            this.saveSync()
            return
        }

        if (key === 'app-state' && value && typeof value === 'object' && !Array.isArray(value)) {
            const stateObj = { ...(value as Record<string, unknown>) }
            if ('projects' in stateObj) {
                if (this.projectsData === undefined) {
                    this.projectsData = stateObj.projects
                    this.dirtyProjects = true
                }
                delete stateObj.projects
            }
            if ('cachedModels' in stateObj) {
                if (this.cachedModelsData === undefined) {
                    this.cachedModelsData = stateObj.cachedModels
                    this.dirtyCachedModels = true
                }
                delete stateObj.cachedModels
            }
            if ('shortcuts' in stateObj) {
                if (this.shortcutsData === undefined) {
                    this.shortcutsData = normalizeSavedShortcutsConfig(stateObj.shortcuts, DEFAULT_SHORTCUT_ITEMS)
                    this.dirtyShortcuts = true
                }
                delete stateObj.shortcuts
            }
            delete stateObj.sessions
            delete stateObj.messagesBySession
            delete stateObj.subAgents
            if (stateObj.settings && typeof stateObj.settings === 'object' && !Array.isArray(stateObj.settings)) {
                const settingsObj = { ...(stateObj.settings as Record<string, unknown>) }
                if ('shortcuts' in settingsObj) {
                    this.shortcutsData = normalizeSavedShortcutsConfig(settingsObj.shortcuts, DEFAULT_SHORTCUT_ITEMS)
                    this.dirtyShortcuts = true
                    delete settingsObj.shortcuts
                }
                stateObj.settings = settingsObj
            }
            if (this.extractAndMigrateUiFields(stateObj)) {
                this.dirtyUi = true
            }
            this.data[key] = stateObj
        } else {
            this.data[key] = value
        }

        this.dirtySettings = true
        this.saveSync()
    }

    async delete(key: string): Promise<void> {
        await this.ensureLoaded()
        if (key === 'ui') {
            this.uiData = {}
            this.dirtyUi = true
        } else if (key === 'projects') {
            this.projectsData = []
            this.dirtyProjects = true
        } else if (key === 'cachedModels' || key === 'cached_models') {
            this.cachedModelsData = []
            this.dirtyCachedModels = true
        } else if (key === 'shortcuts') {
            this.shortcutsData = []
            this.dirtyShortcuts = true
        } else if (key === 'schedule' || key === 'scheduledTasks' || key === 'scheduled_tasks') {
            this.scheduleData = []
            this.dirtySchedule = true
        } else {
            delete this.data[key]
            this.dirtySettings = true
        }
        await this.save()
    }

    deleteSync(key: string): void {
        this.ensureLoadedSync()
        if (key === 'ui') {
            this.uiData = {}
            this.dirtyUi = true
        } else if (key === 'projects') {
            this.projectsData = []
            this.dirtyProjects = true
        } else if (key === 'cachedModels' || key === 'cached_models') {
            this.cachedModelsData = []
            this.dirtyCachedModels = true
        } else if (key === 'shortcuts') {
            this.shortcutsData = []
            this.dirtyShortcuts = true
        } else if (key === 'schedule' || key === 'scheduledTasks' || key === 'scheduled_tasks') {
            this.scheduleData = []
            this.dirtySchedule = true
        } else {
            delete this.data[key]
            this.dirtySettings = true
        }
        this.saveSync()
    }

    async save(): Promise<void> {
        const hasDirty =
            this.dirtySettings ||
            this.dirtyProjects ||
            this.dirtyCachedModels ||
            this.dirtyShortcuts ||
            this.dirtyUi ||
            this.dirtySchedule
        if (!hasDirty && !this.savePromise) return
        if (this.savePromise) return this.savePromise

        this.savePromise = (async () => {
            try {
                while (
                    this.dirtySettings ||
                    this.dirtyProjects ||
                    this.dirtyCachedModels ||
                    this.dirtyShortcuts ||
                    this.dirtyUi ||
                    this.dirtySchedule
                ) {
                    const dir = path.dirname(this.storePath)
                    await fs.mkdir(dir, { recursive: true })

                    if (this.dirtySettings) {
                        this.dirtySettings = false
                        const tempPath = `${this.storePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                        try {
                            await fs.writeFile(tempPath, JSON.stringify(this.data, null, 2), 'utf8')
                            await fs.rename(tempPath, this.storePath)
                        } catch (err) {
                            try {
                                await fs.unlink(tempPath)
                            } catch {}
                            this.dirtySettings = true
                            throw err
                        }
                    }

                    if (this.dirtyProjects) {
                        this.dirtyProjects = false
                        const payload = this.projectsData !== undefined ? this.projectsData : []
                        const tempPath = `${this.projectsPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                        try {
                            await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8')
                            await fs.rename(tempPath, this.projectsPath)
                        } catch (err) {
                            try {
                                await fs.unlink(tempPath)
                            } catch {}
                            this.dirtyProjects = true
                            throw err
                        }
                    }

                    if (this.dirtyCachedModels) {
                        this.dirtyCachedModels = false
                        const payload = this.cachedModelsData !== undefined ? this.cachedModelsData : []
                        const tempPath = `${this.cachedModelsPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                        try {
                            await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8')
                            await fs.rename(tempPath, this.cachedModelsPath)
                        } catch (err) {
                            try {
                                await fs.unlink(tempPath)
                            } catch {}
                            this.dirtyCachedModels = true
                            throw err
                        }
                    }

                    if (this.dirtyShortcuts) {
                        this.dirtyShortcuts = false
                        const payload = this.shortcutsData !== undefined ? this.shortcutsData : generateSavedShortcutsConfig(undefined, DEFAULT_SHORTCUT_ITEMS)
                        const tempPath = `${this.shortcutsPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                        try {
                            await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8')
                            await fs.rename(tempPath, this.shortcutsPath)
                        } catch (err) {
                            try {
                                await fs.unlink(tempPath)
                            } catch {}
                            this.dirtyShortcuts = true
                            throw err
                        }
                    }

                    if (this.dirtySchedule) {
                        this.dirtySchedule = false
                        const payload = this.scheduleData !== undefined ? this.scheduleData : []
                        const tempPath = `${this.schedulePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                        try {
                            await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8')
                            await fs.rename(tempPath, this.schedulePath)
                        } catch (err) {
                            try {
                                await fs.unlink(tempPath)
                            } catch {}
                            this.dirtySchedule = true
                            throw err
                        }
                    }

                    if (this.dirtyUi) {
                        this.dirtyUi = false
                        let existing: Record<string, unknown> = {}
                        try {
                            if (fsSync.existsSync(this.uiPath)) {
                                const raw = await fs.readFile(this.uiPath, 'utf8')
                                const parsed = JSON.parse(raw)
                                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                                    existing = parsed as Record<string, unknown>
                                }
                            }
                        } catch {
                            // Ignore read error
                        }
                        const payload =
                            this.uiData !== undefined && typeof this.uiData === 'object' && !Array.isArray(this.uiData)
                                ? { ...existing, ...(this.uiData as Record<string, unknown>) }
                                : this.uiData !== undefined
                                  ? this.uiData
                                  : existing
                        const tempPath = `${this.uiPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                        try {
                            await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8')
                            await fs.rename(tempPath, this.uiPath)
                        } catch (err) {
                            try {
                                await fs.unlink(tempPath)
                            } catch {}
                            this.dirtyUi = true
                            throw err
                        }
                    }
                }
            } finally {
                this.savePromise = null
            }
        })()

        return this.savePromise
    }

    saveSync(): void {
        const hasDirty =
            this.dirtySettings ||
            this.dirtyProjects ||
            this.dirtyCachedModels ||
            this.dirtyShortcuts ||
            this.dirtyUi ||
            this.dirtySchedule
        if (!hasDirty) return
        try {
            const dir = path.dirname(this.storePath)
            fsSync.mkdirSync(dir, { recursive: true })

            if (this.dirtySettings) {
                const tempPath = `${this.storePath}.tmp-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                fsSync.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8')
                fsSync.renameSync(tempPath, this.storePath)
                this.dirtySettings = false
            }

            if (this.dirtyProjects) {
                const payload = this.projectsData !== undefined ? this.projectsData : []
                const tempPath = `${this.projectsPath}.tmp-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                fsSync.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8')
                fsSync.renameSync(tempPath, this.projectsPath)
                this.dirtyProjects = false
            }

            if (this.dirtyCachedModels) {
                const payload = this.cachedModelsData !== undefined ? this.cachedModelsData : []
                const tempPath = `${this.cachedModelsPath}.tmp-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                fsSync.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8')
                fsSync.renameSync(tempPath, this.cachedModelsPath)
                this.dirtyCachedModels = false
            }

            if (this.dirtyShortcuts) {
                const payload = this.shortcutsData !== undefined ? this.shortcutsData : generateSavedShortcutsConfig(undefined, DEFAULT_SHORTCUT_ITEMS)
                const tempPath = `${this.shortcutsPath}.tmp-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                fsSync.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8')
                fsSync.renameSync(tempPath, this.shortcutsPath)
                this.dirtyShortcuts = false
            }

            if (this.dirtySchedule) {
                const payload = this.scheduleData !== undefined ? this.scheduleData : []
                const tempPath = `${this.schedulePath}.tmp-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                fsSync.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8')
                fsSync.renameSync(tempPath, this.schedulePath)
                this.dirtySchedule = false
            }

            if (this.dirtyUi) {
                let existing: Record<string, unknown> = {}
                try {
                    if (fsSync.existsSync(this.uiPath)) {
                        const raw = fsSync.readFileSync(this.uiPath, 'utf8')
                        const parsed = JSON.parse(raw)
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                            existing = parsed as Record<string, unknown>
                        }
                    }
                } catch {
                    // Ignore read error
                }
                const payload =
                    this.uiData !== undefined && typeof this.uiData === 'object' && !Array.isArray(this.uiData)
                        ? { ...existing, ...(this.uiData as Record<string, unknown>) }
                        : this.uiData !== undefined
                          ? this.uiData
                          : existing
                const tempPath = `${this.uiPath}.tmp-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                fsSync.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8')
                fsSync.renameSync(tempPath, this.uiPath)
                this.dirtyUi = false
            }
        } catch {
            // Ignore sync write errors during process exit
        }
    }

    dispose(): void {
        this.saveSync()
    }
}
