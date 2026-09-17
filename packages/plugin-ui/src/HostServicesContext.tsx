export type {
    AppSettings,
}

import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useSyncExternalStore,
    type ReactNode,
} from 'react'
import type {
    AppSettings,
    AgentRunState,
    ChatRendererContribution,
    HostServices,
    NavigationContribution,
    Project,
    RendererContributionsService,
    SelectChatRendererOptions,
    ServiceToken,
    SessionItem,
    UiService,
} from '@cpa/plugin-api'
import {
    HOST_SERVICE_TOKENS,
    NavigationServiceToken,
    ProjectServiceToken,
    RendererContributionsServiceToken,
    SessionServiceToken,
    SettingsServiceToken,
    SkillUsageServiceToken,
    UiServiceToken,
    ChatMessageServiceToken,
    SubAgentServiceToken,
    type ChatMessageService,
    type SubAgentRecord,
    type SubAgentService,
} from '@cpa/plugin-api'

const HostServicesReactContext = createContext<HostServices | null>(null)

let defaultHostServices: HostServices | null = null

export function setDefaultHostServices(services: HostServices | null): void {
    defaultHostServices = services
}

export function getDefaultHostServices(): HostServices | null {
    return defaultHostServices
}

export interface HostServicesProviderProps {
    services?: HostServices
    children: ReactNode
}

export function HostServicesProvider({
    services,
    children,
}: HostServicesProviderProps) {
    const value = useMemo(() => services ?? defaultHostServices, [services])
    return (
        <HostServicesReactContext.Provider value={value}>
            {children}
        </HostServicesReactContext.Provider>
    )
}

export function useHostServices(): HostServices | null {
    const ctx = useContext(HostServicesReactContext)
    return ctx ?? defaultHostServices
}

export function useHostService<T>(token: ServiceToken<T> | string): T | null {
    const services = useHostServices()
    if (!services) return null
    const tokenId = typeof token === 'string' ? token : token.id
    const match = Object.entries(HOST_SERVICE_TOKENS).find(
        ([, t]) => t.id === tokenId,
    )
    if (match) {
        const key = match[0] as keyof HostServices
        return ((services as any)[key] as T) ?? null
    }
    return ((services as any)[tokenId] as T) ?? null
}

const EMPTY_SESSIONS: readonly SessionItem[] = Object.freeze([])
const EMPTY_PROJECTS: readonly Project[] = Object.freeze([])
const EMPTY_NAV_ITEMS: readonly NavigationContribution[] = Object.freeze([])
const EMPTY_SKILL_USAGE_COUNTS: Record<string, number> = Object.freeze({})
const EMPTY_AVAILABLE_SKILLS: readonly any[] = Object.freeze([])

const DEFAULT_FALLBACK_SETTINGS: AppSettings = Object.freeze({
    theme: 'dark',
    locale: 'zh-CN',
    modelId: '',
    reasoningLevel: '',
    speed: 'standard',
    compactionThresholdPercent: 80,
    fastContextCompaction: true,
    resumeUnfinishedConversations: true,
    preventSleep: true,
    showInMenuBar: true,
    showBottomPanel: true,
    terminalPosition: 'bottom',
    cliProxyApi: { baseUrl: '', apiKey: '' },
    themePreset: 'codex',
    accentColor: '#339CFF',
    backgroundColor: '#181818',
    foregroundColor: '#FFFFFF',
    uiFontFamily: 'system',
    uiFontWeight: 'normal',
    codeFontFamily: 'system',
    codeFontWeight: 'normal',
    contrast: 60,
    compactMode: false,
    showLineNumbers: true,
    wordWrap: true,
    uiScale: 100,
    uiFontSize: 14,
    codeFontSize: 12,
    fontSmoothing: true,
    localMemoryEnabled: true,
    toolAssistedMemoryEnabled: false,
    personality: 'pragmatic',
    editor: {
        showContextUsage: true,
        sendShortcut: 'cmdEnter',
        followUpMode: 'steer',
    },
}) as AppSettings

function shallowSettingsEqual(objA: any, objB: any): boolean {
    if (Object.is(objA, objB)) return true
    if (
        typeof objA !== 'object' ||
        objA === null ||
        typeof objB !== 'object' ||
        objB === null
    ) {
        return false
    }
    const keysA = Object.keys(objA)
    const keysB = Object.keys(objB)
    if (keysA.length !== keysB.length) return false
    for (let i = 0; i < keysA.length; i++) {
        const key = keysA[i]
        const valA = objA[key]
        const valB = objB[key]
        if (Object.is(valA, valB)) continue
        if (
            typeof valA === 'object' &&
            valA !== null &&
            typeof valB === 'object' &&
            valB !== null
        ) {
            if (!shallowSettingsEqual(valA, valB)) return false
        } else {
            return false
        }
    }
    return true
}

