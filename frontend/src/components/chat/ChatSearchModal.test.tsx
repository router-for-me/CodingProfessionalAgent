import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('does not close when clicking inside the modal content box', () => {
    render(<ChatSearchModal />)

    const input = screen.getByPlaceholderText(/Search chats/i)
    fireEvent.click(input)

    expect(useUiStore.getState().searchOpen).toBe(true)
  })
})
