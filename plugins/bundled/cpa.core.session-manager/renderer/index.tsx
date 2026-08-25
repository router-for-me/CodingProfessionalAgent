import { definePluginEntry } from '@cpa/plugin-sdk'
import type {
    ActionContribution,
    ComposerControlContribution,
    PluginContext,
    SettingsGroupContribution,
    SettingsSectionContribution,
    SlotContribution,
} from '@cpa/plugin-api'
import {
    SessionServiceToken,
    ProjectServiceToken,
    UiServiceToken,
} from '@cpa/plugin-api'
import { Archive, Gift } from '@cpa/plugin-ui'

import { ArchivedChatsSection } from './components/ArchivedChatsSection.js'
import { SidebarNavTop } from './components/SidebarNavTop.js'
import { SidebarSessionList } from './components/SidebarSessionList.js'
import {
    TitleBarCenterContribution,
    TitleBarLeftContribution,
    TitleBarRightContribution,
} from './components/TitleBarContributions.js'
import {
    ProjectPickerControl,
    WorkLocationPickerControl,
    EnvironmentPickerControl,
    BranchPickerControl,
} from './components/ComposerContextControls.js'
import { getOrderedSessions } from './utils/sessionOrdering.js'
import { getLastUsedProjectWorktreeSettings } from './utils/projectWorktreeSettings.js'
import { isMobileBrowser } from './utils/platform.js'

export {
    ArchivedChatsSection,
    SidebarNavTop,
    SidebarSessionList,
    TitleBarCenterContribution,
    TitleBarLeftContribution,
    TitleBarRightContribution,
    ProjectPickerControl,
    WorkLocationPickerControl,
    EnvironmentPickerControl,
    BranchPickerControl,
}