const settingsSnapshotCache = new WeakMap<object, { raw: any; snapshot: AppSettings }>()

function getCachedSettingsSnapshot(service: any): AppSettings {
    if (!service || typeof service.getSnapshot !== 'function') {
        return DEFAULT_FALLBACK_SETTINGS
    }
    const raw = service.getSnapshot()
    if (!raw || typeof raw !== 'object') {
        return DEFAULT_FALLBACK_SETTINGS
    }
    const entry = settingsSnapshotCache.get(service)
    if (entry && shallowSettingsEqual(entry.raw, raw)) {
        return entry.snapshot
    }
    const snapshot = raw as AppSettings
    settingsSnapshotCache.set(service, { raw, snapshot })
    return snapshot
}

export function useSettings(): AppSettings {
    const settingsService = useHostService(SettingsServiceToken)
    return useSyncExternalStore(
        (callback) => {
            if (settingsService?.subscribe) {
                return settingsService.subscribe(callback)
            }
            return () => {}
        },
        () => getCachedSettingsSnapshot(settingsService),
        () => DEFAULT_FALLBACK_SETTINGS,
    )
}

export function useSessions(): readonly SessionItem[] {
    const sessionService = useHostService(SessionServiceToken)
    return useSyncExternalStore(
        (callback) => {
            if (sessionService?.subscribe) {
                return sessionService.subscribe(callback)
            }
            return () => {}
        },
        () => (sessionService?.getSnapshot ? sessionService.getSnapshot() : EMPTY_SESSIONS),
        () => EMPTY_SESSIONS,
    )
}

export function useProjects(): readonly Project[] {
    const projectService = useHostService(ProjectServiceToken)
    return useSyncExternalStore(
        (callback) => {
            if (projectService?.subscribe) {
                return projectService.subscribe(callback)
            }
            return () => {}
        },
        () => (projectService?.getSnapshot ? projectService.getSnapshot() : EMPTY_PROJECTS),
        () => EMPTY_PROJECTS,
    )
}

export function useAvailableSkills(): readonly any[] {
    const service = useHostService(SkillUsageServiceToken)
    return useSyncExternalStore(
        useCallback((listener: () => void) =>
            service?.subscribeAvailableSkills?.(listener) ?? (() => {}), [service]),
        useCallback(() => {
            const skills = service?.getAvailableSkills?.()
            if (skills?.length) return skills
            // Older publishers expose their catalog through the shared compatibility cache.
            const published = (globalThis as any).__cpaComposerSkills
            return Array.isArray(published) && published.length > 0
                ? published
                : EMPTY_AVAILABLE_SKILLS
        }, [service]),
        () => EMPTY_AVAILABLE_SKILLS,
    )
}

export function useSkillUsageCounts(): Record<string, number> {
    const skillUsageService = useHostService(SkillUsageServiceToken)
    return useSyncExternalStore(
        (callback) => {
            if (skillUsageService?.subscribe) {
                return skillUsageService.subscribe(callback)
            }
            return () => {}
        },
        () =>
            skillUsageService?.getSnapshot
                ? skillUsageService.getSnapshot()
                : EMPTY_SKILL_USAGE_COUNTS,
        () => EMPTY_SKILL_USAGE_COUNTS,
    )
}

export function useNavigationItems(): readonly NavigationContribution[] {
    const navigationService = useHostService(NavigationServiceToken)
    return useSyncExternalStore(
        (callback) => {
            if (navigationService?.subscribe) {
                return navigationService.subscribe(callback)
            }
            return () => {}
        },
        () => (navigationService?.getNavigationItems ? navigationService.getNavigationItems() : EMPTY_NAV_ITEMS),
        () => EMPTY_NAV_ITEMS,
    )
}

export function useUiState<T>(selector?: (ui: any) => T): any {
    const uiService = useHostService(UiServiceToken)
    return useSyncExternalStore(
        (callback) => {
            if (uiService?.subscribe) {
                return uiService.subscribe(callback)
            }
            return () => {}
        },
        () => {
            const state = uiService?.getSnapshot ? uiService.getSnapshot() : null
            return selector ? selector(state) : state
        },
        () => null,
    )
}

