import { useCallback, useEffect } from 'react'
import { createHashRouteUrl, getHashRoutePathname } from '@cpa/plugin-ui'
import { matchShortcut, matchesShortcutId, normalizeShortcutBinding } from '@cpa/plugin-api'
import { actionRegistry } from '@/application/actions/actionRegistry'
import { getHostServices } from '@/application/services/createHostServices'
import type { ActionContribution, ActionExecutionContext } from '@cpa/plugin-api'
import { useSettingsStore } from '@/stores/settingsStore'
import {
    isEditableElement,
    isEventOrFocusInEditable,
    shouldBypassGlobalShortcutInEditable,
} from './editableUtils'
import {
    executeArchiveChatAction,
    executeCycleReasoningEffortAction,
    executeFocusMainChatInputAction,
    executeForkChatAction,
    executeMarkAsUnreadAction,
    executeNewChatAction,
    executeNewStandaloneChatAction,
    executeNextChatAction,
    executeNextModelAction,
    executeOpenFolderAction,
    executeOpenModelSelectorAction,
    executeOpenSettingsAction,
    executePreviousChatAction,
    executePreviousModelAction,
    executeToggleBottomPanelAction,
    executeTogglePinAction,
    executeToggleSearchAction,
    executeToggleSidebarAction,
    executeStopExecutionAction,
    type NavigateFn,
} from './actionHandlers'

export type { NavigateFn }
export {
    isEditableElement,
    isEventOrFocusInEditable,
    shouldBypassGlobalShortcutInEditable,
    executeArchiveChatAction,
    executeCycleReasoningEffortAction,
    executeFocusMainChatInputAction,
    executeForkChatAction,
    executeMarkAsUnreadAction,
    executeNewChatAction,
    executeNewStandaloneChatAction,
    executeNextChatAction,
    executeNextModelAction,
    executeOpenFolderAction,
    executeOpenModelSelectorAction,
    executeOpenSettingsAction,
    executePreviousChatAction,
    executePreviousModelAction,
    executeToggleBottomPanelAction,
    executeTogglePinAction,
    executeToggleSearchAction,
    executeToggleSidebarAction,
    executeStopExecutionAction,
}

function actionMatchesKey(
    event: KeyboardEvent,
    action: ActionContribution,
    customShortcuts?: Record<string, unknown> | null
): boolean {
    if (customShortcuts && Object.prototype.hasOwnProperty.call(customShortcuts, action.id)) {
        const raw = customShortcuts[action.id]
        if (Array.isArray(raw)) {
            const bindings = raw
                .map((s) => normalizeShortcutBinding(s))
                .filter((s): s is NonNullable<typeof s> => s !== null)
            return bindings.some((sc) => matchShortcut(event, sc))
        }
        return false
    }

    if (action.defaultShortcuts && action.defaultShortcuts.length > 0) {
        return action.defaultShortcuts.some((sc) => matchShortcut(event, sc as any))
    }

    return matchesShortcutId(event, action.id, customShortcuts)
}

/**
 * Global keyboard shortcuts hook for top-level application actions.
 * Parses keystrokes and dispatches actions through actionRegistry.execute().
 */
export function useAppKeyboardShortcuts(navigate?: NavigateFn) {
    const shortcuts = useSettingsStore((s) => s.settings.shortcuts)

    const dispatchAction = useCallback(
        async (actionId: string) => {
            const context: ActionExecutionContext = {
                services: {
                    ...getHostServices(),
                    navigation: {
                        navigate: async (to: string) => {
                            if (navigate) {
                                await navigate({ to })
                            } else {
                                window.location.assign(createHashRouteUrl(to))
                            }
                        },
                    },
                },
                pathname: getHashRoutePathname(),
                source: 'shortcut',
                navigate,
            }
            try {
                await actionRegistry.execute(actionId, context)
            } catch (err) {
                console.error(`[useAppKeyboardShortcuts] Failed to execute action "${actionId}":`, err)
            }
        },
        [navigate]
    )

    const handleCreateNewChat = useCallback(() => {
        executeNewChatAction(navigate)
    }, [navigate])

    const handleCreateNewStandaloneChat = useCallback(() => {
        executeNewStandaloneChatAction(navigate)
    }, [navigate])

    const handleNextChat = useCallback(() => {
        executeNextChatAction(navigate)
    }, [navigate])

    const handlePreviousChat = useCallback(() => {
        executePreviousChatAction(navigate)
    }, [navigate])

    const handleToggleBottomPanel = useCallback(() => {
        executeToggleBottomPanelAction()
    }, [])

    const handleArchiveChat = useCallback(() => {
        executeArchiveChatAction(navigate)
    }, [navigate])

    const handleToggleSidebar = useCallback(() => {
        executeToggleSidebarAction()
    }, [])

    const handleOpenSettings = useCallback(() => {
        executeOpenSettingsAction()
    }, [])

    const handleCycleReasoningEffort = useCallback(() => {
        executeCycleReasoningEffortAction()
    }, [])

    const handleNextModel = useCallback(() => {
        executeNextModelAction()
    }, [])

    const handlePreviousModel = useCallback(() => {
        executePreviousModelAction()
    }, [])

    const handleOpenModelSelector = useCallback(() => {
        executeOpenModelSelectorAction()
    }, [])

    const handleOpenFolder = useCallback(() => {
        executeOpenFolderAction()
    }, [])

    const handleTogglePin = useCallback(() => {
        executeTogglePinAction()
    }, [])

    const handleMarkAsUnread = useCallback(() => {
        executeMarkAsUnreadAction()
    }, [])

    const handleForkChat = useCallback(() => {
        executeForkChatAction(navigate)
    }, [navigate])

    const handleSwitchChat = useCallback(() => {
        executeToggleSearchAction()
    }, [])

    const handleFocusMainChatInput = useCallback(() => {
        executeFocusMainChatInputAction()
    }, [])

    const handleStopExecution = useCallback(() => {
        executeStopExecutionAction()
    }, [])

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented) return

            // If the user is inside an editable input and performing text editing/navigation, bypass global shortcuts
            if (
                isEventOrFocusInEditable(event) &&
                shouldBypassGlobalShortcutInEditable(event)
            ) {
                return
            }

            for (const action of actionRegistry.list()) {
                if (actionMatchesKey(event, action, shortcuts)) {
                    event.preventDefault()
                    void dispatchAction(action.id)
                    return
                }
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => {
            window.removeEventListener('keydown', handleKeyDown)
        }
    }, [shortcuts, dispatchAction])

    return {
        createNewChat: handleCreateNewChat,
        createNewStandaloneChat: handleCreateNewStandaloneChat,
        nextChat: handleNextChat,
        previousChat: handlePreviousChat,
        toggleBottomPanel: handleToggleBottomPanel,
        archiveChat: handleArchiveChat,
        toggleSidebar: handleToggleSidebar,
        openSettings: handleOpenSettings,
        cycleReasoningEffort: handleCycleReasoningEffort,
        nextModel: handleNextModel,
        previousModel: handlePreviousModel,
        openModelSelector: handleOpenModelSelector,
        openFolder: handleOpenFolder,
        togglePin: handleTogglePin,
        markAsUnread: handleMarkAsUnread,
        switchChat: handleSwitchChat,
        forkChat: handleForkChat,
        focusMainChatInput: handleFocusMainChatInput,
        stopExecution: handleStopExecution,
    }
}