export const sessionManagerRendererEntry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        // 1. Register Settings Group and Section
        context.register<SettingsGroupContribution>({
            kind: 'settings-group',
            id: 'archived',
            value: {
                id: 'archived',
                order: 40,
                labelKey: 'settings.nav.group.archived',
            },
        })

        context.register<SettingsSectionContribution>({
            kind: 'settings',
            id: 'archived',
            value: {
                id: 'archived',
                groupId: 'archived',
                order: 10,
                labelKey: 'settings.nav.archivedChats',
                icon: Archive,
                component: ArchivedChatsSection,
                keywords: ['archived', 'archive', 'history', 'chats', 'sessions'],
                items: [
                    {
                        id: 'archivedChats',
                        labelKey: 'settings.nav.archivedChats',
                        keywords: ['archived chats'],
                    },
                    {
                        id: 'search',
                        labelKey: 'settings.archived.search',
                        keywords: ['search'],
                    },
                    {
                        id: 'deleteAll',
                        labelKey: 'settings.archived.deleteAll',
                        keywords: ['delete all'],
                    },
                ],
            },
        })

        // 2. Register Slots
        context.register<SlotContribution>({
            kind: 'slot',
            id: 'sidebar-nav-top',
            target: 'layout.sidebar.nav.top',
            value: {
                id: 'sidebar-nav-top',
                pluginId: 'cpa.core.session-manager',
                order: 10,
                component: SidebarNavTop,
            },
        })

        context.register<SlotContribution>({
            kind: 'slot',
            id: 'sidebar-session-list',
            target: 'layout.sidebar.content',
            value: {
                id: 'sidebar-session-list',
                pluginId: 'cpa.core.session-manager',
                order: 10,
                component: SidebarSessionList,
            },
        })

        context.register<SlotContribution>({
            kind: 'slot',
            id: 'titlebar-left-sidebar-toggle',
            target: 'layout.titlebar.left',
            value: {
                id: 'titlebar-left-sidebar-toggle',
                pluginId: 'cpa.core.session-manager',
                order: 10,
                component: TitleBarLeftContribution,
            },
        })

        context.register<SlotContribution>({
            kind: 'slot',
            id: 'titlebar-session-title',
            target: 'layout.titlebar.center',
            value: {
                id: 'titlebar-session-title',
                pluginId: 'cpa.core.session-manager',
                order: 10,
                component: TitleBarCenterContribution,
            },
        })

        context.register<SlotContribution>({
            kind: 'slot',
            id: 'titlebar-right-controls',
            target: 'layout.titlebar.right',
            value: {
                id: 'titlebar-right-controls',
                pluginId: 'cpa.core.session-manager',
                order: 10,
                component: TitleBarRightContribution,
            },
        })

        // 3. Register Composer Controls
        context.register<ComposerControlContribution>({
            kind: 'composer',
            id: 'project-picker',
            value: {
                id: 'project-picker',
                placement: 'context',
                order: 10,
                component: ProjectPickerControl,
            },
        })

        context.register<ComposerControlContribution>({
            kind: 'composer',
            id: 'work-location-picker',
            value: {
                id: 'work-location-picker',
                placement: 'context',
                order: 20,
                component: WorkLocationPickerControl,
            },
        })

        context.register<ComposerControlContribution>({
            kind: 'composer',
            id: 'environment-picker',
            value: {
                id: 'environment-picker',
                placement: 'context',
                order: 30,
                component: EnvironmentPickerControl,
            },
        })

        context.register<ComposerControlContribution>({
            kind: 'composer',
            id: 'branch-picker',
            value: {
                id: 'branch-picker',
                placement: 'context',
                order: 40,
                component: BranchPickerControl,
            },
        })

        // 4. Register Actions
        context.register<ActionContribution>({
            kind: 'action',
            id: 'new-chat',
            value: {
                id: 'new-chat',
                title: 'shortcuts.item.newChat.title',
                description: 'shortcuts.item.newChat.desc',
                defaultShortcuts: ['Meta+N', 'Meta+Shift+O'],
                handler: (actionCtx: any) => {
                    const sessionService = (actionCtx?.services as any)?.sessions ?? (context.getService ? context.getService(SessionServiceToken.id) : null)
                    const uiService = (actionCtx?.services as any)?.ui ?? (context.getService ? context.getService(UiServiceToken.id) : null)
                    const projectService = (actionCtx?.services as any)?.projects ?? (context.getService ? context.getService(ProjectServiceToken.id) : null)

                    const currentSessionId = (sessionService as any)?.getCurrentSessionId?.()
                    const sessions = (sessionService as any)?.getSnapshot?.() ?? []
                    const currentSession = currentSessionId ? sessions.find((s: any) => s.id === currentSessionId) : null
                    const projects = (projectService as any)?.getSnapshot?.() ?? []
                    const activeProjectId = currentSession?.projectId ?? null
                    const activeBranch = currentSession?.branch ?? null
                    const isValidProject = Boolean(activeProjectId && projects.some((p: any) => p.id === activeProjectId))

                    ;(sessionService as any)?.setCurrentSessionId?.(null)
                    if (isValidProject && activeProjectId) {
                        const lastSettings = getLastUsedProjectWorktreeSettings(activeProjectId, { sessions, projects })
                        ;(uiService as any)?.setPendingSessionContext?.({
                            projectId: activeProjectId,
                            branch: activeBranch,
                            ...(lastSettings.workLocation !== undefined ? { workLocation: lastSettings.workLocation } : {}),
                            ...(lastSettings.environmentId !== undefined ? { environmentId: lastSettings.environmentId } : {}),
                        })
                    } else {
                        ;(uiService as any)?.setPendingSessionContext?.({ projectId: null, branch: null })
                    }

                    if (uiService?.closeSettings) {
                        uiService.closeSettings()
                    }
                    if (uiService?.closeSearch) {
                        uiService.closeSearch()
                    }
                    if (uiService?.setRightSidebarMaximized) {
                        uiService.setRightSidebarMaximized(false)
                    }
                    if (isMobileBrowser() && uiService?.setSidebarCollapsed) {
                        uiService.setSidebarCollapsed(true)
                    }

                    if (actionCtx?.navigate) {
                        void actionCtx.navigate({ to: '/' })
                    }

                    const triggerFocus = () => {
                        uiService?.emitEvent?.('composer:focus')
                        void context.events?.emit?.('composer:focus', {})
                    }
                    triggerFocus()
                    if (typeof requestAnimationFrame !== 'undefined') {
                        requestAnimationFrame(triggerFocus)
                    }
                    setTimeout(triggerFocus, 50)
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'new-standalone-chat',
            value: {
                id: 'new-standalone-chat',
                title: 'shortcuts.item.newStandaloneChat.title',
                description: 'shortcuts.item.newStandaloneChat.desc',
                defaultShortcuts: ['Meta+Alt+O'],
                handler: (actionCtx: any) => {
                    const sessionService = (actionCtx?.services as any)?.sessions ?? (context.getService ? context.getService(SessionServiceToken.id) : null)
                    const uiService = (actionCtx?.services as any)?.ui ?? (context.getService ? context.getService(UiServiceToken.id) : null)
                    ;(sessionService as any)?.setCurrentSessionId?.(null)
                    ;(uiService as any)?.setPendingSessionContext?.({ projectId: null, branch: null })

                    if (uiService?.closeSettings) {
                        uiService.closeSettings()
                    }
                    if (uiService?.closeSearch) {
                        uiService.closeSearch()
                    }
                    if (uiService?.setRightSidebarMaximized) {
                        uiService.setRightSidebarMaximized(false)
                    }
                    if (isMobileBrowser() && uiService?.setSidebarCollapsed) {
                        uiService.setSidebarCollapsed(true)
                    }

                    if (actionCtx?.navigate) {
                        void actionCtx.navigate({ to: '/' })
                    }

                    const triggerFocus = () => {
                        uiService?.emitEvent?.('composer:focus')
                        void context.events?.emit?.('composer:focus', {})
                    }
                    triggerFocus()
                    if (typeof requestAnimationFrame !== 'undefined') {
                        requestAnimationFrame(triggerFocus)
                    }
                    setTimeout(triggerFocus, 50)
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'next-chat',
            value: {
                id: 'next-chat',
                title: 'shortcuts.item.nextChat.title',
                description: 'shortcuts.item.nextChat.desc',
                defaultShortcuts: ['Meta+Shift+]', 'Meta+Alt+ArrowRight'],
                handler: (actionCtx: any) => {
                    const sessionService = context.getService ? (context.getService(SessionServiceToken.id) as any) : null
                    const projectService = context.getService ? (context.getService(ProjectServiceToken.id) as any) : null
                    const sessions = sessionService?.getSnapshot?.() ?? []
                    const projects = projectService?.getSnapshot?.() ?? []
                    const ordered = getOrderedSessions(sessions, projects)
                    const curId = sessionService?.getCurrentSessionId?.()
                    const idx = ordered.findIndex((s) => s.id === curId)
                    const next = idx >= 0 && idx < ordered.length - 1 ? ordered[idx + 1] : ordered[0]
                    if (next) {
                        sessionService?.setCurrentSessionId?.(next.id)
                        if (actionCtx?.navigate) {
                            void actionCtx.navigate({ to: '/chat/$sessionId', params: { sessionId: next.id } })
                        }
                    }
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'previous-chat',
            value: {
                id: 'previous-chat',
                title: 'shortcuts.item.previousChat.title',
                description: 'shortcuts.item.previousChat.desc',
                defaultShortcuts: ['Meta+Shift+[', 'Meta+Alt+ArrowLeft'],
                handler: (actionCtx: any) => {
                    const sessionService = context.getService ? (context.getService(SessionServiceToken.id) as any) : null
                    const projectService = context.getService ? (context.getService(ProjectServiceToken.id) as any) : null
                    const sessions = sessionService?.getSnapshot?.() ?? []
                    const projects = projectService?.getSnapshot?.() ?? []
                    const ordered = getOrderedSessions(sessions, projects)
                    const curId = sessionService?.getCurrentSessionId?.()
                    const idx = ordered.findIndex((s) => s.id === curId)
                    const prev = idx > 0 ? ordered[idx - 1] : ordered[ordered.length - 1]
                    if (prev) {
                        sessionService?.setCurrentSessionId?.(prev.id)
                        if (actionCtx?.navigate) {
                            void actionCtx.navigate({ to: '/chat/$sessionId', params: { sessionId: prev.id } })
                        }
                    }
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'archive-chat',
            value: {
                id: 'archive-chat',
                title: 'shortcuts.item.archiveChat.title',
                description: 'shortcuts.item.archiveChat.desc',
                defaultShortcuts: ['Meta+Shift+A'],
                handler: (actionCtx: any) => {
                    const sessionService = context.getService ? (context.getService(SessionServiceToken.id) as any) : null
                    const curId = sessionService?.getCurrentSessionId?.()
                    if (curId) {
                        void sessionService?.update?.(curId, { archivedAt: Date.now() })
                    }
                    if (actionCtx?.navigate) {
                        void actionCtx.navigate({ to: '/' })
                    }
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'toggle-pin',
            value: {
                id: 'toggle-pin',
                title: 'shortcuts.item.togglePin.title',
                description: 'shortcuts.item.togglePin.desc',
                defaultShortcuts: ['Meta+Alt+P'],
                handler: () => {
                    const sessionService = context.getService ? (context.getService(SessionServiceToken.id) as any) : null
                    const curId = sessionService?.getCurrentSessionId?.()
                    if (curId) {
                        sessionService?.togglePin?.(curId)
                    }
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'mark-as-unread',
            value: {
                id: 'mark-as-unread',
                title: 'shortcuts.item.markAsUnread.title',
                description: 'shortcuts.item.markAsUnread.desc',
                defaultShortcuts: ['Meta+Shift+U'],
                handler: () => {
                    const sessionService = context.getService ? (context.getService(SessionServiceToken.id) as any) : null
                    const curId = sessionService?.getCurrentSessionId?.()
                    if (curId) {
                        sessionService?.markUnread?.(curId, true)
                    }
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'fork-chat',
            value: {
                id: 'fork-chat',
                title: 'shortcuts.item.forkChat.title',
                description: 'shortcuts.item.forkChat.desc',
                handler: (actionCtx: any) => {
                    const sessionService = context.getService ? (context.getService(SessionServiceToken.id) as any) : null
                    const curId = sessionService?.getCurrentSessionId?.()
                    if (curId && actionCtx?.navigate) {
                        void actionCtx.navigate({ to: '/chat/$sessionId', params: { sessionId: curId } })
                    }
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'switch-chat',
            value: {
                id: 'switch-chat',
                title: 'shortcuts.item.switchChat.title',
                description: 'shortcuts.item.switchChat.desc',
                defaultShortcuts: ['Meta+K'],
                handler: () => {
                    window.dispatchEvent(new CustomEvent('open-search-palette'))
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'user.invite',
            value: {
                id: 'user.invite',
                title: 'user.inviteFriends',
                icon: Gift,
                placements: [{ surface: 'menu.user', order: 30 }],
                handler: () => {
                    const uiService = context.getService ? (context.getService(UiServiceToken.id) as any) : null
                    uiService?.pushToast?.('toast.comingSoon')
                },
            },
        })
    },
})

export const entry = sessionManagerRendererEntry
export default sessionManagerRendererEntry