export function useActiveRun(sessionId?: string): any {
    const sessionService = useHostService(SessionServiceToken)
    return useSyncExternalStore(
        (callback) => {
            if (sessionService?.subscribeRuns) {
                return sessionService.subscribeRuns(callback)
            }
            return () => {}
        },
        () => (sessionId && sessionService?.getActiveRun ? sessionService.getActiveRun(sessionId) : null),
        () => null,
    )
}

const EMPTY_MESSAGES: readonly any[] = Object.freeze([])
const EMPTY_OVERLAYS_MAP = Object.freeze({} as Record<string, never>)
const EMPTY_CHAT_RENDERERS: readonly ChatRendererContribution<any>[] = Object.freeze([])
const DEFAULT_RUN_STATE: AgentRunState = Object.freeze({ isStreaming: false, activeRunId: null })

const runStateCache = new Map<string, AgentRunState>()

export function useChatMessageService(): ChatMessageService | null {
    return useHostService(ChatMessageServiceToken)
}

export function useRendererContributions(): RendererContributionsService | null {
    return useHostService(RendererContributionsServiceToken)
}

export function useDisplayMessages(sessionId?: string | null): readonly any[] {
    const chatService = useChatMessageService()
    const subscribe = useCallback(
        (callback: () => void) => {
            if (sessionId && chatService?.subscribeMessages) {
                return chatService.subscribeMessages(sessionId, callback)
            }
            return () => {}
        },
        [chatService, sessionId],
    )
    const getSnapshot = useCallback(() => {
        return chatService && sessionId && typeof chatService.getDisplayMessages === 'function'
            ? chatService.getDisplayMessages(sessionId)
            : EMPTY_MESSAGES
    }, [chatService, sessionId])

    return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_MESSAGES)
}

export function useToolOverlays(sessionId: string): Readonly<Record<string, any>> {
    const chatService = useChatMessageService()
    const subscribe = useCallback(
        (callback: () => void) => {
            if (chatService?.subscribeToolOverlays) {
                return chatService.subscribeToolOverlays(sessionId, callback)
            }
            return () => {}
        },
        [chatService, sessionId],
    )
    const getSnapshot = useCallback(() => {
        return chatService && sessionId && chatService.getToolOverlays ? chatService.getToolOverlays(sessionId) : EMPTY_OVERLAYS_MAP
    }, [chatService, sessionId])

    return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_OVERLAYS_MAP)
}

export function useIsCompacting(sessionId: string): boolean {
    const chatService = useChatMessageService()
    const subscribe = useCallback(
        (callback: () => void) => {
            if (chatService?.subscribeCompaction) {
                return chatService.subscribeCompaction(sessionId, callback)
            }
            return () => {}
        },
        [chatService, sessionId],
    )
    const getSnapshot = useCallback(() => {
        return chatService && sessionId && chatService.isCompacting ? chatService.isCompacting(sessionId) : false
    }, [chatService, sessionId])

    return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

export function useWorktreeSetup(sessionId: string): any {
    const chatService = useChatMessageService()
    const subscribe = useCallback(
        (callback: () => void) => {
            if (chatService?.subscribeWorktreeSetup) {
                return chatService.subscribeWorktreeSetup(sessionId, callback)
            }
            return () => {}
        },
        [chatService, sessionId],
    )
    const getSnapshot = useCallback(() => {
        return chatService && sessionId && chatService.getWorktreeSetup ? chatService.getWorktreeSetup(sessionId) : null
    }, [chatService, sessionId])

    return useSyncExternalStore(subscribe, getSnapshot, () => null)
}

export function useSupportsImages(sessionId?: string | null): boolean {
    const chatService = useChatMessageService()
    const subscribe = useCallback(
        (callback: () => void) => {
            if (chatService?.subscribeSupportsImages) {
                return chatService.subscribeSupportsImages(sessionId ?? null, callback)
            }
            return () => {}
        },
        [chatService, sessionId],
    )
    const getSnapshot = useCallback(() => {
        return chatService && chatService.getSupportsImages
            ? chatService.getSupportsImages(sessionId ?? null)
            : true
    }, [chatService, sessionId])

    return useSyncExternalStore(subscribe, getSnapshot, () => true)
}

const EMPTY_PROMPTS: readonly any[] = Object.freeze([])

export function usePrompts(): readonly any[] {
    const chatService = useChatMessageService()
    const subscribe = useCallback(
        (callback: () => void) => {
            if (chatService?.subscribePrompts) {
                return chatService.subscribePrompts(callback)
            }
            return () => {}
        },
        [chatService],
    )
    const getSnapshot = useCallback(() => {
        return chatService && chatService.getPrompts
            ? chatService.getPrompts()
            : EMPTY_PROMPTS
    }, [chatService])

    return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_PROMPTS)
}

