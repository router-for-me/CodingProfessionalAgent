import { isMobileBrowser } from '@/lib/platform'
import { rendererEventBus } from '@/plugins/platform/eventBus'
import {
    getFilteredModels,
    getReasoningOptions,
    normalizeModelPreferences,
} from '@/features/models/filteredModels'
import { FALLBACK_MODEL_CATALOG } from '@/features/models/fallbackModels'
import { forkSession } from '@/features/agent-runtime/session/forkSession'
import { getLastUsedProjectWorktreeSettings } from '@/lib/projectWorktreeSettings'
import { getOrderedSessions } from '@/lib/sessionOrdering'
import { useMessageStore } from '@/stores/messageStore'
import { useModelCatalogStore } from '@/stores/modelCatalogStore'
import { schedulePersist } from '@/application/services/persistenceService'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionRunStore } from '@/stores/sessionRunStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUiStore } from '@/stores/uiStore'

export type NavigateFn = (opts: {
    to: string
    params?: Record<string, string>
}) => Promise<void> | void

/**
 * Creates a new chat session state.
 * If currently under an active and valid project/branch context, creates an empty session bound to that project and branch.
 * Otherwise, creates an empty unbound session.
 */
export function executeNewChatAction(navigate?: NavigateFn): void {
    const currentSessionId = useSessionStore.getState().currentSessionId
    const sessions = useSessionStore.getState().sessions
    const projects = useProjectStore.getState().projects
    const pendingSessionContext = useUiStore.getState().pendingSessionContext

    const currentSession = currentSessionId
        ? sessions.find((s) => s.id === currentSessionId)
        : null

    const activeProjectId = currentSession
        ? (currentSession.projectId ?? null)
        : (pendingSessionContext.projectId ?? null)

    const activeBranch = currentSession
        ? (currentSession.branch ?? null)
        : (pendingSessionContext.branch ?? null)

    const isValidProject = Boolean(
        activeProjectId && projects.some((p) => p.id === activeProjectId),
    )

    if (isValidProject && activeProjectId) {
        const lastSettings = getLastUsedProjectWorktreeSettings(activeProjectId)
        useSessionStore.getState().setCurrentSession(null)
        useUiStore.getState().setPendingSessionContext({
            projectId: activeProjectId,
            branch: activeBranch,
            ...(lastSettings.workLocation !== undefined ? { workLocation: lastSettings.workLocation } : {}),
            ...(lastSettings.environmentId !== undefined ? { environmentId: lastSettings.environmentId } : {}),
        })
    } else {
        useSessionStore.getState().setCurrentSession(null)
        useUiStore.getState().setPendingSessionContext({
            projectId: null,
            branch: null,
        })
    }

    if (useUiStore.getState().settingsOpen) {
        useUiStore.getState().setSettingsOpen(false)
    }

    if (useUiStore.getState().searchOpen) {
        useUiStore.getState().setSearchOpen(false)
    }

    if (useUiStore.getState().rightSidebarMaximized) {
        useUiStore.getState().setRightSidebarMaximized(false)
    }

    if (isMobileBrowser()) {
        useUiStore.getState().setSidebarCollapsed(true)
    }

    if (navigate) {
        void navigate({ to: '/' })
    }

    rendererEventBus.emit('composer:focus')
}

/**
 * Creates a new standalone chat session state outside of any project.
 * Always creates an empty unbound session (projectId: null, branch: null).
 */
export function executeNewStandaloneChatAction(navigate?: NavigateFn): void {
    useSessionStore.getState().setCurrentSession(null)
    useUiStore.getState().setPendingSessionContext({
        projectId: null,
        branch: null,
    })

    if (useUiStore.getState().settingsOpen) {
        useUiStore.getState().setSettingsOpen(false)
    }

    if (useUiStore.getState().searchOpen) {
        useUiStore.getState().setSearchOpen(false)
    }

    if (useUiStore.getState().rightSidebarMaximized) {
        useUiStore.getState().setRightSidebarMaximized(false)
    }

    if (isMobileBrowser()) {
        useUiStore.getState().setSidebarCollapsed(true)
    }

    if (navigate) {
        void navigate({ to: '/' })
    }

    rendererEventBus.emit('composer:focus')
}

/**
 * Switches to the next chat across all projects and uncategorized sessions.
 */
