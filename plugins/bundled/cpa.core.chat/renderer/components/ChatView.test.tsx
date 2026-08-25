import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { HostServicesProvider } from '@cpa/plugin-ui'
import type { DisplayMessage, HostServices } from '@cpa/plugin-api'
import { ChatView } from './ChatView.js'

describe('ChatView', () => {
    let mockServices: any
    let mockMessages: any[]
    let mockEntries: any[]
    let mockSessions: any[]
    let mockAgentRunState: any
    const EMPTY_OBJ = {}

    beforeEach(async () => {
        await i18n.changeLanguage('en')
        mockMessages = []
        mockEntries = []
        mockSessions = [
            {
                id: 'test-session-1',
                title: 'Test Session',
                pinned: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            },
        ]
        mockAgentRunState = { isStreaming: false, activeRunId: null }
        mockServices = {
            sessions: {
                getSnapshot: () => mockSessions,
                subscribe: () => () => {},
                getCurrentSessionId: () => 'test-session-1',
                setCurrentSessionId: vi.fn(),
                markRead: vi.fn(),
                isManuallyMarkedUnread: () => false,
                getActiveRun: () => null,
                subscribeRuns: () => () => {},
            },
            chatMessages: {
                getDisplayMessages: () => mockMessages,
                getEntries: () => mockEntries,
                replaceSessionEntries: vi.fn(),
                subscribeMessages: () => () => {},
                ensureSessionLoaded: vi.fn().mockResolvedValue(undefined),
                schedulePersist: vi.fn(),
                forkSession: vi.fn().mockResolvedValue('forked-session-1'),
                executeHook: vi.fn().mockResolvedValue(undefined),
                getToolOverlays: () => EMPTY_OBJ,
                subscribeToolOverlays: () => () => {},
                isCompacting: () => false,
                subscribeCompaction: () => () => {},
                getWorktreeSetup: () => null,
                subscribeWorktreeSetup: () => () => {},
                retryWorktreeSetup: vi.fn().mockResolvedValue({ ok: true }),
                continueAnywayWorktreeSetup: vi.fn().mockResolvedValue(undefined),
                autoFixWorktreeSetup: vi.fn().mockResolvedValue(undefined),
                toggleWorktreeSetupDetails: vi.fn(),
                approveTool: vi.fn(),
                rejectTool: vi.fn(),
                send: vi.fn().mockResolvedValue('test-session-1'),
                retrySession: vi.fn().mockResolvedValue(undefined),
                getAgentRunState: () => mockAgentRunState,
                subscribeAgentRunState: () => () => {},
            },
            ui: {
                pushToast: vi.fn(),
                emitEvent: vi.fn(),
            },
            navigation: {
                navigate: vi.fn(),
            },
        }
    })

    it('renders message list in a container and syncs session', () => {
        render(
            <HostServicesProvider services={mockServices as any}>
                <ChatView sessionId="test-session-1" />
            </HostServicesProvider>,
        )

        expect(screen.getByTestId('message-list-scroller')).toBeInTheDocument()
        expect(mockServices.sessions.setCurrentSessionId).toHaveBeenCalledWith('test-session-1')
        expect(mockServices.chatMessages.ensureSessionLoaded).toHaveBeenCalledWith('test-session-1')
    })

    it('reflects active running status from agent run state', () => {
        mockServices.chatMessages.getAgentRunState = () => ({
            isStreaming: true,
            activeRunId: 'run-1',
        })

        mockMessages = [
            {
                kind: 'message',
                id: 'u1',
                sessionId: 'test-session-1',
                role: 'user',
                content: 'hello',
                parts: [{ type: 'text', text: 'hello' }],
                createdAt: 100,
            } as any,
        ]

        render(
            <HostServicesProvider services={mockServices as any}>
                <ChatView sessionId="test-session-1" />
            </HostServicesProvider>,
        )

        expect(screen.getByTestId('turn-header')).toBeInTheDocument()
    })

    it('triggers retrySession when retry button is clicked', async () => {
        mockMessages = [
            {
                kind: 'message',
                id: 'u1',
                sessionId: 'test-session-1',
                role: 'user',
                content: 'Write a binary search',
                parts: [{ type: 'text', text: 'Write a binary search' }],
                createdAt: 100,
            } as any,
            {
                kind: 'message',
                id: 'a1',
                sessionId: 'test-session-1',
                role: 'assistant',
                content: '',
                status: 'error',
                errorMessage: 'Rate limit exceeded',
                createdAt: 105,
            } as any,
        ]

        render(
            <HostServicesProvider services={mockServices as any}>
                <ChatView sessionId="test-session-1" />
            </HostServicesProvider>,
        )

        const retryButton = screen.getByRole('button', { name: /Retry/i })
        fireEvent.click(retryButton)

        await waitFor(() => {
            expect(mockServices.chatMessages.retrySession).toHaveBeenCalledWith('test-session-1')
        })
    })

    it('triggers forkSession when fork action is clicked', async () => {
        mockMessages = [
            {
                kind: 'message',
                id: 'a1',
                sessionId: 'test-session-1',
                role: 'assistant',
                content: 'Here is the binary search code',
                status: 'done',
                createdAt: 105,
            } as any,
        ]

        render(
            <HostServicesProvider services={mockServices as any}>
                <ChatView sessionId="test-session-1" />
            </HostServicesProvider>,
        )

        const forkButton = screen.getByTestId('message-fork-btn')
        fireEvent.click(forkButton)

        await waitFor(() => {
            expect(mockServices.chatMessages.forkSession).toHaveBeenCalledWith('test-session-1', 'a1')
            expect(mockServices.navigation.navigate).toHaveBeenCalledWith('/chat/forked-session-1')
        })
    })

    it('triggers chatMessages.send with editMessageId when editing and sending user message', async () => {
        mockMessages = [
            {
                kind: 'message',
                id: 'u1',
                sessionId: 'test-session-1',
                role: 'user',
                content: 'original message',
                parts: [{ type: 'text', text: 'original message' }],
                createdAt: 100,
            } as any,
        ]

        render(
            <HostServicesProvider services={mockServices as any}>
                <ChatView sessionId="test-session-1" />
            </HostServicesProvider>,
        )

        const editButton = screen.getByRole('button', { name: /Edit/i })
        fireEvent.click(editButton)

        const editor = screen.getByRole('textbox')
        fireEvent.input(editor, { target: { textContent: 'updated message' } })

        const sendButton = screen.getByRole('button', { name: /Send/i })
        fireEvent.click(sendButton)

        await waitFor(() => {
            expect(mockServices.chatMessages.send).toHaveBeenCalledWith({
                text: 'updated message',
                sessionId: 'test-session-1',
                editMessageId: 'u1',
            })
        })
    })
})
