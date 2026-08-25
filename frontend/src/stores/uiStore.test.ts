import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useUiStore, flushDebouncedWidthSync } from './uiStore'
import { useSessionStore } from './sessionStore'

describe('uiStore - right panel tabs', () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: [],
      currentSessionId: null,
    })
    useUiStore.setState({
      rightPanelOpenTabs: [],
      rightPanelActiveTab: null,
      rightPanelTabParams: {},
      rightSidebarCollapsed: true,
      rightSidebarMaximized: false,
      rightSidebarWidth: null,
    })
  })

  afterEach(() => {
    flushDebouncedWidthSync()
    vi.useRealTimers()
  })

  it('restores right sidebar state for a session and resets cleanly when null', () => {
    useUiStore.getState().restoreForSession({
      collapsed: true,
      maximized: true,
      width: 350,
      activeTab: 'file-manager',
      openTabs: ['terminal', 'file-manager'],
      tabParams: { 'file-manager': { activeFilePath: 'test.ts' } },
    })

    let state = useUiStore.getState()
    expect(state.rightSidebarCollapsed).toBe(true)
    expect(state.rightSidebarMaximized).toBe(true)
    expect(state.rightSidebarWidth).toBe(350)
    expect(state.rightPanelActiveTab).toBe('file-manager')
    expect(state.rightPanelOpenTabs).toEqual(['terminal', 'file-manager'])
    expect(state.rightPanelTabParams['file-manager']).toEqual({ activeFilePath: 'test.ts' })

    // Reset when switching to session without saved state
    useUiStore.getState().restoreForSession(null)
    state = useUiStore.getState()
    expect(state.rightSidebarCollapsed).toBe(true)
    expect(state.rightSidebarMaximized).toBe(false)
    expect(state.rightSidebarWidth).toBeNull()
    expect(state.rightPanelActiveTab).toBeNull()
    expect(state.rightPanelOpenTabs).toEqual([])
    expect(state.rightPanelTabParams).toEqual({})
  })

  it('automatically writes back right sidebar mutations to current active session', () => {
    const sessionId = useSessionStore.getState().createSession({ title: 'Test Auto Sync' })
    useSessionStore.getState().setCurrentSession(sessionId)

    useUiStore.getState().openRightPanelTab('review', { activate: true, params: { mode: 'branchCompare' } })

    let session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.rightSidebar?.openTabs).toContain('review')
    expect(session?.rightSidebar?.activeTab).toBe('review')
    expect(session?.rightSidebar?.tabParams?.review).toEqual({ mode: 'branchCompare' })
    expect(session?.rightSidebar?.collapsed).toBe(false)

    useUiStore.getState().setRightSidebarWidth(400)
    flushDebouncedWidthSync()
    session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.rightSidebar?.width).toBe(400)

    useUiStore.getState().setRightSidebarMaximized(true)
    session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.rightSidebar?.maximized).toBe(true)

    useUiStore.getState().setRightSidebarCollapsed(true)
    session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.rightSidebar?.collapsed).toBe(true)
    expect(session?.rightSidebar?.maximized).toBe(false)

    useUiStore.getState().toggleRightSidebarCollapsed()
    session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.rightSidebar?.collapsed).toBe(false)

    useUiStore.getState().toggleRightSidebarMaximized()
    session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.rightSidebar?.maximized).toBe(true)

    useUiStore.getState().closeRightPanelTab('review')
    session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.rightSidebar?.openTabs).toEqual([])
    expect(session?.rightSidebar?.activeTab).toBeNull()

    useUiStore.getState().setActiveRightPanelTab('terminal')
    session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.rightSidebar?.activeTab).toBe('terminal')

    useUiStore.getState().setRightPanelTabParams('terminal', { cwd: '/workspace' })
    session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.rightSidebar?.tabParams?.terminal).toEqual({ cwd: '/workspace' })
  })

  it('does not fail and does not write to sessionStore when currentSessionId is null', () => {
    useSessionStore.setState({ sessions: [], currentSessionId: null })

    expect(() => {
      useUiStore.getState().toggleRightSidebarCollapsed()
      useUiStore.getState().setRightSidebarCollapsed(true)
      useUiStore.getState().toggleRightSidebarMaximized()
      useUiStore.getState().setRightSidebarMaximized(true)
      useUiStore.getState().setRightSidebarWidth(360)
      useUiStore.getState().openRightPanelTab('review', { activate: true, params: { mode: 'branchCompare' } })
      useUiStore.getState().setActiveRightPanelTab('review')
      useUiStore.getState().setRightPanelTabParams('review', { mode: 'workingTree' })
      useUiStore.getState().closeRightPanelTab('review')
    }).not.toThrow()

    expect(useSessionStore.getState().sessions).toEqual([])
    expect(useSessionStore.getState().currentSessionId).toBeNull()
  })

  it('opens a panel tab, activates it, and automatically expands sidebar', () => {
    const { openRightPanelTab } = useUiStore.getState()
    openRightPanelTab('review', { activate: true, params: { mode: 'workingTree' } })

    const state = useUiStore.getState()
    expect(state.rightPanelOpenTabs).toEqual(['review'])
    expect(state.rightPanelActiveTab).toBe('review')
    expect(state.rightPanelTabParams.review).toEqual({ mode: 'workingTree' })
    expect(state.rightSidebarCollapsed).toBe(false)
  })

  it('closes an active tab and switches to remaining tab or null', () => {
    const { openRightPanelTab, closeRightPanelTab } = useUiStore.getState()
    openRightPanelTab('review')
    openRightPanelTab('file-manager')

    expect(useUiStore.getState().rightPanelActiveTab).toBe('file-manager')

    closeRightPanelTab('file-manager')
    expect(useUiStore.getState().rightPanelOpenTabs).toEqual(['review'])
    expect(useUiStore.getState().rightPanelActiveTab).toBe('review')

    closeRightPanelTab('review')
    expect(useUiStore.getState().rightPanelOpenTabs).toEqual([])
    expect(useUiStore.getState().rightPanelActiveTab).toBeNull()
  })

  it('opens a panel tab with activate: false without changing active tab or expanding sidebar', () => {
    const { openRightPanelTab } = useUiStore.getState()
    openRightPanelTab('terminal', { activate: false, params: { cwd: '/tmp' } })

    const state = useUiStore.getState()
    expect(state.rightPanelOpenTabs).toEqual(['terminal'])
    expect(state.rightPanelActiveTab).toBeNull()
    expect(state.rightPanelTabParams.terminal).toEqual({ cwd: '/tmp' })
    expect(state.rightSidebarCollapsed).toBe(true)
  })

  it('does not duplicate tab if already open and updates params/active status', () => {
    const { openRightPanelTab } = useUiStore.getState()
    openRightPanelTab('review')
    openRightPanelTab('file-manager')
    openRightPanelTab('review', { params: { mode: 'branchCompare' } })

    const state = useUiStore.getState()
    expect(state.rightPanelOpenTabs).toEqual(['review', 'file-manager'])
    expect(state.rightPanelActiveTab).toBe('review')
    expect(state.rightPanelTabParams.review).toEqual({ mode: 'branchCompare' })
  })

  it('closing a non-active tab does not change active tab', () => {
    const { openRightPanelTab, closeRightPanelTab } = useUiStore.getState()
    openRightPanelTab('review')
    openRightPanelTab('file-manager')

    expect(useUiStore.getState().rightPanelActiveTab).toBe('file-manager')
    closeRightPanelTab('review')

    const state = useUiStore.getState()
    expect(state.rightPanelOpenTabs).toEqual(['file-manager'])
    expect(state.rightPanelActiveTab).toBe('file-manager')
  })

  it('setActiveRightPanelTab updates active tab directly', () => {
    const { setActiveRightPanelTab } = useUiStore.getState()
    setActiveRightPanelTab('subagent')
    expect(useUiStore.getState().rightPanelActiveTab).toBe('subagent')

    setActiveRightPanelTab(null)
    expect(useUiStore.getState().rightPanelActiveTab).toBeNull()
  })

  it('setRightPanelTabParams updates params for specific tab', () => {
    const { setRightPanelTabParams } = useUiStore.getState()
    setRightPanelTabParams('file-manager', { activeFilePath: '/src/index.ts' })

    expect(useUiStore.getState().rightPanelTabParams['file-manager']).toEqual({
      activeFilePath: '/src/index.ts',
    })
  })

  it('syncs width to sessionStore while updating uiStore immediately', () => {
    const sessionId = useSessionStore.getState().createSession({ title: 'Width Test' })
    useSessionStore.getState().setCurrentSession(sessionId)

    useUiStore.getState().setRightSidebarWidth(300)
    expect(useUiStore.getState().rightSidebarWidth).toBe(300)
    let session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.rightSidebar?.width).toBe(300)

    useUiStore.getState().setRightSidebarWidth(420)
    expect(useUiStore.getState().rightSidebarWidth).toBe(420)
    session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.rightSidebar?.width).toBe(420)
  })

  it('flushDebouncedWidthSync is a safe no-op retaining compatibility', () => {
    const sessionId = useSessionStore.getState().createSession({ title: 'Flush Test' })
    useSessionStore.getState().setCurrentSession(sessionId)

    useUiStore.getState().setRightSidebarWidth(390)
    expect(useUiStore.getState().rightSidebarWidth).toBe(390)
    let session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.rightSidebar?.width).toBe(390)

    flushDebouncedWidthSync()
    session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.rightSidebar?.width).toBe(390)
  })

  it('syncs pinnedSummaryVisible updates to current active session', () => {
    const sessionId = useSessionStore.getState().createSession({ title: 'Pinned Summary Sync Test' })
    useSessionStore.getState().setCurrentSession(sessionId)

    useUiStore.getState().setPinnedSummaryVisible(false)
    let session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.pinnedSummaryVisible).toBe(false)

    useUiStore.getState().togglePinnedSummaryVisible()
    session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.pinnedSummaryVisible).toBe(true)
  })
})