export function useAgentRunState(sessionId: string): AgentRunState {
    const chatService = useChatMessageService()
    const subscribe = useCallback(
        (callback: () => void) => {
            if (sessionId && chatService?.subscribeAgentRunState) {
                return chatService.subscribeAgentRunState(sessionId, callback)
            }
            return () => {}
        },
        [chatService, sessionId],
    )
    const getSnapshot = useCallback(() => {
        if (!sessionId || !chatService?.getAgentRunState) return DEFAULT_RUN_STATE
        const state = chatService.getAgentRunState(sessionId)
        const cached = runStateCache.get(sessionId)
        if (
            cached &&
            cached.isStreaming === state.isStreaming &&
            cached.activeRunId === state.activeRunId &&
            cached.runState === state.runState
        ) {
            return cached
        }
        runStateCache.set(sessionId, state)
        return state
    }, [chatService, sessionId])

    return useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_RUN_STATE)
}

export function useSessionResumable(sessionId?: string | null): boolean {
    const chatService = useChatMessageService()
    const subscribe = useCallback(
        (callback: () => void) => {
            if (sessionId && chatService?.subscribeSessionResumable) {
                return chatService.subscribeSessionResumable(sessionId, callback)
            }
            if (sessionId && chatService?.subscribeMessages) {
                return chatService.subscribeMessages(sessionId, callback)
            }
            return () => {}
        },
        [chatService, sessionId],
    )
    const getSnapshot = useCallback(() => {
        if (!sessionId || !chatService?.isSessionResumable) return false
        return chatService.isSessionResumable(sessionId)
    }, [chatService, sessionId])

    return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

export function matchChatRenderer<T = unknown>(
    renderers: readonly ChatRendererContribution<any>[],
    value: T,
    options?: SelectChatRendererOptions,
): ChatRendererContribution<T> | undefined {
    const requestedTarget = options?.target ?? options?.scope
    const exclude = options?.excludeIds ? new Set(options.excludeIds) : null
    const candidates: ChatRendererContribution<any>[] = []

    for (const renderer of renderers) {
        if (exclude?.has(renderer.id)) continue
        const rendererTarget = renderer.target ?? renderer.scope
        if (requestedTarget && rendererTarget && rendererTarget !== requestedTarget) {
            continue
        }
        try {
            if (typeof renderer.matches === 'function' && renderer.matches(value)) {
                candidates.push(renderer)
            }
        } catch (err) {
            console.error(`[ChatRenderer] Error matching chat renderer "${renderer.id}":`, err)
        }
    }

    if (candidates.length === 0) return undefined
    candidates.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
    return candidates[0]
}

export function resolvePartGroupKey(
    part: any,
    renderers: readonly ChatRendererContribution<any>[],
): string | undefined {
    const matched = matchChatRenderer(renderers, part, { target: 'part' })
    if (!matched) return undefined
    if (typeof matched.groupKey === 'function') {
        return matched.groupKey(part)
    }
    if (typeof matched.groupKey === 'string') {
        return matched.groupKey
    }
    return undefined
}

let lastChatRenderers: readonly ChatRendererContribution<any>[] = EMPTY_CHAT_RENDERERS

function areRenderersEqual(
    a: readonly ChatRendererContribution<any>[],
    b: readonly ChatRendererContribution<any>[],
): boolean {
    if (a === b) return true
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (
            a[i]?.id !== b[i]?.id ||
            a[i]?.priority !== b[i]?.priority ||
            a[i]?.target !== b[i]?.target ||
            a[i]?.scope !== b[i]?.scope ||
            a[i]?.pluginId !== b[i]?.pluginId
        ) {
            return false
        }
    }
    return true
}

export function useChatRenderers(): readonly ChatRendererContribution<any>[] {
    const contribService = useRendererContributions()
    const subscribe = useCallback(
        (callback: () => void) => {
            if (contribService?.subscribeChatRenderers) {
                return contribService.subscribeChatRenderers(callback)
            }
            return () => {}
        },
        [contribService],
    )
    const getSnapshot = useCallback(() => {
        if (!contribService?.getChatRenderers) return EMPTY_CHAT_RENDERERS
        const renderers = contribService.getChatRenderers()
        if (!renderers || renderers.length === 0) return EMPTY_CHAT_RENDERERS
        if (areRenderersEqual(lastChatRenderers, renderers)) {
            return lastChatRenderers
        }
        lastChatRenderers = Object.freeze([...renderers])
        return lastChatRenderers
    }, [contribService])

    return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_CHAT_RENDERERS)
}