export function executeNextChatAction(navigate?: NavigateFn): void {
    const sessions = useSessionStore.getState().sessions
    const projects = useProjectStore.getState().projects
    const entriesBySession = useMessageStore.getState().entriesBySession
    const currentSessionId = useSessionStore.getState().currentSessionId

    const orderedSessions = getOrderedSessions(sessions, projects, entriesBySession)
    if (orderedSessions.length === 0) return

    const currentIndex = currentSessionId
        ? orderedSessions.findIndex((s) => s.id === currentSessionId)
        : -1

    const nextIndex =
        currentIndex >= 0 ? (currentIndex + 1) % orderedSessions.length : 0

    const targetSession = orderedSessions[nextIndex]
    if (!targetSession) return

    useSessionStore.getState().setCurrentSession(targetSession.id)
    useUiStore.getState().restoreForSession(targetSession.rightSidebar ?? null)

    if (useUiStore.getState().settingsOpen) {
        useUiStore.getState().setSettingsOpen(false)
    }

    if (isMobileBrowser()) {
        useUiStore.getState().setSidebarCollapsed(true)
    }

    if (navigate) {
        void navigate({
            to: '/chat/$sessionId',
            params: { sessionId: targetSession.id },
        })
    }
}

/**
 * Switches to the previous chat across all projects and uncategorized sessions.
 */
export function executePreviousChatAction(navigate?: NavigateFn): void {
    const sessions = useSessionStore.getState().sessions
    const projects = useProjectStore.getState().projects
    const entriesBySession = useMessageStore.getState().entriesBySession
    const currentSessionId = useSessionStore.getState().currentSessionId

    const orderedSessions = getOrderedSessions(sessions, projects, entriesBySession)
    if (orderedSessions.length === 0) return

    const currentIndex = currentSessionId
        ? orderedSessions.findIndex((s) => s.id === currentSessionId)
        : -1

    const prevIndex =
        currentIndex >= 0
            ? (currentIndex - 1 + orderedSessions.length) % orderedSessions.length
            : orderedSessions.length - 1

    const targetSession = orderedSessions[prevIndex]
    if (!targetSession) return

    useSessionStore.getState().setCurrentSession(targetSession.id)
    useUiStore.getState().restoreForSession(targetSession.rightSidebar ?? null)

    if (useUiStore.getState().settingsOpen) {
        useUiStore.getState().setSettingsOpen(false)
    }

    if (isMobileBrowser()) {
        useUiStore.getState().setSidebarCollapsed(true)
    }

    if (navigate) {
        void navigate({
            to: '/chat/$sessionId',
            params: { sessionId: targetSession.id },
        })
    }
}

/**
 * Toggles the visibility of the bottom panel (terminal).
 */
export function executeToggleBottomPanelAction(): void {
    useUiStore.getState().toggleBottomPanelVisible()
}

/**
 * Archives the currently active chat session.
 */
export function executeArchiveChatAction(navigate?: NavigateFn): void {
    const currentSessionId = useSessionStore.getState().currentSessionId
    if (!currentSessionId) return

    const session = useSessionStore
        .getState()
        .sessions.find((s) => s.id === currentSessionId)
    if (!session || session.archivedAt !== undefined) return

    useSessionStore.getState().archiveSession(currentSessionId)
    schedulePersist(true)

    if (useUiStore.getState().settingsOpen) {
        useUiStore.getState().setSettingsOpen(false)
    }

    if (isMobileBrowser()) {
        useUiStore.getState().setSidebarCollapsed(true)
    }

    const nextId = useSessionStore.getState().currentSessionId
    if (nextId) {
        const nextSession = useSessionStore
            .getState()
            .sessions.find((s) => s.id === nextId)
        useUiStore.getState().restoreForSession(nextSession?.rightSidebar ?? null)
        if (navigate) {
            void navigate({
                to: '/chat/$sessionId',
                params: { sessionId: nextId },
            })
        }
    } else {
        useUiStore.getState().restoreForSession(null)
        if (navigate) {
            void navigate({ to: '/' })
        }
    }
}

/**
 * Toggles the visibility of the primary left sidebar.
 */
export function executeToggleSidebarAction(): void {
    useUiStore.getState().toggleSidebarCollapsed()
}

/**
 * Opens or toggles the settings panel.
 */
export function executeOpenSettingsAction(): void {
    const current = useUiStore.getState().settingsOpen
    useUiStore.getState().setSettingsOpen(!current)
}

/**
 * Cycles the model reasoning effort level to the next higher level.
 * If already at the maximum level (or not found), cycles back to the lowest level.
 */
