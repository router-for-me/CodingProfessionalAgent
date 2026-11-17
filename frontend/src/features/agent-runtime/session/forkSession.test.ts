import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMessageStore } from '@/stores/messageStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useUiStore } from '@/stores/uiStore'
import { setHostBridge } from '@/application/services/hostTransport'
import { clearForkedSessionPromptState, forkSession, waitForForkedSessionPrompt } from './forkSession'
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

    it('copies persisted system_prompt from source session to newly forked session', async () => {
        const sourceSessionId = 'source-sp'
        const SessionGetSystemPrompt = vi.fn(async (sid: string) =>
            sid === sourceSessionId ? 'FORK_ENHANCED_PROMPT' : null,
        )
        const SessionSetSystemPrompt = vi.fn(async () => true)
        setHostBridge({
            SessionGetSystemPrompt,
            SessionSetSystemPrompt,
        } as any)

        useSessionStore.getState().createSession({
            id: sourceSessionId,
            title: 'Source Session',
        })

        const forkedId = forkSession({ sessionId: sourceSessionId })
        expect(forkedId).toBeTruthy()
        await waitForForkedSessionPrompt(forkedId!)
        expect(SessionGetSystemPrompt).toHaveBeenCalledWith(sourceSessionId)
        expect(SessionSetSystemPrompt).toHaveBeenCalledWith(forkedId, 'FORK_ENHANCED_PROMPT')
        setHostBridge(null)
    })

    it('surfaces fork prompt copy failure through waitForForkedSessionPrompt instead of silently dropping', async () => {
        const sourceSessionId = 'source-sp-fail'
        setHostBridge({
            SessionGetSystemPrompt: vi.fn(async () => {
                throw new Error('DB read error')
            }),
            SessionSetSystemPrompt: vi.fn(async () => true),
        } as any)

        useSessionStore.getState().createSession({
            id: sourceSessionId,
            title: 'Source Fail Session',
        })

        const forkedId = forkSession({ sessionId: sourceSessionId })
        expect(forkedId).toBeTruthy()
        await expect(waitForForkedSessionPrompt(forkedId!)).rejects.toThrow('DB read error')
        setHostBridge(null)
    })
    it.each([false, true])('waits for the source barrier in chained forks and propagates failure (%s)', async (fail) => {
        let release!: (value: string) => void
        let reject!: (error: Error) => void
        const source = new Promise<string>((resolve, rejectFn) => { release = resolve; reject = rejectFn })
        const prompts = new Map<string, string>()
        const get = vi.fn(async (id: string) => id === 'chain-a' ? source : prompts.get(id) ?? null)
        setHostBridge({ SessionGetSystemPrompt: get, SessionSetSystemPrompt: vi.fn(async (id: string, prompt: string) => { prompts.set(id, prompt); return true }) } as any)
        useSessionStore.getState().createSession({ id: 'chain-a' })
        const b = forkSession({ sessionId: 'chain-a' })!
        const c = forkSession({ sessionId: b })!
        let settled = false
        const result = waitForForkedSessionPrompt(c).then(() => { settled = true }, (error) => { settled = true; return error })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(get).not.toHaveBeenCalledWith(b)
        expect(settled).toBe(false)
        if (fail) reject(new Error('source copy failed'))
        else release('CHAIN_PROMPT')
        const error = await result
        if (fail) expect(error).toMatchObject({ message: 'source copy failed' })
        else expect(prompts.get(c)).toBe('CHAIN_PROMPT')
        setHostBridge(null)
    })

    it('records pending inheritance on fork metadata before persistence or navigation', () => {
        setHostBridge(null)
        useSessionStore.getState().createSession({ id: 'persistent-source' })
        const id = forkSession({ sessionId: 'persistent-source' })!
        expect(useSessionStore.getState().sessions.find((s) => s.id === id)).toMatchObject({ pendingSystemPromptFrom: 'persistent-source' })
    })

    it('persists the fork barrier before reading its source and resolves confirmed absent prompts', async () => {
        let release!: () => void
        const held = new Promise<void>((resolve) => { release = resolve })
        const get = vi.fn(async () => null)
        const setMeta = vi.fn(async () => held)
        setHostBridge({ SessionSetMeta: setMeta, SessionGetSystemPrompt: get, SessionSetSystemPrompt: vi.fn(async () => true) } as any)
        useSessionStore.getState().createSession({ id: 'persist-before-copy' })
        const id = forkSession({ sessionId: 'persist-before-copy' })!
        try {
            expect(setMeta).toHaveBeenCalledWith(expect.objectContaining({ id, pendingSystemPromptFrom: 'persist-before-copy' }))
            expect(get).not.toHaveBeenCalled()
        } finally { release() }
        await waitForForkedSessionPrompt(id)
        expect(get).toHaveBeenCalledWith(id)
        setHostBridge(null)
    })

    it('recovers from transient fork prompt copy failure on subsequent waitForForkedSessionPrompt retry or external completion', async () => {
        const sourceId = 'transient-src'
        const prompts = new Map<string, string>()
        let shouldFail = true
        const get = vi.fn(async (id: string) => {
            if (shouldFail) throw new Error('Transient SQLite busy')
            if (id === sourceId) return 'RECOVERED_FORK_PROMPT'
            return prompts.get(id) ?? null
        })
        const set = vi.fn(async (id: string, prompt: string) => {
            prompts.set(id, prompt)
            return true
        })
        setHostBridge({ SessionGetSystemPrompt: get, SessionSetSystemPrompt: set } as any)
        useSessionStore.getState().createSession({ id: sourceId })

        const forkedId = forkSession({ sessionId: sourceId })!
        await expect(waitForForkedSessionPrompt(forkedId)).rejects.toThrow('Transient SQLite busy')

        // Storage recovers -> retry succeeds
        shouldFail = false
        await expect(waitForForkedSessionPrompt(forkedId)).resolves.toBeUndefined()
        expect(prompts.get(forkedId)).toBe('RECOVERED_FORK_PROMPT')

        // Case 2: another client already persisted the forked session prompt after a transient failure
        let failSecond = true
        const forkedPrompts2 = new Map<string, string>()
        setHostBridge({
            SessionGetSystemPrompt: vi.fn(async (id: string) => {
                if (failSecond) throw new Error('Transient error 2')
                return forkedPrompts2.get(id) ?? null
            }),
            SessionSetSystemPrompt: set,
        } as any)
        const forkedId2 = forkSession({ sessionId: sourceId })!
        await expect(waitForForkedSessionPrompt(forkedId2)).rejects.toThrow('Transient error 2')
        failSecond = false
        forkedPrompts2.set(forkedId2, 'EXTERNALLY_COPIED_PROMPT')
        await expect(waitForForkedSessionPrompt(forkedId2)).resolves.toBeUndefined()
        setHostBridge(null)
    })

    it('does not repopulate failedForkPromptCopies or push a stale toast when a forked session is deleted while copy is in flight', async () => {
        const sourceId = 'source-delete-in-flight'
        let releaseSetPrompt!: (saved: boolean) => void
        const setPromptHold = new Promise<boolean>((resolve) => {
            releaseSetPrompt = resolve
        })
        const getMock = vi.fn(async (sid: string) =>
            sid === sourceId ? 'SOURCE_ENHANCED_PROMPT' : null,
        )
        const setMock = vi.fn(async () => setPromptHold)
        setHostBridge({
            SessionGetSystemPrompt: getMock,
            SessionSetSystemPrompt: setMock,
        } as any)
        useUiStore.setState({ toasts: [] })
        useSessionStore.getState().createSession({ id: sourceId })

        const forkedId = forkSession({ sessionId: sourceId })!
        await vi.waitFor(() => {
            expect(setMock).toHaveBeenCalledWith(forkedId, 'SOURCE_ENHANCED_PROMPT')
        })

        // Delete the forked session and clear its prompt state while SessionSetSystemPrompt is still in flight
        useSessionStore.getState().removeSession(forkedId)
        clearForkedSessionPromptState(forkedId)

        // Now DB tombstone causes SessionSetSystemPrompt to return false
        releaseSetPrompt(false)
        await new Promise((resolve) => setTimeout(resolve, 20))

        expect(useUiStore.getState().toasts).toEqual([])
        // Calling waitForForkedSessionPrompt afterwards must resolve cleanly without throwing stale copy error or retrying
        const callsBeforeWait = getMock.mock.calls.length
        await expect(waitForForkedSessionPrompt(forkedId)).resolves.toBeUndefined()
        expect(getMock.mock.calls.length).toBe(callsBeforeWait)
        setHostBridge(null)
    })

    it('resolves cleanly without throwing priorError or repopulating failedForkPromptCopies when deleted while waitForForkedSessionPrompt retry query is in flight', async () => {
        const sourceId = 'source-delete-during-wait-query'
        let forkedId = ''
        let releaseRetryQuery!: (val: string | null) => void
        let retryQueryStarted!: () => void
        const retryQueryStartedPromise = new Promise<void>((resolve) => {
            retryQueryStarted = resolve
        })
        let initialFailDone = false
        const getMock = vi.fn(async (sid: string) => {
            if (!initialFailDone) {
                initialFailDone = true
                throw new Error('Initial transient fork copy failure')
            }
            if (sid === forkedId) {
                retryQueryStarted()
                return new Promise<string | null>((resolve) => {
                    releaseRetryQuery = resolve
                })
            }
            return 'SOURCE_PROMPT'
        })
        const setMock = vi.fn(async () => true)
        setHostBridge({
            SessionGetSystemPrompt: getMock,
            SessionSetSystemPrompt: setMock,
        } as any)
        useUiStore.setState({ toasts: [] })
        useSessionStore.getState().createSession({ id: sourceId })

        forkedId = forkSession({ sessionId: sourceId })!
        // Let the initial background copy fail and record priorError in failedForkPromptCopies
        await vi.waitFor(() => {
            expect(getMock).toHaveBeenCalledWith(sourceId)
        })
        await new Promise((resolve) => setTimeout(resolve, 20))

        // Trigger waitForForkedSessionPrompt which queries SessionGetSystemPrompt(forkedId)
        const waitPromise = waitForForkedSessionPrompt(forkedId)
        await retryQueryStartedPromise

        // Delete the forked session and clear its prompt state while the retry query is in flight
        useSessionStore.getState().removeSession(forkedId)
        clearForkedSessionPromptState(forkedId)

        // Retry query resolves null -> must resolve cleanly without throwing priorError
        releaseRetryQuery(null)
        await expect(waitPromise).resolves.toBeUndefined()
        expect(setMock).not.toHaveBeenCalled()

        // Subsequent wait must also resolve cleanly without throwing or querying again
        const callsAfterWait = getMock.mock.calls.length
        await expect(waitForForkedSessionPrompt(forkedId)).resolves.toBeUndefined()
        expect(getMock.mock.calls.length).toBe(callsAfterWait)
        setHostBridge(null)
    })

})
