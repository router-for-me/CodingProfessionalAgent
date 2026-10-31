import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as chatSearch from '@/features/search/searchChats'
import i18n from '@/i18n'
import { ChatSearchModal } from './ChatSearchModal'
import { useUiStore } from '@/stores/uiStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useProjectStore } from '@/stores/projectStore'
import { useMessageStore } from '@/stores/messageStore'

const mockNavigate = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}))

describe('ChatSearchModal', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await i18n.changeLanguage('en')
    useUiStore.setState({
      searchOpen: true,
      pendingSessionContext: { projectId: null, branch: null },
    })
    useSessionStore.setState({
      sessions: [
        {
          id: 's1',
          title: 'Respond to greeting',
          createdAt: 1000,
          updatedAt: 2000,
          pinned: false,
          projectId: 'p1',
        },
        {
          id: 's2',
          title: 'Project Architecture',
          createdAt: 1000,
          updatedAt: 3000,
          pinned: false,
          projectId: 'p1',
        },
      ],
      currentSessionId: 's1',
    })
    useProjectStore.setState({
      projects: [
        {
          id: 'p1',
          name: 'CLIProxyAPI',
          pinned: false,
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
    })
    useMessageStore.setState({
      entriesBySession: {
        s2: [
          {
            id: 'e1',
            sessionId: 's2',
            createdAt: 1000,
            kind: 'assistant',
            stopReason: 'stop',
            status: 'done',
            content: [
              {
                type: 'text',
                text: 'We are running a desktop shell environment.',
              },
            ],
          },
        ],
      },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('debounces nonempty queries and cancels superseded searches', async () => {
    vi.useFakeTimers()
    const search = vi.spyOn(chatSearch, 'searchChats').mockResolvedValue([])
    await act(async () => { render(<ChatSearchModal />) })
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ query: '' }))

    const input = screen.getByPlaceholderText(/Search chats/i)
    fireEvent.change(input, { target: { value: 'sh' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(149) })
    expect(search).toHaveBeenCalledTimes(1)
    fireEvent.change(input, { target: { value: 'shell' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(149) })
    expect(search).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(search).toHaveBeenCalledTimes(2)
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'shell' }))
  })

  it.each(['sessions', 'entriesBySession'] as const)
    ('does not postpone a pending keystroke debounce when %s updates', async (source) => {
      vi.useFakeTimers()
      const search = vi.spyOn(chatSearch, 'searchChats').mockResolvedValue([])
      await act(async () => { render(<ChatSearchModal />) })
      fireEvent.change(screen.getByPlaceholderText(/Search chats/i), { target: { value: 'shell' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      await act(async () => {
        if (source === 'sessions') {
          useSessionStore.setState({ sessions: [...useSessionStore.getState().sessions] })
        } else {
          useMessageStore.setState({ entriesBySession: { ...useMessageStore.getState().entriesBySession } })
        }
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(49) })
      expect(search).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(search).toHaveBeenCalledTimes(2)
      expect(search).toHaveBeenLastCalledWith(expect.objectContaining({
        query: 'shell',
        sessions: useSessionStore.getState().sessions,
        entriesBySession: useMessageStore.getState().entriesBySession,
      }))
    })

  it.each(['sessions', 'entriesBySession'] as const)
    ('refreshes a settled query immediately on streaming %s updates', async (source) => {
      vi.useFakeTimers()
      const search = vi.spyOn(chatSearch, 'searchChats').mockResolvedValue([])
      await act(async () => { render(<ChatSearchModal />) })
      fireEvent.change(screen.getByPlaceholderText(/Search chats/i), { target: { value: 'shell' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(150) })
      expect(search).toHaveBeenCalledTimes(2)
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          if (source === 'sessions') {
            useSessionStore.setState({ sessions: [...useSessionStore.getState().sessions] })
          } else {
            useMessageStore.setState({ entriesBySession: { ...useMessageStore.getState().entriesBySession } })
          }
        })
        expect(search).toHaveBeenCalledTimes(3 + i)
        expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'shell' }))
        await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(150) })
      expect(search).toHaveBeenCalledTimes(5)
    })

  it.each(['sessions', 'entriesBySession'] as const)
    ('coalesces streaming %s updates without starving slower in-flight searches', async (source) => {
      vi.useFakeTimers()
      let activeSearches = 0
      let maxActiveSearches = 0
      let completedSearches = 0
      const search = vi.spyOn(chatSearch, 'searchChats').mockImplementation(({ query }) => {
        if (!query) return Promise.resolve([])
        activeSearches++
        maxActiveSearches = Math.max(maxActiveSearches, activeSearches)
        return new Promise((resolve) => {
          window.setTimeout(() => {
            activeSearches--
            completedSearches++
            resolve([{
              sessionId: 's2', title: `Streaming result ${completedSearches}`,
              updatedAt: completedSearches, matchType: 'content',
            }])
          }, 100)
        })
      })
      const { unmount } = render(<ChatSearchModal />)
      await act(async () => {})
      fireEvent.change(screen.getByPlaceholderText(/Search chats/i), { target: { value: 'shell' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(150) })
      expect(search).toHaveBeenCalledTimes(2)

      for (let tick = 1; tick <= 8; tick++) {
        const latestSessions = useSessionStore.getState().sessions
        const latestEntries = useMessageStore.getState().entriesBySession
        await act(async () => { await vi.advanceTimersByTimeAsync(50) })
        if (tick % 2 === 0) {
          expect(screen.getByText(`Streaming result ${tick / 2}`)).toBeInTheDocument()
          expect(search).toHaveBeenLastCalledWith({
            query: 'shell', sessions: latestSessions, entriesBySession: latestEntries, limit: 30,
          })
        }
        await act(async () => {
          if (source === 'sessions') {
            useSessionStore.setState({ sessions: [...useSessionStore.getState().sessions] })
          } else {
            useMessageStore.setState({ entriesBySession: { ...useMessageStore.getState().entriesBySession } })
          }
        })
        expect(search).toHaveBeenCalledTimes(2 + Math.floor(tick / 2))
        expect(maxActiveSearches).toBe(1)
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      expect(screen.getByText('Streaming result 6')).toBeInTheDocument()
      expect(activeSearches).toBe(0)
      expect(search).toHaveBeenCalledTimes(7)
      unmount()
    })

  it.each(['query', 'close', 'unmount'] as const)
    ('discards in-flight results and queued refreshes on %s changes', async (action) => {
      vi.useFakeTimers()
      let resolveSearch!: (items: chatSearch.ChatSearchResultItem[]) => void
      const search = vi.spyOn(chatSearch, 'searchChats').mockImplementation(({ query }) =>
        query === 'shell' ? new Promise((resolve) => { resolveSearch = resolve }) : Promise.resolve([]),
      )
      const { unmount } = render(<ChatSearchModal />)
      await act(async () => {})
      const input = screen.getByPlaceholderText(/Search chats/i)
      fireEvent.change(input, { target: { value: 'shell' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(150) })
      await act(async () => {
        useMessageStore.setState({ entriesBySession: { ...useMessageStore.getState().entriesBySession } })
      })
      if (action === 'query') {
        fireEvent.change(input, { target: { value: 'desktop' } })
      } else if (action === 'close') {
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
      } else {
        unmount()
      }
      await act(async () => {
        resolveSearch([{ sessionId: 's2', title: 'Superseded result', updatedAt: 1, matchType: 'content' }])
      })
      expect(screen.queryByText('Superseded result')).not.toBeInTheDocument()
      expect(search.mock.calls.filter(([options]) => options.query === 'shell')).toHaveLength(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(150) })
      expect(search).toHaveBeenCalledTimes(action === 'query' ? 3 : 2)
    })

  it('does not run a stale settled query while a new query is debouncing', async () => {
    vi.useFakeTimers()
    const search = vi.spyOn(chatSearch, 'searchChats').mockResolvedValue([])
    await act(async () => { render(<ChatSearchModal />) })
    const input = screen.getByPlaceholderText(/Search chats/i)
    fireEvent.change(input, { target: { value: 'shell' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    expect(search).toHaveBeenCalledTimes(2)
    fireEvent.change(input, { target: { value: 'desktop' } })
    await act(async () => {
      useMessageStore.setState({ entriesBySession: { ...useMessageStore.getState().entriesBySession } })
      useSessionStore.setState({ sessions: [...useSessionStore.getState().sessions] })
      await vi.advanceTimersByTimeAsync(149)
    })
    expect(search).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(search).toHaveBeenCalledTimes(3)
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'desktop' }))
  })

  it('searches immediately when clearing the input and cancels the pending query', async () => {
    vi.useFakeTimers()
    const search = vi.spyOn(chatSearch, 'searchChats').mockResolvedValue([])
    await act(async () => { render(<ChatSearchModal />) })
    const input = screen.getByPlaceholderText(/Search chats/i)
    fireEvent.change(input, { target: { value: 'shell' } })
    await act(async () => { fireEvent.change(input, { target: { value: '  ' } }) })
    expect(search).toHaveBeenCalledTimes(2)
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ query: '  ' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    expect(search).toHaveBeenCalledTimes(2)
  })

  it.each(['close', 'unmount'])('cancels pending searches on %s', async (action) => {
    vi.useFakeTimers()
    const search = vi.spyOn(chatSearch, 'searchChats').mockResolvedValue([])
    const { unmount } = render(<ChatSearchModal />)
    await act(async () => {})
    fireEvent.change(screen.getByPlaceholderText(/Search chats/i), { target: { value: 'shell' } })
    if (action === 'close') {
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    } else {
      unmount()
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('does not render when searchOpen is false', () => {
    useUiStore.setState({ searchOpen: false })
    const { container } = render(<ChatSearchModal />)
    expect(container.firstChild).toBeNull()
  })

  it('renders search input, recent chats and quick actions when open with empty query', async () => {
    render(<ChatSearchModal />)

    expect(screen.getByPlaceholderText(/Search chats/i)).toBeInTheDocument()
    expect(screen.getByText('New chat')).toBeInTheDocument()
    expect(screen.getByText('Open folder')).toBeInTheDocument()
    expect(screen.getByText('Search files')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText('Respond to greeting')).toBeInTheDocument()
      expect(screen.getByText('Project Architecture')).toBeInTheDocument()
    })
  })

  it('searches and navigates on clicking a chat result', async () => {
    render(<ChatSearchModal />)

    await waitFor(() => {
      expect(screen.getByText('Respond to greeting')).toBeInTheDocument()
    })

    const chatRow = screen.getByText('Respond to greeting')
    fireEvent.click(chatRow)

    expect(useSessionStore.getState().currentSessionId).toBe('s1')
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/chat/$sessionId',
      params: { sessionId: 's1' },
    })
    expect(useUiStore.getState().searchOpen).toBe(false)
  })

  it('searches content keyword and displays snippet', async () => {
    render(<ChatSearchModal />)

    const input = screen.getByPlaceholderText(/Search chats/i)
    fireEvent.change(input, { target: { value: 'shell' } })

    await waitFor(() => {
      expect(screen.getByText('Project Architecture')).toBeInTheDocument()
      expect(screen.getByText(/We are running a desktop/i)).toBeInTheDocument()
      expect(screen.getByText('shell')).toBeInTheDocument()
    })
  })

  it('closes on Escape key press', () => {
    render(<ChatSearchModal />)

    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })

    expect(useUiStore.getState().searchOpen).toBe(false)
  })

  it('is centered without backdrop blur mask and closes on outside click', () => {
    render(<ChatSearchModal />)

    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('items-center')
    expect(dialog.className).toContain('justify-center')
    expect(dialog.className).not.toContain('backdrop-blur')
    expect(dialog.className).not.toContain('bg-black')

    // Clicking the backdrop closes the modal
    fireEvent.click(dialog)
    expect(useUiStore.getState().searchOpen).toBe(false)
  })

  it('does not close when clicking inside the modal content box', async () => {
    await act(async () => { render(<ChatSearchModal />) })

    const input = screen.getByPlaceholderText(/Search chats/i)
    fireEvent.click(input)

    expect(useUiStore.getState().searchOpen).toBe(true)
  })
})
