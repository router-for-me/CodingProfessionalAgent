import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMessageStore } from '@/stores/messageStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useUiStore } from '@/stores/uiStore'
import { forkSession } from './forkSession'
import type { AssistantEntry, UserEntry } from './types'

describe('forkSession', () => {
    beforeEach(() => {
        useSessionStore.setState({
            sessions: [],
            currentSessionId: null,
        })
        useMessageStore.setState({
            entriesBySession: {},
        })
        useUiStore.setState({
            settingsOpen: false,
        })
    })

    it('returns null if session does not exist or is archived', () => {
        const result = forkSession({ sessionId: 'non-existent' })
        expect(result).toBeNull()

        useSessionStore.getState().createSession({ id: 'archived-s' })
        useSessionStore.getState().archiveSession('archived-s')
        const resultArchived = forkSession({ sessionId: 'archived-s' })
        expect(resultArchived).toBeNull()
    })

    it('forks all entries when no messageId is specified', () => {
        const sourceSessionId = 'source-1'
        useSessionStore.getState().createSession({
            id: sourceSessionId,
            title: 'Test Session',
            projectId: 'proj-1',
            branch: 'main',
        })

        const userEntry: UserEntry = {
            kind: 'user',
            id: 'u1',
            sessionId: sourceSessionId,
            content: [{ type: 'text', text: 'Hello' }],
            createdAt: 100,
        }
        const assistantEntry: AssistantEntry = {
            kind: 'assistant',
            id: 'a1',
            sessionId: sourceSessionId,
            content: [{ type: 'text', text: 'Hi there' }],
            status: 'done',
            stopReason: 'stop',
            createdAt: 200,
        }

        useMessageStore.getState().replaceSessionEntries(sourceSessionId, [
            userEntry,
            assistantEntry,
        ])

        const navigate = vi.fn()
        const newSessionId = forkSession({
            sessionId: sourceSessionId,
            navigate,
        })

        expect(newSessionId).toBeTruthy()
        expect(newSessionId).not.toBe(sourceSessionId)

        const sessions = useSessionStore.getState().sessions
        const forkedSession = sessions.find((s) => s.id === newSessionId)
        expect(forkedSession).toBeDefined()
        expect(forkedSession?.title).toBe('Test Session (Fork)')
        expect(forkedSession?.projectId).toBe('proj-1')
        expect(forkedSession?.branch).toBe('main')

        const entries = useMessageStore.getState().getEntries(newSessionId!)
        expect(entries).toHaveLength(2)
        expect(entries[0].sessionId).toBe(newSessionId)
        expect(entries[0].id).not.toBe('u1')
        expect(entries[1].sessionId).toBe(newSessionId)
        expect(entries[1].id).not.toBe('a1')

        expect(useSessionStore.getState().currentSessionId).toBe(newSessionId)
        expect(navigate).toHaveBeenCalledWith({
            to: '/chat/$sessionId',
            params: { sessionId: newSessionId },
        })
    })

    it('forks entries up to the specified messageId', () => {
        const sourceSessionId = 'source-2'
        useSessionStore.getState().createSession({
            id: sourceSessionId,
            title: 'Multi Turn Session',
        })

        const u1: UserEntry = {
            kind: 'user',
            id: 'u1',
            sessionId: sourceSessionId,
            content: [{ type: 'text', text: 'Turn 1 User' }],
            createdAt: 100,
        }
        const a1: AssistantEntry = {
            kind: 'assistant',
            id: 'a1',
            sessionId: sourceSessionId,
            content: [{ type: 'text', text: 'Turn 1 Assistant' }],
            status: 'done',
            stopReason: 'stop',
            createdAt: 200,
        }
        const u2: UserEntry = {
            kind: 'user',
            id: 'u2',
            sessionId: sourceSessionId,
            content: [{ type: 'text', text: 'Turn 2 User' }],
            createdAt: 300,
        }
        const a2: AssistantEntry = {
            kind: 'assistant',
            id: 'a2',
            sessionId: sourceSessionId,
            content: [{ type: 'text', text: 'Turn 2 Assistant' }],
            status: 'done',
            stopReason: 'stop',
            createdAt: 400,
        }

        useMessageStore.getState().replaceSessionEntries(sourceSessionId, [
            u1,
            a1,
            u2,
            a2,
        ])

        const newSessionId = forkSession({
            sessionId: sourceSessionId,
            messageId: 'a1',
        })

        expect(newSessionId).toBeTruthy()
        const entries = useMessageStore.getState().getEntries(newSessionId!)
        expect(entries).toHaveLength(2)
        expect((entries[0] as UserEntry).content[0]).toEqual({
            type: 'text',
            text: 'Turn 1 User',
        })
        expect((entries[1] as AssistantEntry).content[0]).toEqual({
            type: 'text',
            text: 'Turn 1 Assistant',
        })
    })

    it('forks with workLocation worktree and environmentId overrides', () => {
        const sourceSessionId = 'source-worktree'
        useSessionStore.getState().createSession({
            id: sourceSessionId,
            title: 'Local Session',
            projectId: 'proj-1',
            branch: 'feature-branch',
            workLocation: 'local',
        })

        const forkedId = forkSession({
            sessionId: sourceSessionId,
            workLocation: 'worktree',
            environmentId: 'env-custom',
            branch: 'feature-branch',
        })

        expect(forkedId).toBeDefined()
        const forkedSession = useSessionStore.getState().sessions.find((s) => s.id === forkedId)
        expect(forkedSession).toBeDefined()
        expect(forkedSession?.workLocation).toBe('worktree')
        expect(forkedSession?.environmentId).toBe('env-custom')
        expect(forkedSession?.branch).toBe('feature-branch')
    })
})
