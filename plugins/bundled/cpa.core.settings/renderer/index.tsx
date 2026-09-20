import { WallpaperEffect } from './wallpaper/WallpaperSection.js'
import { wallpaperStore } from './wallpaper/wallpaper.js'
import { definePluginEntry } from '@cpa/plugin-sdk'
import type {
    ActionContribution,
    PluginContext,
    SettingsGroupContribution,
    SettingsSectionContribution,
} from '@cpa/plugin-api'
import {
    GitBranch,
    Keyboard,
    Link2,
    LogOut,
    Puzzle,
    Settings,
    Settings2,
    Smile,
    SquareTerminal,
    Sun,
} from '@cpa/plugin-ui'
import { GeneralSection } from './components/GeneralSection.js'
import { AppearanceSection } from './components/AppearanceSection.js'
import { PersonalizationSection } from './components/PersonalizationSection.js'
import { ShortcutsSection } from './components/shortcuts/ShortcutsSection.js'
import { ConnectionsSection } from './components/ConnectionsSection.js'
import { PluginsSection } from './components/PluginsSection.js'
import { GitSection } from './components/GitSection.js'
import { EnvironmentsSection } from './components/EnvironmentsSection.js'
import { UpdateSection } from './components/UpdateSection.js'
import { setSettingsCapabilityClient } from './utils/capability.js'

export {
    GeneralSection,
    AppearanceSection,
    PersonalizationSection,
    ShortcutsSection,
    ConnectionsSection,
    PluginsSection,
    GitSection,
    EnvironmentsSection,
    UpdateSection,
}

