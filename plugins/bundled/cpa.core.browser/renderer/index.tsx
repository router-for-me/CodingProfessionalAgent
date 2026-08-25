import React from 'react'
import { definePluginEntry } from '@cpa/plugin-sdk'
import type {
    ActionContribution,
    PanelContribution,
    PluginContext,
} from '@cpa/plugin-api'
import { Globe } from '@cpa/plugin-ui'
import {
    BrowserPanelContent,
    type BrowserPanelContentProps,
} from './components/BrowserPanelContent.js'

export { BrowserPanelContent }
export type { BrowserPanelContentProps }

export const browserRendererEntry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        // 1. Panel Tab
        context.register<PanelContribution>({
            kind: 'panel',
            id: 'browser',
            value: {
                id: 'browser',
                pluginId: 'cpa.core.browser',
                title: 'Browser',
                titleKey: 'rightSidebar.tabs.browser',
                icon: Globe,
                order: 25,
                preferredWidth: 280,
                instancePolicy: 'single',
                component: (props: any) =>
                    React.createElement(BrowserPanelContent, { events: context.events, ...props }),
                selectionCard: {
                    labelKey: 'rightSidebar.selection.browser',
                    icon: Globe,
                    shortcutMac: '⌘T',
                    shortcutOther: 'Ctrl+T',
                    requiresProject: false,
                    order: 25,
                },
                shortcut: {
                    mac: '⌘T',
                    other: 'Ctrl+T',
                    keyEventMatch: (e: KeyboardEvent) =>
                        (e.metaKey || e.ctrlKey) &&
                        (e.key === 't' || e.key === 'T') &&
                        !e.shiftKey &&
                        !e.altKey,
                },
            },
        })

        // 2. Actions
        context.register<ActionContribution>({
            kind: 'action',
            id: 'open-browser-tab',
            value: {
                id: 'open-browser-tab',
                title: 'shortcuts.item.openBrowserTab.title',
                description: 'shortcuts.item.openBrowserTab.desc',
                defaultShortcuts: ['Meta+T'],
                handler: (actionCtx) => {
                    const uiService = (actionCtx?.services as any)?.ui ?? (context as any).services?.ui
                    if (uiService?.openRightPanelTab) {
                        uiService.openRightPanelTab('browser')
                    }
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'toggle-browser-panel',
            value: {
                id: 'toggle-browser-panel',
                title: 'shortcuts.item.toggleBrowserPanel.title',
                description: 'shortcuts.item.toggleBrowserPanel.desc',
                defaultShortcuts: ['Meta+Shift+B'],
                handler: (actionCtx) => {
                    const uiService = (actionCtx?.services as any)?.ui ?? (context as any).services?.ui
                    if (uiService?.toggleRightSidebarCollapsed) {
                        uiService.toggleRightSidebarCollapsed()
                    }
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'reload-browser-page',
            value: {
                id: 'reload-browser-page',
                title: 'shortcuts.item.reloadBrowserPage.title',
                description: 'shortcuts.item.reloadBrowserPage.desc',
                defaultShortcuts: ['Meta+R'],
                handler: () => {
                    context.events?.emit('browser:reload')
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'force-reload-browser-page',
            value: {
                id: 'force-reload-browser-page',
                title: 'shortcuts.item.forceReloadBrowserPage.title',
                description: 'shortcuts.item.forceReloadBrowserPage.desc',
                defaultShortcuts: ['Meta+Shift+R'],
                handler: () => {
                    context.events?.emit('browser:force-reload')
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'browser-back',
            value: {
                id: 'browser-back',
                title: 'shortcuts.item.browserBack.title',
                description: 'shortcuts.item.browserBack.desc',
                defaultShortcuts: ['Meta+ArrowLeft'],
                handler: () => {
                    context.events?.emit('browser:back')
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'browser-forward',
            value: {
                id: 'browser-forward',
                title: 'shortcuts.item.browserForward.title',
                description: 'shortcuts.item.browserForward.desc',
                defaultShortcuts: ['Meta+ArrowRight'],
                handler: () => {
                    context.events?.emit('browser:forward')
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'focus-browser-address-bar',
            value: {
                id: 'focus-browser-address-bar',
                title: 'shortcuts.item.focusBrowserAddressBar.title',
                description: 'shortcuts.item.focusBrowserAddressBar.desc',
                defaultShortcuts: ['Meta+L'],
                handler: () => {
                    context.events?.emit('browser:focus-address-bar')
                },
            },
        })
    },
})

export const entry = browserRendererEntry
export default browserRendererEntry
