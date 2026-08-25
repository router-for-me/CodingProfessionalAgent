import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionRightSidebarState } from '@/types/models'
import { useSessionStore } from './sessionStore'

describe('sessionStore', () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: [],
      currentSessionId: null,
      manuallyMarkedUnreadSessionIds: [],
    })
  })

  it('creates a session and sets current', () => {
    const id = useSessionStore.getState().createSession({ title: 'New chat' })
    const state = useSessionStore.getState()
    expect(state.sessions).toHaveLength(1)
    expect(state.currentSessionId).toBe(id)
    expect(state.sessions[0].title).toBe('New chat')
  })

  it('createSession is idempotent when called with an existing session id', () => {
    useSessionStore.getState().hydrate({
      sessions: [
        {
          id: 'existing-id',
          title: 'Existing Session',
          pinned: false,
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: 'other-id',
          title: 'Other Session',
          pinned: false,
          createdAt: 200,
          updatedAt: 200,
        },
      ],
      currentSessionId: 'other-id',
    })

    const returnedId = useSessionStore.getState().createSession({ id: 'existing-id' })

    expect(returnedId).toBe('existing-id')
    const state = useSessionStore.getState()
    expect(state.sessions).toHaveLength(2)
    expect(state.sessions.filter((s) => s.id === 'existing-id')).toHaveLength(1)
    expect(state.currentSessionId).toBe('other-id')
  })

  it('removes session and clears current when needed', () => {
    const id = useSessionStore.getState().createSession({ title: 'A' })
    useSessionStore.getState().removeSession(id)
    expect(useSessionStore.getState().sessions).toHaveLength(0)
    expect(useSessionStore.getState().currentSessionId).toBeNull()
  })

  it('archives the current session and selects the newest active session', () => {
    useSessionStore.getState().hydrate({
      sessions: [
        {
          id: 'older',
          title: 'Older',
          pinned: false,
          createdAt: 1,
          updatedAt: 2,
        },
        {
          id: 'current',
          title: 'Current',
          pinned: true,
          createdAt: 2,
          updatedAt: 3,
        },
      ],
      currentSessionId: 'current',
    })

    useSessionStore.getState().archiveSession('current')

    const archivedState = useSessionStore.getState()
    expect(archivedState.sessions).toHaveLength(2)
    expect(
      archivedState.sessions.find((session) => session.id === 'current')
        ?.archivedAt,
    ).toEqual(expect.any(Number))
    expect(archivedState.currentSessionId).toBe('older')

    useSessionStore.getState().unarchiveSession('current')
    expect(
      useSessionStore
        .getState()
        .sessions.find((session) => session.id === 'current')?.archivedAt,
    ).toBeUndefined()
  })

  it('permanently removes all archived sessions only', () => {
    useSessionStore.getState().hydrate({
      sessions: [
        {
          id: 'active',
          title: 'Active',
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'archived',
          title: 'Archived',
          pinned: false,
          archivedAt: 3,
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      currentSessionId: 'archived',
    })

    useSessionStore.getState().removeArchivedSessions()

    const state = useSessionStore.getState()
    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0].id).toBe('active')
    expect(state.currentSessionId).toBe('active')
  })

  it('toggles pin', () => {
    const id = useSessionStore.getState().createSession({ title: 'A' })
    useSessionStore.getState().togglePin(id)
    expect(useSessionStore.getState().sessions[0].pinned).toBe(true)
    useSessionStore.getState().togglePin(id)
    expect(useSessionStore.getState().sessions[0].pinned).toBe(false)
  })

  it('marks unread and read', () => {
    const id = useSessionStore.getState().createSession({ title: 'A' })
    useSessionStore.getState().markUnread(id)
    expect(useSessionStore.getState().sessions[0].unread).toBe(true)
    useSessionStore.getState().markRead(id)
    expect(useSessionStore.getState().sessions[0].unread).toBeUndefined()
  })

  it('clears unread on the selected session when setCurrentSession is called with its id', () => {
    useSessionStore.getState().hydrate({
      sessions: [
        {
          id: 'a',
          title: 'A',
          unread: true,
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'b',
          title: 'B',
          unread: true,
          pinned: false,
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      currentSessionId: 'b',
    })

    useSessionStore.getState().setCurrentSession('a')

    const state = useSessionStore.getState()
    expect(state.currentSessionId).toBe('a')
    expect(state.sessions.find((s) => s.id === 'a')?.unread).toBeUndefined()
    expect(state.sessions.find((s) => s.id === 'b')?.unread).toBeUndefined()
  })

  it('keeps currentSessionId if present in hydrated data, else chooses first available', () => {
    useSessionStore.getState().hydrate({
      sessions: [
        {
          id: 'x',
          title: 'X',
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'y',
          title: 'Y',
          pinned: false,
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      currentSessionId: 'y',
    })
    expect(useSessionStore.getState().currentSessionId).toBe('y')

    useSessionStore.getState().hydrate({
      sessions: [
        {
          id: 'z',
          title: 'Z',
          pinned: false,
          createdAt: 3,
          updatedAt: 3,
        },
      ],
    })
    expect(useSessionStore.getState().currentSessionId).toBe('z')
  })

  it('selects the newest active session when hydrating if currentSessionId is archived', () => {
    useSessionStore.getState().hydrate({
      sessions: [
        {
          id: 'active',
          title: 'Active',
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'archived',
          title: 'Archived',
          pinned: false,
          archivedAt: 3,
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      currentSessionId: 'archived',
    })

    expect(useSessionStore.getState().currentSessionId).toBe('active')
  })

  it('updates session metadata pure in-memory on session mutations', () => {
    const id = useSessionStore.getState().createSession({ title: 'Meta Session' })
    expect(useSessionStore.getState().sessions.find((s) => s.id === id)?.title).toBe('Meta Session')

    useSessionStore.getState().renameSession(id, 'Renamed Session')
    expect(useSessionStore.getState().sessions.find((s) => s.id === id)?.title).toBe('Renamed Session')

    useSessionStore.getState().setSessionProject(id, 'proj-1')
    expect(useSessionStore.getState().sessions.find((s) => s.id === id)?.projectId).toBe('proj-1')

    useSessionStore.getState().setSessionBranch(id, 'feature-branch')
    expect(useSessionStore.getState().sessions.find((s) => s.id === id)?.branch).toBe('feature-branch')

    useSessionStore.getState().setSessionRuntimeSettings(id, {
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      speed: 'standard',
    })
    const session = useSessionStore.getState().sessions.find((s) => s.id === id)
    expect(session?.modelId).toBe('gpt-5.6-sol')
    expect(session?.reasoningEffort).toBe('xhigh')
    expect(session?.speed).toBe('standard')

    useSessionStore.getState().togglePin(id)
    expect(useSessionStore.getState().sessions.find((s) => s.id === id)?.pinned).toBe(true)

    useSessionStore.getState().archiveSession(id)
    expect(useSessionStore.getState().sessions.find((s) => s.id === id)?.archivedAt).toEqual(expect.any(Number))

    useSessionStore.getState().unarchiveSession(id)
    expect(useSessionStore.getState().sessions.find((s) => s.id === id)?.archivedAt).toBeUndefined()

    useSessionStore.getState().markUnread(id)
    expect(useSessionStore.getState().sessions.find((s) => s.id === id)?.unread).toBe(true)

    useSessionStore.getState().markRead(id)
    expect(useSessionStore.getState().sessions.find((s) => s.id === id)?.unread).toBeUndefined()

    useSessionStore.getState().removeSession(id)
    expect(useSessionStore.getState().sessions.find((s) => s.id === id)).toBeUndefined()
  })

  it('upserts remote session', () => {
    // Insert new session
    useSessionStore.getState().upsertRemoteSession({
      id: 'remote-1',
      title: 'Remote Session',
      pinned: false,
      createdAt: 100,
      updatedAt: 100,
    })

    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(useSessionStore.getState().sessions[0].title).toBe('Remote Session')

    // Update existing session
    useSessionStore.getState().upsertRemoteSession({
      id: 'remote-1',
      title: 'Updated Remote Session',
      pinned: true,
      createdAt: 100,
      updatedAt: 200,
    })

    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(useSessionStore.getState().sessions[0].title).toBe('Updated Remote Session')
    expect(useSessionStore.getState().sessions[0].pinned).toBe(true)
  })

  it('upsertRemoteSession is a no-op when data is unchanged', () => {
    const session = {
      id: 'remote-noop',
      title: 'Noop Session',
      projectId: 'p-1',
      branch: 'main',
      pinned: false,
      archivedAt: undefined,
      createdAt: 100,
      updatedAt: 200,
      unread: undefined,
      rightSidebar: {
        collapsed: false,
        activeTab: 'review',
      },
    }

    useSessionStore.getState().hydrate({
      sessions: [session],
      currentSessionId: 'remote-noop',
    })

    const prevSessions = useSessionStore.getState().sessions

    // Call upsertRemoteSession with identical data
    useSessionStore.getState().upsertRemoteSession({ ...session })

    // State reference is identical (no-op)
    expect(useSessionStore.getState().sessions).toBe(prevSessions)

    // Call upsertRemoteSession with changed rightSidebar
    useSessionStore.getState().upsertRemoteSession({
      ...session,
      rightSidebar: { collapsed: true, activeTab: 'browser' },
    })

    expect(useSessionStore.getState().sessions).not.toBe(prevSessions)
    expect(useSessionStore.getState().sessions[0].rightSidebar).toEqual({
      collapsed: true,
      activeTab: 'browser',
    })
  })

  it('removes remote session and updates currentSessionId', () => {
    useSessionStore.getState().hydrate({
      sessions: [
        { id: 'sess-1', title: 'Session 1', pinned: false, createdAt: 1, updatedAt: 10 },
        { id: 'sess-2', title: 'Session 2', pinned: false, createdAt: 2, updatedAt: 20 },
      ],
      currentSessionId: 'sess-2',
    })

    useSessionStore.getState().removeRemoteSession('sess-2')

    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(useSessionStore.getState().sessions[0].id).toBe('sess-1')
    expect(useSessionStore.getState().currentSessionId).toBe('sess-1')
  })

  it('updates session pinnedSummaryVisible via setSessionPinnedSummaryVisible', () => {
    const sessionId = useSessionStore.getState().createSession({ title: 'Pinned Summary Test' })
    expect(useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.pinnedSummaryVisible).toBeUndefined()

    useSessionStore.getState().setSessionPinnedSummaryVisible(sessionId, false)
    expect(useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.pinnedSummaryVisible).toBe(false)

    useSessionStore.getState().setSessionPinnedSummaryVisible(sessionId, true)
    expect(useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.pinnedSummaryVisible).toBe(true)
  })

  it('updates session rightSidebar', () => {
    const sessionId = useSessionStore.getState().createSession({ title: 'Test' })
    const sidebarState: SessionRightSidebarState = {
      collapsed: true,
      activeTab: 'review',
      openTabs: ['review'],
      tabParams: { review: { mode: 'branchCompare' } },
    }

    useSessionStore.getState().setSessionRightSidebar(sessionId, sidebarState)

    const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
    expect(session?.rightSidebar).toEqual(sidebarState)
  })

  it('merges partial updates into session rightSidebar without modifying updatedAt', () => {
    const initialUpdatedAt = 1234567890
    useSessionStore.getState().hydrate({
      sessions: [
        {
          id: 'sidebar-session',
          title: 'Sidebar Session',
          pinned: false,
          createdAt: 1000,
          updatedAt: initialUpdatedAt,
        },
      ],
      currentSessionId: 'sidebar-session',
    })

    useSessionStore.getState().setSessionRightSidebar('sidebar-session', {
      collapsed: true,
      activeTab: 'files',
      openTabs: ['files'],
    })

    useSessionStore.getState().setSessionRightSidebar('sidebar-session', {
      activeTab: 'review',
      openTabs: ['files', 'review'],
    })

    const session = useSessionStore.getState().sessions.find((s) => s.id === 'sidebar-session')
    expect(session?.rightSidebar).toEqual({
      collapsed: true,
      activeTab: 'review',
      openTabs: ['files', 'review'],
    })
    expect(session?.updatedAt).toBe(initialUpdatedAt)
  })

  it('sets and updates session firstPromptAt via setSessionFirstPromptAt', () => {
    const id = useSessionStore.getState().createSession({
      title: 'Prompt Time Test',
      firstPromptAt: 1000,
    })

    let session = useSessionStore.getState().sessions.find((s) => s.id === id)
    expect(session?.firstPromptAt).toBe(1000)

    useSessionStore.getState().setSessionFirstPromptAt(id, 2500)
    session = useSessionStore.getState().sessions.find((s) => s.id === id)
    expect(session?.firstPromptAt).toBe(2500)
  })

  it('marks session unread as normal (true) and error, and clears unread when switching into session via setCurrentSession', () => {
    const id1 = useSessionStore.getState().createSession({ title: 'Unread Test 1' })
    const id2 = useSessionStore.getState().createSession({ title: 'Unread Test 2' })

    useSessionStore.getState().setCurrentSession(id1)

    // Mark as unread on id2
    useSessionStore.getState().markUnread(id2, true)
    let session2 = useSessionStore.getState().sessions.find((s) => s.id === id2)
    expect(session2?.unread).toBe(true)

    // Mark as unread (error) on id2
    useSessionStore.getState().markUnread(id2, 'error')
    session2 = useSessionStore.getState().sessions.find((s) => s.id === id2)
    expect(session2?.unread).toBe('error')

    // Switch to id2 -> clears unread on id2
    useSessionStore.getState().setCurrentSession(id2)
    session2 = useSessionStore.getState().sessions.find((s) => s.id === id2)
    expect(session2?.unread).toBeUndefined()

    // Re-marking id2 as unread and selecting id2 again clears unread
    useSessionStore.getState().markUnread(id2, true)
    session2 = useSessionStore.getState().sessions.find((s) => s.id === id2)
    expect(session2?.unread).toBe(true)
    useSessionStore.getState().setCurrentSession(id2)
    session2 = useSessionStore.getState().sessions.find((s) => s.id === id2)
    expect(session2?.unread).toBeUndefined()
  })

  it('keeps manually marked unread state while leaving and clears it on the next entry', () => {
    const markedId = useSessionStore.getState().createSession({ title: 'Marked Session' })
    const otherId = useSessionStore.getState().createSession({ title: 'Other Session' })
    useSessionStore.getState().setCurrentSession(markedId)

    useSessionStore.getState().markUnreadManually(markedId)
    expect(
      useSessionStore.getState().sessions.find((session) => session.id === markedId)
        ?.unread,
    ).toBe(true)
    expect(useSessionStore.getState().manuallyMarkedUnreadSessionIds).toContain(markedId)

    useSessionStore.getState().setCurrentSession(otherId)
    expect(
      useSessionStore.getState().sessions.find((session) => session.id === markedId)
        ?.unread,
    ).toBe(true)

    useSessionStore.getState().upsertRemoteSession({
      id: markedId,
      title: 'Marked Session Remote Update',
      pinned: false,
      createdAt: 100,
      updatedAt: 200,
    })
    expect(
      useSessionStore.getState().sessions.find((session) => session.id === markedId)
        ?.unread,
    ).toBe(true)

    useSessionStore.getState().setCurrentSession(markedId)
    expect(
      useSessionStore.getState().sessions.find((session) => session.id === markedId)
        ?.unread,
    ).toBeUndefined()
    expect(useSessionStore.getState().manuallyMarkedUnreadSessionIds).not.toContain(markedId)
  })

  it('clears normal unread on remote update when session is actively viewed and not manually marked', () => {
    const activeId = useSessionStore.getState().createSession({ title: 'Active Session' })
    useSessionStore.getState().setCurrentSession(activeId)

    useSessionStore.getState().upsertRemoteSession({
      id: activeId,
      title: 'Active Session',
      unread: true,
      pinned: false,
      createdAt: 100,
      updatedAt: 200,
    })

    expect(
      useSessionStore.getState().sessions.find((session) => session.id === activeId)
        ?.unread,
    ).toBeUndefined()
  })
})
