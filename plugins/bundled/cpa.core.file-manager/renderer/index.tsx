import { definePluginEntry } from '@cpa/plugin-sdk'
import type {
    ActionContribution,
    PanelContribution,
    PluginContext,
} from '@cpa/plugin-api'
import { FileText, Folder } from '@cpa/plugin-ui'
import {
    FileManagerPanelContent,
    type FileManagerPanelContentProps,
    type FileTreeEntry,
} from './components/FileManagerPanelContent.js'

export { FileManagerPanelContent }
export type { FileManagerPanelContentProps, FileTreeEntry }

export const fileManagerRendererEntry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        // 1. Panel Tab Contribution
        context.register<PanelContribution>({
            kind: 'panel',
            id: 'file-manager',
            value: {
                id: 'file-manager',
                pluginId: 'cpa.core.file-manager',
                title: 'Files',
                titleKey: 'rightSidebar.tabs.files',
                icon: Folder,
                order: 40,
                preferredWidth: 280,
                instancePolicy: 'single',
                component: FileManagerPanelContent as any,
                getDynamicTitle: (params: any) => (params?.name ? String(params.name) : null),
                getDynamicIcon: (params: any) => (params?.name ? FileText : Folder),
                selectionCard: {
                    labelKey: 'rightSidebar.selection.files',
                    icon: Folder,
                    shortcutMac: '⌘P',
                    shortcutOther: 'Ctrl+P',
                    requiresProject: true,
                    order: 40,
                },
                shortcut: {
                    mac: '⌘P',
                    other: 'Ctrl+P',
                    keyEventMatch: (e: KeyboardEvent, { hasProject }: { hasProject: boolean }) =>
                        hasProject &&
                        (e.metaKey || e.ctrlKey) &&
                        (e.key === 'p' || e.key === 'P') &&
                        !e.shiftKey &&
                        !e.altKey,
                },
                isAvailable: (ctx: any) => {
                    if (typeof ctx?.hasProject === 'boolean') {
                        return ctx.hasProject
                    }
                    const services = ctx?.services ?? (context as any).services
                    const sessions = services?.sessions?.getSnapshot?.() ?? []
                    const projects = services?.projects?.getSnapshot?.() ?? []
                    const pendingContext = services?.ui?.getPendingSessionContext?.()
                    const activeId = ctx?.activeSessionId ?? ctx?.sessionId
                    const currentSession = sessions.find((s: any) => s.id === activeId)
                    const projectId = currentSession?.projectId ?? pendingContext?.projectId ?? ctx?.projectId
                    return Boolean(projectId && projects.some((p: any) => p.id === projectId))
                },
            },
        })

        // 2. Open file event subscription
        if (context.events?.on) {
            context.events.on('file-manager:open-file', (payload: any) => {
                const filePayload =
                    payload && typeof payload === 'object'
                        ? (payload as { path?: string; relativePath?: string; name?: string })
                        : {}
                const path = filePayload.path ?? ''
                const name = filePayload.name ?? path.split(/[/\\]/).pop() ?? ''
                const relativePath = filePayload.relativePath ?? path.split(/[/\\]/).pop() ?? ''

                const uiService = (context as any).services?.ui
                if (uiService?.openRightPanelTab) {
                    uiService.openRightPanelTab('file-manager', {
                        activate: true,
                        params: {
                            activeFilePath: path,
                            name,
                            relativePath,
                        },
                    })
                }
            })
        }

        // 3. Actions
        context.register<ActionContribution>({
            kind: 'action',
            id: 'search-files',
            value: {
                id: 'search-files',
                title: 'shortcuts.item.searchFiles.title',
                description: 'shortcuts.item.searchFiles.desc',
                defaultShortcuts: ['Meta+P'],
                handler: (actionCtx) => {
                    const uiService = (actionCtx?.services as any)?.ui ?? (context as any).services?.ui
                    if (uiService?.openRightPanelTab) {
                        uiService.openRightPanelTab('file-manager')
                    }
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'go-to-line',
            value: {
                id: 'go-to-line',
                title: 'shortcuts.item.goToLine.title',
                description: 'shortcuts.item.goToLine.desc',
                handler: () => {
                    context.events?.emit?.('file-manager:go-to-line')
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'copy-file-path',
            value: {
                id: 'copy-file-path',
                title: 'shortcuts.item.copyFilePath.title',
                description: 'shortcuts.item.copyFilePath.desc',
                handler: () => {
                    context.events?.emit?.('file-manager:copy-file-path')
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'reveal-in-file-manager',
            value: {
                id: 'reveal-in-file-manager',
                title: 'shortcuts.item.revealInFileManager.title',
                description: 'shortcuts.item.revealInFileManager.desc',
                handler: () => {
                    context.events?.emit?.('file-manager:reveal')
                },
            },
        })
    },
})

export const entry = fileManagerRendererEntry
export default fileManagerRendererEntry