export function executeCycleReasoningEffortAction(): string | null {
    const currentSessionId = useSessionStore.getState().currentSessionId
    const currentSession = currentSessionId
        ? useSessionStore.getState().sessions.find((s) => s.id === currentSessionId)
        : undefined
    const modelId = currentSession?.modelId ?? useSettingsStore.getState().settings.modelId
    const modelSettings = useSettingsStore.getState().settings.modelSettings
    const currentReasoningLevel =
        currentSession?.reasoningEffort ??
        useSettingsStore.getState().settings.reasoningLevel

    const catalogModels = useModelCatalogStore.getState().models
    const rawModels =
        catalogModels.length > 0 ? catalogModels : FALLBACK_MODEL_CATALOG
    const filteredModels = getFilteredModels(rawModels, modelSettings)
    const models = filteredModels.length > 0 ? filteredModels : rawModels
    const currentModel =
        models.find((model: any) => model.id === modelId) ?? models[0]

    const reasoningOptions = getReasoningOptions(currentModel)
    if (reasoningOptions.length === 0) return null

    const currentIndex = reasoningOptions.findIndex(
        (option) => option.id === currentReasoningLevel,
    )

    let nextIndex = 0
    if (currentIndex >= 0 && currentIndex < reasoningOptions.length - 1) {
        nextIndex = currentIndex + 1
    } else {
        nextIndex = 0
    }

    const nextOption = reasoningOptions[nextIndex]
    if (!nextOption) return null

    useSettingsStore.getState().setReasoningLevel(nextOption.id)
    if (currentSessionId) {
        useSessionStore.getState().setSessionRuntimeSettings(currentSessionId, {
            modelId,
            reasoningEffort: nextOption.id,
            speed: currentSession?.speed ?? useSettingsStore.getState().settings.speed,
        })
    }
    return nextOption.id
}

/**
 * Switches to the next available model.
 * Does not cycle/wrap around when reaching the last model.
 */
export function executeNextModelAction(): string | null {
    const currentSessionId = useSessionStore.getState().currentSessionId
    if (currentSessionId) {
        const run = useSessionRunStore.getState().activeRuns[currentSessionId]
        if (run && run.status !== 'idle') {
            return null
        }
    }
    const currentSession = currentSessionId
        ? useSessionStore.getState().sessions.find((s) => s.id === currentSessionId)
        : undefined
    const modelId = currentSession?.modelId ?? useSettingsStore.getState().settings.modelId
    const modelSettings = useSettingsStore.getState().settings.modelSettings

    const catalogModels = useModelCatalogStore.getState().models
    const rawModels =
        catalogModels.length > 0 ? catalogModels : FALLBACK_MODEL_CATALOG
    const filteredModels = getFilteredModels(rawModels, modelSettings)
    const models = filteredModels.length > 0 ? filteredModels : rawModels
    if (models.length === 0) return null

    const currentIndex = models.findIndex((model: any) => model.id === modelId)
    if (currentIndex < 0) {
        const nextModel = models[0]
        useSettingsStore.getState().setModelId(nextModel.id)
        const normalized = normalizeModelPreferences(
            nextModel,
            currentSession?.reasoningEffort ?? useSettingsStore.getState().settings.reasoningLevel,
            currentSession?.speed ?? useSettingsStore.getState().settings.speed,
        )
        useSettingsStore.getState().setReasoningLevel(normalized.reasoningLevel)
        if (currentSessionId) {
            useSessionStore.getState().setSessionRuntimeSettings(currentSessionId, {
                modelId: nextModel.id,
                reasoningEffort: normalized.reasoningLevel,
                speed: normalized.speed,
            })
        }
        return nextModel.id
    }

    if (currentIndex >= models.length - 1) {
        return null
    }

    const nextModel = models[currentIndex + 1]
    useSettingsStore.getState().setModelId(nextModel.id)
    const normalized = normalizeModelPreferences(
        nextModel,
        currentSession?.reasoningEffort ?? useSettingsStore.getState().settings.reasoningLevel,
        currentSession?.speed ?? useSettingsStore.getState().settings.speed,
    )
    useSettingsStore.getState().setReasoningLevel(normalized.reasoningLevel)
    if (currentSessionId) {
        useSessionStore.getState().setSessionRuntimeSettings(currentSessionId, {
            modelId: nextModel.id,
            reasoningEffort: normalized.reasoningLevel,
            speed: normalized.speed,
        })
    }
    return nextModel.id
}

/**
 * Switches to the previous available model.
 * Does not cycle/wrap around when reaching the first model.
 */