export function useChatRenderer<T = unknown>(
    value: T,
    options?: SelectChatRendererOptions,
): ChatRendererContribution<T> | undefined {
    const contribService = useRendererContributions()
    const renderers = useChatRenderers()
    const targetKey = options?.target ?? options?.scope ?? ''

    return useMemo(() => {
        if (contribService?.selectChatRenderer) {
            return contribService.selectChatRenderer(value, options)
        }
        return matchChatRenderer(renderers, value, options)
    }, [contribService, renderers, value, targetKey, options?.excludeIds?.join(',')])
}

export function useMessageRenderer<T = unknown>(
    message: T,
    options?: SelectChatRendererOptions,
): ChatRendererContribution<T> | undefined {
    const opts = useMemo(
        () => ({ ...options, target: options?.target ?? options?.scope ?? 'message' }),
        [options?.target, options?.scope, options?.excludeIds?.join(',')],
    )
    return useChatRenderer<T>(message, opts)
}

export function usePartRenderer<T = unknown>(
    part: T,
    options?: SelectChatRendererOptions,
): ChatRendererContribution<T> | undefined {
    const opts = useMemo(
        () => ({ ...options, target: options?.target ?? options?.scope ?? 'part' }),
        [options?.target, options?.scope, options?.excludeIds?.join(',')],
    )
    return useChatRenderer<T>(part, opts)
}

const EMPTY_SUBAGENTS: readonly SubAgentRecord[] = Object.freeze([])
const EMPTY_TAB_IDS: readonly string[] = Object.freeze([])

export function useSubAgentService(): SubAgentService | null {
    return useHostService(SubAgentServiceToken)
}

export function useSubAgents(parentSessionId?: string): readonly SubAgentRecord[] {
    const subAgentService = useSubAgentService()
    const subscribe = useCallback(
        (callback: () => void) => {
            if (subAgentService?.subscribe) {
                return subAgentService.subscribe(callback)
            }
            return () => {}
        },
        [subAgentService],
    )
    const getSnapshot = useCallback(() => {
        if (!subAgentService?.getAgents) return EMPTY_SUBAGENTS
        return subAgentService.getAgents(parentSessionId)
    }, [subAgentService, parentSessionId])

    return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SUBAGENTS)
}

export function useSubAgent(agentId?: string): SubAgentRecord | undefined {
    const subAgentService = useSubAgentService()
    const subscribe = useCallback(
        (callback: () => void) => {
            if (subAgentService?.subscribe) {
                return subAgentService.subscribe(callback)
            }
            return () => {}
        },
        [subAgentService],
    )
    const getSnapshot = useCallback(() => {
        if (!subAgentService?.getAgent || !agentId) return undefined
        return subAgentService.getAgent(agentId)
    }, [subAgentService, agentId])

    return useSyncExternalStore(subscribe, getSnapshot, () => undefined)
}

export function useSubAgentFocusedId(parentSessionId?: string): string | null {
    const subAgentService = useSubAgentService()
    const subscribe = useCallback(
        (callback: () => void) => {
            if (subAgentService?.subscribe) {
                return subAgentService.subscribe(callback)
            }
            return () => {}
        },
        [subAgentService],
    )
    const getSnapshot = useCallback(() => {
        if (!subAgentService?.getFocusedId || !parentSessionId) return null
        return subAgentService.getFocusedId(parentSessionId)
    }, [subAgentService, parentSessionId])

    return useSyncExternalStore(subscribe, getSnapshot, () => null)
}

export function useSubAgentOpenTabIds(parentSessionId?: string): readonly string[] {
    const subAgentService = useSubAgentService()
    const subscribe = useCallback(
        (callback: () => void) => {
            if (subAgentService?.subscribe) {
                return subAgentService.subscribe(callback)
            }
            return () => {}
        },
        [subAgentService],
    )
    const getSnapshot = useCallback(() => {
        if (!subAgentService?.getOpenTabIds || !parentSessionId) return EMPTY_TAB_IDS
        return subAgentService.getOpenTabIds(parentSessionId)
    }, [subAgentService, parentSessionId])

    return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_TAB_IDS)
}


