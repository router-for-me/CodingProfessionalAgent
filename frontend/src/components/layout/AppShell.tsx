import { useEffect } from 'react'
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { ExtensionSlot } from '@/plugins/registry/ExtensionSlot'
import { FloatingOverlayHost } from '@/plugins/registry/FloatingOverlayHost'
import { SettingsPanel } from '@/components/settings/SettingsPanel'
import { ToastHost } from '@/components/ui/ToastHost'
import { cn } from '@/lib/cn'
import { dismissSplashScreen } from '@/lib/splash'
import { useUiStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useModelCatalogStore } from '@/stores/modelCatalogStore'
import { useWorktreeSetupStore } from '@/stores/worktreeSetupStore'
import { SubAgentPanel } from '@/components/subagent/SubAgentPanel'
import { BottomPanel } from './BottomPanel'
import { useAgentStream } from '@/features/agent/useAgentStream'
import { useAutoResume } from '@/features/agent/useAutoResume'
import { useAppKeyboardShortcuts } from '@/features/shortcuts/useAppKeyboardShortcuts'
import { useCurrentViewLayout } from '@/plugins/platform/contributions/views'
import { ChatSearchModal } from '@/components/chat/ChatSearchModal'
import { StartupSplashOverlay } from './StartupSplashOverlay'
import { MainTitleBar } from './MainTitleBar'
import { PinnedSummary } from './PinnedSummary'
import { Sidebar } from './Sidebar'
import { WindowToolbar } from './WindowToolbar'

/**
 * Top-level application chrome: pure host slot skeleton hosting
 * sidebar + main outlet + composer + overlays.
 */
export function AppShell() {
    const layout = useCurrentViewLayout()
    const chatSessionId = useRouterState({
        select: (state) => {
            const match = state.location.pathname.match(/^\/chat\/([^/]+)/)
            return match?.[1] ?? null
        },
    })
    const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
    const rightSidebarCollapsed = useUiStore((s) => s.rightSidebarCollapsed)
    const rightSidebarMaximized = useUiStore((s) => s.rightSidebarMaximized)
    const pinnedSummaryVisible = useUiStore((s) => s.pinnedSummaryVisible)
    const sessions = useSessionStore((s) => s.sessions)
    const sessionTitle =
        sessions.find((session) => session.id === chatSessionId)?.title ?? null

    const navigate = useNavigate()
    useAppKeyboardShortcuts(navigate)

    const { resumeSession, isReady } = useAgentStream()
    const modelCatalogStatus = useModelCatalogStore((s) => s.status)
    const cliProxyApi = useSettingsStore((s) => s.settings.cliProxyApi)
    const isConfigured = Boolean(cliProxyApi.baseUrl.trim() && cliProxyApi.apiKey.trim())
    const isAutoResumeReady = Boolean((isReady ?? true) && isConfigured && modelCatalogStatus === 'ready')
    useAutoResume(resumeSession, isAutoResumeReady)

    useEffect(() => {
        dismissSplashScreen()
    }, [])

    useEffect(() => {
        const currentSessionId = useSessionStore.getState().currentSessionId
        if (chatSessionId !== currentSessionId) {
            useSessionStore.getState().setCurrentSession(chatSessionId)
        }
        const targetSession = useSessionStore
            .getState()
            .sessions.find((s) => s.id === chatSessionId)
        useUiStore.getState().restoreForSession(targetSession?.rightSidebar ?? null)
        if (chatSessionId) {
            const setup = useWorktreeSetupStore.getState().getSetup(chatSessionId)
            const isWorktreeError = setup?.status === 'error'
            if (isWorktreeError) {
                useUiStore.getState().setPinnedSummaryVisible(false)
            } else if (targetSession?.pinnedSummaryVisible !== undefined) {
                useUiStore.getState().setPinnedSummaryVisible(targetSession.pinnedSummaryVisible)
            } else {
                useUiStore.getState().setPinnedSummaryVisible(true)
            }
        } else {
            useUiStore.getState().setPinnedSummaryVisible(false)
        }
    }, [chatSessionId])

    const hasActiveSession = Boolean(chatSessionId)
    const rightSidebarVisible = !rightSidebarCollapsed
    const isRightMaximized = rightSidebarVisible && rightSidebarMaximized

    return (
        <div className="app-background-surface relative flex h-full w-full bg-[var(--bg-app)] text-[var(--text-primary)]">
            <Sidebar />
            <main
                className={cn(
                    'relative flex flex-col overflow-hidden',
                    isRightMaximized
                        ? 'w-0 flex-none opacity-0 pointer-events-none'
                        : 'min-w-0 flex-1 opacity-100',
                    'transition-[width,flex,opacity] duration-300 ease-out'
                )}
                style={{
                    flex: isRightMaximized ? '0 0 0px' : '1 1 0%',
                    width: isRightMaximized ? 0 : undefined,
                }}
                aria-hidden={isRightMaximized}
                inert={isRightMaximized}
            >
                <MainTitleBar
                    leftSidebarCollapsed={sidebarCollapsed}
                    showPinnedSummaryToggle={hasActiveSession && rightSidebarVisible}
                    reserveWindowToolbar={!rightSidebarVisible && layout.reserveWindowToolbar}
                    sessionTitle={sessionTitle}
                />
                <div className="relative min-h-0 flex-1 overflow-hidden">
                    {hasActiveSession && pinnedSummaryVisible ? (
                        <div className="pointer-events-none absolute top-2 right-3 z-10">
                            <PinnedSummary sessionId={chatSessionId} />
                        </div>
                    ) : null}
                    <ExtensionSlot
                        name="workspace.main"
                        fallback={<Outlet />}
                    />
                    {layout.showComposer ? (
                        <ExtensionSlot name="workspace.composer" />
                    ) : null}
                </div>
                <BottomPanel />
            </main>
            {layout.rightPanelMode === 'hidden' ? null : (
                <SubAgentPanel sessionId={chatSessionId} />
            )}
            <WindowToolbar includePinnedSummary={hasActiveSession && !rightSidebarVisible} />
            <FloatingOverlayHost context={{ sessionId: chatSessionId }} />
            <ExtensionSlot name="workspace.overlay" />
            <SettingsPanel />
            <ChatSearchModal />
            <ToastHost />
            <StartupSplashOverlay />
        </div>
    )
}
