import React from 'react'
import { definePluginEntry } from '@cpa/plugin-sdk'
import type {
    ActionContribution,
    ChatRendererContribution,
    PanelContribution,
    PluginContext,
} from '@cpa/plugin-api'
import {
    PluginCard,
    PluginCardBody,
    PluginCardHeader,
    PluginCardTitle,
    SquarePlus,
    getDefaultHostServices,
} from '@cpa/plugin-ui'
import {
    ReviewPanelContent,
    type ReviewPanelContentProps,
} from './components/ReviewPanelContent.js'

export { ReviewPanelContent }
export type { ReviewPanelContentProps }

const DEFAULT_RIGHT_SIDEBAR_CONVERSATION_WIDTH = 420

export const reviewRendererEntry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        // 1. Right Sidebar Panel Contribution
        context.register<PanelContribution>({
            kind: 'panel',
            id: 'review',
            value: {
                id: 'review',
                pluginId: 'cpa.core.review',
                title: 'Diff Review',
                titleKey: 'rightSidebar.tabs.review',
                icon: SquarePlus,
                order: 30,
                preferredWidth: DEFAULT_RIGHT_SIDEBAR_CONVERSATION_WIDTH,
                instancePolicy: 'single',
                component: ReviewPanelContent as any,
                selectionCard: {
                    labelKey: 'rightSidebar.selection.review',
                    icon: SquarePlus,
                    shortcutMac: '^⇧G',
                    shortcutOther: 'Ctrl+Shift+G',
                    requiresProject: true,
                    order: 10,
                },
                shortcut: {
                    mac: '^⇧G',
                    other: 'Ctrl+Shift+G',
                    keyEventMatch: (e: KeyboardEvent, { hasProject }: { hasProject: boolean }) =>
                        Boolean(hasProject && e.ctrlKey && e.shiftKey && (e.key === 'G' || e.key === 'g')),
                },
                isAvailable: (ctx: any) => {
                    const services = ctx?.services ?? (context as any).services ?? getDefaultHostServices()
                    const sessions = services?.sessions?.getSnapshot?.() ?? []
                    const projects = services?.projects?.getSnapshot?.() ?? []
                    const pendingProjectId = services?.ui?.getPendingSessionContext?.()?.projectId
                    const currentSession = sessions.find((s: any) => s.id === ctx?.activeSessionId)
                    const projectId = currentSession?.projectId ?? pendingProjectId
                    const hasWorktree = Boolean(
                        currentSession?.worktreePath ||
                        currentSession?.worktreeSetup?.worktreePath
                    )
                    return Boolean(hasWorktree || (projectId && projects.some((p: any) => p.id === projectId)))
                },
                onOpen: (_ctx: any) => {},
                onClose: (_ctx: any) => {},
            },
        })

        // 2. Action: Open Review Tab
        context.register<ActionContribution>({
            kind: 'action',
            id: 'open-review-tab',
            value: {
                id: 'open-review-tab',
                title: 'shortcuts.item.openReviewTab.title',
                description: 'shortcuts.item.openReviewTab.desc',
                defaultShortcuts: ['Ctrl+Shift+G'],
                handler: (actionCtx: any) => {
                    const uiService = (actionCtx?.services as any)?.ui ?? (context as any).services?.ui ?? getDefaultHostServices()?.ui
                    uiService?.openRightPanelTab?.('review')
                },
            },
        })

        // 3. Action: Toggle Review Panel
        context.register<ActionContribution>({
            kind: 'action',
            id: 'toggle-review-panel',
            value: {
                id: 'toggle-review-panel',
                title: 'shortcuts.item.toggleReviewPanel.title',
                description: 'shortcuts.item.toggleReviewPanel.desc',
                defaultShortcuts: ['Meta+Alt+B'],
                handler: (actionCtx: any) => {
                    const uiService = (actionCtx?.services as any)?.ui ?? (context as any).services?.ui ?? getDefaultHostServices()?.ui
                    uiService?.toggleRightSidebarCollapsed?.()
                },
            },
        })

        // 4. Chat Renderer: Review Diff Tool Card
        context.register<ChatRendererContribution>({
            kind: 'chat-renderer',
            id: 'review-diff-tool-card',
            priority: 50,
            value: {
                id: 'review-diff-tool-card',
                priority: 50,
                matches: (part: any) =>
                    part?.type === 'tool_call' &&
                    (part?.name === 'review_diff' || part?.name === 'git_diff'),
                component: function ReviewToolCard({ part }: { part?: any }) {
                    return React.createElement(
                        PluginCard,
                        null,
                        React.createElement(
                            PluginCardHeader,
                            null,
                            React.createElement(
                                PluginCardTitle,
                                null,
                                part?.name ?? 'review_diff',
                            ),
                        ),
                        part?.result
                            ? React.createElement(
                                  PluginCardBody,
                                  null,
                                  String(part.result),
                              )
                            : null,
                    )
                },
            },
        })

        // 5. Review open file event listener
        if (context.events?.on) {
            context.events.on('review:open-file', (payload: any) => {
                const filePayload =
                    payload && typeof payload === 'object'
                        ? (payload as { filePath?: string; path?: string })
                        : {}
                const path = filePayload.filePath || filePayload.path || ''
                const uiService = (context as any).services?.ui
                uiService?.openRightPanelTab?.('review', {
                    activate: true,
                    params: path ? { selectedFilePath: path, timestamp: Date.now() } : undefined,
                })
            })
        }
    },
})

export const entry = reviewRendererEntry
export default reviewRendererEntry
