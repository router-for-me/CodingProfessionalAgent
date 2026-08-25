import { definePluginEntry } from '@cpa/plugin-sdk'
import type {
    ActionContribution,
    ActionExecutionContext,
    PluginContext,
    UiService,
} from '@cpa/plugin-api'
import { UiServiceToken } from '@cpa/plugin-api'

export const navigationRendererEntry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        // Register Actions
        const actions: ActionContribution[] = [
            {
                id: 'toggle-sidebar',
                title: 'shortcuts.item.toggleSidebar.title',
                description: 'shortcuts.item.toggleSidebar.desc',
                defaultShortcuts: ['Meta+B'],
                handler: (execCtx?: ActionExecutionContext) => {
                    const uiService = (execCtx?.services as any)?.ui ?? context.getService?.<UiService>(UiServiceToken)
                    if (uiService?.toggleSidebar) {
                        uiService.toggleSidebar()
                    } else if (uiService?.setSidebarCollapsed) {
                        const collapsed = uiService.isSidebarCollapsed?.() ?? false
                        uiService.setSidebarCollapsed(!collapsed)
                    }
                    void context.events?.emit?.('ui:toggle-sidebar', {})
                },
            },
            {
                id: 'focus-main-chat-input',
                title: 'shortcuts.item.focusMainChatInput.title',
                description: 'shortcuts.item.focusMainChatInput.desc',
                defaultShortcuts: ['Meta+I'],
                handler: (execCtx?: ActionExecutionContext) => {
                    const uiService = (execCtx?.services as any)?.ui ?? context.getService?.<UiService>(UiServiceToken)
                    uiService?.closeSettings?.()
                    void context.events?.emit?.('composer:focus', {})
                },
            },
            {
                id: 'navigate-back',
                title: 'shortcuts.item.navigateBack.title',
                description: 'shortcuts.item.navigateBack.desc',
                defaultShortcuts: ['Meta+['],
                handler: () => {
                    if (typeof window !== 'undefined') {
                        window.history.back()
                    }
                },
            },
            {
                id: 'navigate-forward',
                title: 'shortcuts.item.navigateForward.title',
                description: 'shortcuts.item.navigateForward.desc',
                defaultShortcuts: ['Meta+]'],
                handler: () => {
                    if (typeof window !== 'undefined') {
                        window.history.forward()
                    }
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
})

export const entry = navigationRendererEntry
export default navigationRendererEntry
