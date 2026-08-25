import React from 'react'
import { definePluginEntry } from '@cpa/plugin-sdk'
import type {
    ActionContribution,
    PanelContribution,
    PluginContext,
    SlotContribution,
} from '@cpa/plugin-api'
import { SquareTerminal } from '@cpa/plugin-ui'
import { TerminalPanelContent } from './components/TerminalPanelContent.js'
import { TerminalTabHeaders } from './components/TerminalTabHeaders.js'
import { TerminalBottomTabs } from './components/TerminalBottomTabs.js'
import { useTerminalStore } from './stores/terminalStore.js'
import { setTerminalCapabilityClient } from './utils/capability.js'
import { resolveTerminalContext } from './utils/context.js'

export { TerminalPanelContent, TerminalTabHeaders, TerminalBottomTabs, useTerminalStore }

function getFallbackTerminalTitle(): string {
    if (typeof window !== 'undefined') {
        const i18n = (window as any).i18next || (window as any).__cpaI18n
        if (i18n?.t) {
            return i18n.t('terminal.defaultTitle')
        }
    }
    return 'Terminal'
}

export const terminalRendererEntry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        setTerminalCapabilityClient(context.capabilityClient)

        // 1. Bottom Panel Content Slot
        context.register<SlotContribution>({
            kind: 'slot',
            id: 'terminal-content',
            target: 'layout.bottom_panel.content',
            priority: 10,
            value: {
                id: 'terminal-content',
                pluginId: 'cpa.core.terminal',
                order: 10,
                component: TerminalPanelContent,
            },
        })

        // 2. Bottom Panel Tabs Slot
        context.register<SlotContribution>({
            kind: 'slot',
            id: 'terminal-bottom-tabs',
            target: 'layout.bottom_panel.tabs',
            priority: 10,
            value: {
                id: 'terminal-bottom-tabs',
                pluginId: 'cpa.core.terminal',
                order: 10,
                component: TerminalBottomTabs,
            },
        })

        // 3. Right Sidebar Panel Contribution
        context.register<PanelContribution>({
            kind: 'panel',
            id: 'terminal',
            value: {
                id: 'terminal',
                pluginId: 'cpa.core.terminal',
                title: 'Terminal',
                titleKey: 'rightSidebar.selection.terminal',
                icon: SquareTerminal,
                order: 20,
                preferredWidth: 280,
                instancePolicy: 'multiple',
                headerActionsComponent: TerminalTabHeaders,
                hasOpenTabs: () => useTerminalStore.getState().tabs.some((t) => t.location === 'right'),
                component: (props: any) =>
                    React.createElement(TerminalPanelContent, { location: 'right', ...props }),
                selectionCard: {
                    labelKey: 'rightSidebar.selection.terminal',
                    icon: SquareTerminal,
                    shortcutMac: '^`',
                    shortcutOther: 'Ctrl+`',
                    requiresProject: false,
                    order: 20,
                },
                shortcut: {
                    mac: '^`',
                    other: 'Ctrl+`',
                    keyEventMatch: (e: KeyboardEvent) =>
                        Boolean(e.ctrlKey && (e.key === '`' || e.code === 'Backquote')),
                },
                onOpen: (ctx: any) => {
                    const currentRightTabs = useTerminalStore
                        .getState()
                        .tabs.filter((t) => t.location === 'right')
                    if (currentRightTabs.length === 0) {
                        const services = ctx?.services ?? (context as any).services
                        const sessionId = ctx?.activeSessionId ?? services?.sessions?.getCurrentSessionId?.() ?? null
                        const sessions = services?.sessions?.getSnapshot?.() ?? []
                        const projects = services?.projects?.getSnapshot?.() ?? []
                        const pendingProjectId = services?.ui?.getPendingSessionContext?.()?.projectId ?? null

                        const terminalContext = resolveTerminalContext({
                            sessionId,
                            sessions,
                            projects,
                            pendingProjectId,
                            fallbackTitle: getFallbackTerminalTitle(),
                        })
                        useTerminalStore.getState().addTab({ ...terminalContext, location: 'right' })
                    }
                },
                onClose: (ctx: any) => {
                    if (ctx?.instanceId && ctx.instanceId !== 'terminal') {
                        useTerminalStore.getState().closeTab(ctx.instanceId)
                    }
                },
            },
        })

        // 4. Actions
        context.register<ActionContribution>({
            kind: 'action',
            id: 'toggle-bottom-panel',
            value: {
                id: 'toggle-bottom-panel',
                title: 'shortcuts.item.toggleBottomPanel.title',
                description: 'shortcuts.item.toggleBottomPanel.desc',
                defaultShortcuts: ['Meta+J'],
                handler: (actionCtx) => {
                    const uiService = (actionCtx?.services as any)?.ui ?? (context as any).services?.ui
                    if (uiService?.toggleBottomPanelVisible) {
                        uiService.toggleBottomPanelVisible()
                    }
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'open-terminal',
            value: {
                id: 'open-terminal',
                title: 'shortcuts.item.openTerminal.title',
                description: 'shortcuts.item.openTerminal.desc',
                defaultShortcuts: ['Ctrl+`'],
                handler: (actionCtx) => {
                    const uiService = (actionCtx?.services as any)?.ui ?? (context as any).services?.ui
                    if (uiService?.openRightPanelTab) {
                        uiService.openRightPanelTab('terminal')
                    }
                },
            },
        })
    },
    deactivate() {
        setTerminalCapabilityClient(null)
        useTerminalStore.getState().reset()
    },
})

export const entry = terminalRendererEntry
export default terminalRendererEntry