export const settingsRendererEntry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        setSettingsCapabilityClient(context.capabilityClient)
        if (context.capabilityClient) void wallpaperStore.initialize(context.capabilityClient)
        context.register({
            kind: 'slot',
            id: 'appearance-background',
            target: 'workspace.overlay',
            value: { id: 'appearance-background', component: WallpaperEffect },
        })

        // 1. Register Settings Groups
        const groups: SettingsGroupContribution[] = [
            {
                id: 'personal',
                order: 10,
                labelKey: 'settings.nav.group.personal',
            },
            {
                id: 'integrations',
                order: 20,
                labelKey: 'settings.nav.group.integrations',
            },
            {
                id: 'code',
                order: 30,
                labelKey: 'settings.nav.group.code',
            },
        ]

        for (const group of groups) {
            context.register<SettingsGroupContribution>({
                kind: 'settings-group',
                id: group.id,
                value: group,
            })
        }

        // 2. Register Settings Sections
        const sections: SettingsSectionContribution[] = [
            {
                id: 'general',
                groupId: 'personal',
                order: 10,
                labelKey: 'settings.nav.general',
                icon: Settings2,
                component: GeneralSection,
                keywords: ['general', 'common', 'language', 'theme', 'default'],
                items: [
                    {
                        id: 'permissions',
                        labelKey: 'settings.general.permissions',
                        keywords: ['permissions'],
                    },
                    {
                        id: 'defaultPermissions',
                        labelKey: 'settings.general.defaultPermissions',
                        descriptionKey: 'settings.general.defaultPermissions.desc',
                        keywords: ['permissions'],
                    },
                    {
                        id: 'language',
                        labelKey: 'settings.language',
                        descriptionKey: 'settings.general.language.desc',
                        keywords: ['language', 'locale', 'english'],
                    },
                    {
                        id: 'compactionThreshold',
                        labelKey: 'settings.general.compactionThreshold',
                        descriptionKey: 'settings.general.compactionThreshold.desc',
                        keywords: ['compaction', 'context'],
                    },
                    {
                        id: 'fastContextCompaction',
                        labelKey: 'settings.general.fastContextCompaction',
                        descriptionKey: 'settings.general.fastContextCompaction.desc',
                        keywords: ['compaction'],
                    },
                    {
                        id: 'resumeUnfinishedConversations',
                        labelKey: 'settings.general.resumeUnfinishedConversations',
                        descriptionKey: 'settings.general.resumeUnfinishedConversations.desc',
                        keywords: ['resume'],
                    },
                    {
                        id: 'menuBar',
                        labelKey: 'settings.general.menuBar',
                        descriptionKey: 'settings.general.menuBar.desc',
                        keywords: ['menu'],
                    },
                    {
                        id: 'bottomPanel',
                        labelKey: 'settings.general.bottomPanel',
                        descriptionKey: 'settings.general.bottomPanel.desc',
                        keywords: ['bottom panel'],
                    },
                    {
                        id: 'terminalPosition',
                        labelKey: 'settings.general.terminalPosition',
                        descriptionKey: 'settings.general.terminalPosition.desc',
                        keywords: ['terminal', 'position'],
                    },
                    {
                        id: 'preventSleep',
                        labelKey: 'settings.general.preventSleep',
                        descriptionKey: 'settings.general.preventSleep.desc',
                        keywords: ['prevent sleep'],
                    },
                    {
                        id: 'speed',
                        labelKey: 'settings.general.speed',
                        descriptionKey: 'settings.general.speed.desc',
                        keywords: ['speed'],
                    },
                    {
                        id: 'editor',
                        labelKey: 'settings.editor.title',
                        keywords: ['editor'],
                    },
                    {
                        id: 'showContextUsage',
                        labelKey: 'settings.editor.showContextUsage',
                        keywords: ['context usage'],
                    },
                    {
                        id: 'sendShortcut',
                        labelKey: 'settings.editor.sendShortcut',
                        descriptionKey: 'settings.editor.sendShortcut.desc',
                        keywords: ['send shortcut'],
                    },
                    {
                        id: 'followUpMode',
                        labelKey: 'settings.editor.followUpMode',
                        descriptionKey: 'settings.editor.followUpMode.desc.mac',
                        keywords: ['follow up', 'queue', 'steer'],
                    },
                ],
            },
            {
                id: 'appearance',
                groupId: 'personal',
                order: 20,
                labelKey: 'settings.nav.appearance',
                icon: Sun,
                component: AppearanceSection,
                keywords: ['wallpaper', 'background', 'appearance', 'theme', 'color', 'dark', 'light', 'font'],
                items: [
                    {
                        id: 'theme',
                        labelKey: 'settings.appearance.theme',
                        descriptionKey: 'settings.appearance.theme.desc',
                        keywords: ['theme', 'system'],
                    },
                    {
                        id: 'wallpaper',
                        labelKey: 'settings.appearance.wallpaper.title',
                        descriptionKey: 'settings.appearance.wallpaper.description',
                        keywords: ['wallpaper', 'background', 'image', '壁纸', '背景'],
                    },
                    {
                        id: 'darkTheme',
                        labelKey: 'settings.appearance.darkTheme',
                        keywords: ['dark theme', 'dark'],
                    },
                    {
                        id: 'lightTheme',
                        labelKey: 'settings.appearance.lightTheme',
                        keywords: ['light theme', 'light'],
                    },
                    {
                        id: 'accentColor',
                        labelKey: 'settings.appearance.accentColor',
                        keywords: ['color', 'accent'],
                    },
                    {
                        id: 'background',
                        labelKey: 'settings.appearance.background',
                        keywords: ['background'],
                    },
                    {
                        id: 'foreground',
                        labelKey: 'settings.appearance.foreground',
                        keywords: ['foreground'],
                    },
                    {
                        id: 'uiFont',
                        labelKey: 'settings.appearance.uiFont',
                        keywords: ['ui font', 'font'],
                    },
                    {
                        id: 'codeFont',
                        labelKey: 'settings.appearance.codeFont',
                        keywords: ['code font'],
                    },
                    {
                        id: 'contrast',
                        labelKey: 'settings.appearance.contrast',
                        keywords: ['contrast'],
                    },
                    {
                        id: 'uiFontSize',
                        labelKey: 'settings.appearance.uiFontSize',
                        descriptionKey: 'settings.appearance.uiFontSize.desc',
                        keywords: ['ui font size'],
                    },
                    {
                        id: 'codeFontSize',
                        labelKey: 'settings.appearance.codeFontSize',
                        descriptionKey: 'settings.appearance.codeFontSize.desc',
                        keywords: ['code font size'],
                    },
                    {
                        id: 'fontSmoothing',
                        labelKey: 'settings.appearance.fontSmoothing',
                        descriptionKey: 'settings.appearance.fontSmoothing.desc',
                        keywords: ['font smoothing'],
                    },
                    {
                        id: 'reviewPresentation',
                        labelKey: 'settings.git.reviewPresentation',
                        descriptionKey: 'settings.git.reviewPresentation.desc',
                        keywords: ['review presentation', 'diff'],
                    },
                    {
                        id: 'import',
                        labelKey: 'settings.appearance.import',
                        keywords: ['import theme'],
                    },
                ],
            },
            {
                id: 'personalization',
                groupId: 'personal',
                order: 30,
                labelKey: 'settings.nav.personalization',
                icon: Smile,
                component: PersonalizationSection,
                keywords: ['personalization', 'instructions', 'custom', 'user', 'memory'],
                items: [
                    {
                        id: 'customInstructions',
                        labelKey: 'settings.personalization.customInstructions',
                        descriptionKey: 'settings.personalization.customInstructions.desc',
                        keywords: ['custom instructions', 'prompt'],
                    },
                    {
                        id: 'personality',
                        labelKey: 'settings.personalization.personality',
                        descriptionKey: 'settings.personalization.personality.desc',
                        keywords: ['personality', 'tone'],
                    },
                    {
                        id: 'memory',
                        labelKey: 'settings.personalization.memory',
                        descriptionKey: 'settings.personalization.memory.desc',
                        keywords: ['memory'],
                    },
                    {
                        id: 'enableLocalMemory',
                        labelKey: 'settings.personalization.enableLocalMemory',
                        descriptionKey: 'settings.personalization.enableLocalMemory.desc',
                        keywords: ['local memory'],
                    },
                    {
                        id: 'toolAssistedMemory',
                        labelKey: 'settings.personalization.toolAssistedMemory',
                        descriptionKey: 'settings.personalization.toolAssistedMemory.desc',
                        keywords: ['tool assisted memory'],
                    },
                    {
                        id: 'deleteLocalMemory',
                        labelKey: 'settings.personalization.deleteLocalMemory',
                        descriptionKey: 'settings.personalization.deleteLocalMemory.desc',
                        keywords: ['delete memory'],
                    },
                ],
            },
            {
                id: 'shortcuts',
                groupId: 'personal',
                order: 40,
                labelKey: 'settings.nav.shortcuts',
                icon: Keyboard,
                component: ShortcutsSection,
                keywords: ['shortcuts', 'keyboard', 'keybindings', 'hotkeys'],
                items: [
                    {
                        id: 'searchShortcuts',
                        labelKey: 'settings.shortcuts.searchPlaceholder',
                        keywords: ['shortcuts', 'keybindings'],
                    },
                    {
                        id: 'resetAll',
                        labelKey: 'settings.shortcuts.resetAll',
                        keywords: ['reset shortcuts'],
                    },
                ],
            },
            {
                id: 'connections',
                groupId: 'integrations',
                order: 10,
                labelKey: 'settings.nav.connections',
                icon: Link2,
                component: ConnectionsSection,
                keywords: ['connections', 'proxy', 'api', 'server', 'network', 'endpoint'],
                items: [
                    {
                        id: 'baseUrl',
                        labelKey: 'settings.connections.baseUrl',
                        descriptionKey: 'settings.connections.baseUrl.desc',
                        keywords: ['base url', 'proxy', 'endpoint'],
                    },
                    {
                        id: 'apiKey',
                        labelKey: 'settings.connections.apiKey',
                        descriptionKey: 'settings.connections.apiKey.desc',
                        keywords: ['api key'],
                    },
                    {
                        id: 'webServer',
                        labelKey: 'settings.connections.webServer.title',
                        descriptionKey: 'settings.connections.webServer.desc',
                        keywords: ['web server'],
                    },
                    {
                        id: 'webServerHost',
                        labelKey: 'settings.connections.webServer.host',
                        descriptionKey: 'settings.connections.webServer.host.desc',
                        keywords: ['host', 'ip'],
                    },
                    {
                        id: 'webServerPort',
                        labelKey: 'settings.connections.webServer.port',
                        descriptionKey: 'settings.connections.webServer.port.desc',
                        keywords: ['port'],
                    },
                    {
                        id: 'webServerPassword',
                        labelKey: 'settings.connections.webServer.password',
                        descriptionKey: 'settings.connections.webServer.password.desc',
                        keywords: ['password'],
                    },
                ],
            },
            {
                id: 'plugins',
                groupId: 'integrations',
                order: 20,
                labelKey: 'settings.nav.plugins',
                icon: Puzzle,
                component: PluginsSection,
                keywords: ['plugins', 'extensions', 'marketplace', 'addons', 'install'],
                items: [
                    {
                        id: 'installed',
                        labelKey: 'settings.plugins.installed',
                        keywords: ['installed plugins'],
                    },
                    {
                        id: 'core',
                        labelKey: 'settings.plugins.core',
                        keywords: ['core plugins'],
                    },
                    {
                        id: 'external',
                        labelKey: 'settings.plugins.external',
                        keywords: ['external plugins'],
                    },
                ],
            },
            {
                id: 'git',
                groupId: 'code',
                order: 30,
                labelKey: 'settings.nav.git',
                icon: GitBranch,
                component: GitSection,
                keywords: ['git', 'version control', 'branch', 'diff', 'commit'],
                items: [
                    {
                        id: 'branchPrefix',
                        labelKey: 'settings.git.branchPrefix',
                        descriptionKey: 'settings.git.branchPrefix.desc',
                        keywords: ['branch prefix'],
                    },
                    {
                        id: 'mergeMethod',
                        labelKey: 'settings.git.mergeMethod',
                        descriptionKey: 'settings.git.mergeMethod.desc',
                        keywords: ['merge method'],
                    },
                    {
                        id: 'alwaysForcePush',
                        labelKey: 'settings.git.alwaysForcePush',
                        descriptionKey: 'settings.git.alwaysForcePush.desc',
                        keywords: ['force push'],
                    },
                    {
                        id: 'createDraftPr',
                        labelKey: 'settings.git.createDraftPr',
                        descriptionKey: 'settings.git.createDraftPr.desc',
                        keywords: ['draft pr'],
                    },
                    {
                        id: 'monitorAndFixPr',
                        labelKey: 'settings.git.monitorAndFixPr',
                        keywords: ['monitor and fix'],
                    },
                    {
                        id: 'autoMergeWhenReady',
                        labelKey: 'settings.git.autoMergeWhenReady',
                        descriptionKey: 'settings.git.autoMergeWhenReady.desc',
                        keywords: ['auto merge'],
                    },
                    {
                        id: 'commitInstructions',
                        labelKey: 'settings.git.commitInstructions',
                        descriptionKey: 'settings.git.commitInstructions.desc',
                        keywords: ['commit instructions'],
                    },
                    {
                        id: 'prInstructions',
                        labelKey: 'settings.git.prInstructions',
                        descriptionKey: 'settings.git.prInstructions.desc',
                        keywords: ['pr instructions'],
                    },
                ],
            },
            {
                id: 'environments',
                groupId: 'code',
                order: 40,
                labelKey: 'settings.nav.environments',
                icon: SquareTerminal,
                component: EnvironmentsSection,
                keywords: ['environments', 'terminal', 'shell', 'python', 'node', 'path', 'env'],
                items: [
                    {
                        id: 'description',
                        labelKey: 'settings.environments.description',
                        keywords: ['local environments'],
                    },
                    {
                        id: 'selectProject',
                        labelKey: 'settings.environments.selectProject',
                        keywords: ['select project'],
                    },
                    {
                        id: 'setupScript',
                        labelKey: 'settings.environments.setupScript',
                        descriptionKey: 'settings.environments.setupScriptDesc',
                        keywords: ['setup script'],
                    },
                    {
                        id: 'cleanupScript',
                        labelKey: 'settings.environments.cleanupScript',
                        descriptionKey: 'settings.environments.cleanupScriptDesc',
                        keywords: ['cleanup script'],
                    },
                    {
                        id: 'variables',
                        labelKey: 'settings.environments.variables',
                        keywords: ['variables'],
                    },
                    {
                        id: 'actions',
                        labelKey: 'settings.environments.actions',
                        descriptionKey: 'settings.environments.actionsDesc',
                        keywords: ['actions'],
                    },
                ],
            },
        ]

        for (const section of sections) {
            context.register<SettingsSectionContribution>({
                kind: 'settings',
                id: section.id,
                value: section,
            })
        }

        // 3. Register Actions
        const actions: ActionContribution[] = [
            {
                id: 'settings',
                title: 'settings.title',
                description: 'shortcuts.item.settings.desc',
                icon: Settings,
                defaultShortcuts: ['Meta+,'],
                placements: [{ surface: 'menu.user', order: 40 }],
                handler: (ctx: any) => {
                    const ui = ctx?.services?.ui
                    const current = ui?.getSnapshot?.()?.settingsOpen
                    if (current) {
                        ui?.closeSettings?.()
                    } else {
                        ui?.openSettings?.()
                    }
                },
            },
            {
                id: 'user.logout',
                title: 'user.logout',
                icon: LogOut,
                placements: [{ surface: 'menu.user', order: 50 }],
                handler: (ctx: any) => {
                    ctx?.services?.ui?.pushToast?.('user.logout.mock')
                },
            },
            {
                id: 'keyboard-shortcuts',
                title: 'shortcuts.item.keyboardShortcuts.title',
                description: 'shortcuts.item.keyboardShortcuts.desc',
                handler: (ctx: any) => {
                    ctx?.services?.ui?.openSettings?.('shortcuts')
                },
            },
        ]

        for (const action of actions) {
            context.register<ActionContribution>({
                kind: 'action',
                id: action.id,
                value: action,
            })
        }
    },
    deactivate() {
        wallpaperStore.dispose()
        setSettingsCapabilityClient(null)
    },
})

export const entry = settingsRendererEntry
export default settingsRendererEntry