export function executePreviousModelAction(): string | null {
    const currentSessionId = useSessionStore.getState().currentSessionId
    if (currentSessionId) {
        const run = useSessionRunStore.getState().activeRuns[currentSessionId]
        if (run && run.status !== 'idle') {
            return null
        }
    }
    const currentSession = currentSessionId
        ? useSessionStore.getState().sessions.find((s) => s.id === currentSessionId)
        : undefined
    const modelId = currentSession?.modelId ?? useSettingsStore.getState().settings.modelId
    const modelSettings = useSettingsStore.getState().settings.modelSettings

    const catalogModels = useModelCatalogStore.getState().models
    const rawModels =
        catalogModels.length > 0 ? catalogModels : FALLBACK_MODEL_CATALOG
    const filteredModels = getFilteredModels(rawModels, modelSettings)
    const models = filteredModels.length > 0 ? filteredModels : rawModels
    if (models.length === 0) return null

    const currentIndex = models.findIndex((model: any) => model.id === modelId)
    if (currentIndex < 0) {
        const prevModel = models[0]
        useSettingsStore.getState().setModelId(prevModel.id)
        const normalized = normalizeModelPreferences(
            prevModel,
            currentSession?.reasoningEffort ?? useSettingsStore.getState().settings.reasoningLevel,
            currentSession?.speed ?? useSettingsStore.getState().settings.speed,
        )
        useSettingsStore.getState().setReasoningLevel(normalized.reasoningLevel)
        if (currentSessionId) {
            useSessionStore.getState().setSessionRuntimeSettings(currentSessionId, {
                modelId: prevModel.id,
                reasoningEffort: normalized.reasoningLevel,
                speed: normalized.speed,
            })
        }
        return prevModel.id
    }

    if (currentIndex <= 0) {
        return null
    }

    const prevModel = models[currentIndex - 1]
    useSettingsStore.getState().setModelId(prevModel.id)
    const normalized = normalizeModelPreferences(
        prevModel,
        currentSession?.reasoningEffort ?? useSettingsStore.getState().settings.reasoningLevel,
        currentSession?.speed ?? useSettingsStore.getState().settings.speed,
    )
    useSettingsStore.getState().setReasoningLevel(normalized.reasoningLevel)
    if (currentSessionId) {
        useSessionStore.getState().setSessionRuntimeSettings(currentSessionId, {
            modelId: prevModel.id,
            reasoningEffort: normalized.reasoningLevel,
            speed: normalized.speed,
        })
    }
    return prevModel.id
}

/**
 * Opens or toggles the quick model selector in the active composer.
 */
export function executeOpenModelSelectorAction(): void {
    const currentSessionId = useSessionStore.getState().currentSessionId
    if (currentSessionId) {
        const run = useSessionRunStore.getState().activeRuns[currentSessionId]
        if (run && run.status !== 'idle') {
            return
        }
    }
    rendererEventBus.emit('composer:toggle-model-selector')
}

/**
 * Triggers the open folder / add local project action.
 */
export function executeOpenFolderAction(): void {
    rendererEventBus.emit('composer:open-folder')
}

export function executeToggleSearchAction(): void {
    useUiStore.getState().toggleSearchOpen()
}

/**
 * Toggles the pinned status of the current active chat session.
 * Returns the updated pinned boolean state, or null if no active non-archived chat session is selected.
 */
export function executeTogglePinAction(): boolean | null {
    const currentSessionId = useSessionStore.getState().currentSessionId
    if (!currentSessionId) return null

    const session = useSessionStore
        .getState()
        .sessions.find((s) => s.id === currentSessionId && s.archivedAt === undefined)
    if (!session) return null

    useSessionStore.getState().togglePin(currentSessionId)
    schedulePersist()

    const updatedSession = useSessionStore
        .getState()
        .sessions.find((s) => s.id === currentSessionId)
    return updatedSession ? Boolean(updatedSession.pinned) : null
}

/**
 * Marks the currently active session as unread.
 * Returns the session id if marked, or null if no active non-archived session is selected.
 */
export function executeMarkAsUnreadAction(): string | null {
    const currentSessionId = useSessionStore.getState().currentSessionId
    if (!currentSessionId) return null

    const session = useSessionStore
        .getState()
        .sessions.find((s) => s.id === currentSessionId && s.archivedAt === undefined)
    if (!session) return null

    useSessionStore.getState().markUnreadManually(currentSessionId)
    schedulePersist()
    return currentSessionId
}

/**
 * Forks the currently active chat session.
 * Returns the new session id, or null if no active session is selected.
 */
export function executeForkChatAction(navigate?: NavigateFn): string | null {
    const currentSessionId = useSessionStore.getState().currentSessionId
    if (!currentSessionId) return null
    return forkSession({ sessionId: currentSessionId, navigate })
}

/**
 * Focuses the main chat input bar at the bottom of the main interface.
 */
export function executeFocusMainChatInputAction(): void {
    if (useUiStore.getState().settingsOpen) {
        useUiStore.getState().setSettingsOpen(false)
    }

    if (useUiStore.getState().searchOpen) {
        useUiStore.getState().setSearchOpen(false)
    }

    if (useUiStore.getState().rightSidebarMaximized) {
        useUiStore.getState().setRightSidebarMaximized(false)
    }

    rendererEventBus.emit('composer:focus')
}

/**
 * Stops or pauses current agent execution.
 */
export function executeStopExecutionAction(): void {
    rendererEventBus.emit('composer:stop')
}

