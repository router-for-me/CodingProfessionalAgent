import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore } from './sessionStore'
import { useSessionRunStore } from './sessionRunStore'

describe('sessionRunStore', () => {
    beforeEach(() => {
        useSessionRunStore.setState({ activeRuns: {} })
    })

    it('sets and clears active runs', () => {
        useSessionRunStore.getState().setRun('sess-1', {
            sessionId: 'sess-1',
            runId: 'run-1',
            status: 'running',
            clientId: 'client-1',
            updatedAt: 1000,
        })

        expect(useSessionRunStore.getState().activeRuns['sess-1']).toEqual({
            sessionId: 'sess-1',
            runId: 'run-1',
            status: 'running',
            clientId: 'client-1',
            updatedAt: 1000,
        })

        useSessionRunStore.getState().clearRun('sess-1')
        expect(useSessionRunStore.getState().activeRuns['sess-1']).toBeUndefined()
    })

    it('removes active run when status is idle in setRun', () => {
        useSessionRunStore.getState().setRun('sess-1', {
            sessionId: 'sess-1',
            runId: 'run-1',
            status: 'running',
            clientId: 'client-1',
            updatedAt: 1000,
        })

        expect(useSessionRunStore.getState().activeRuns['sess-1']?.status).toBe('running')

        useSessionRunStore.getState().setRun('sess-1', {
            sessionId: 'sess-1',
            runId: 'run-1',
            status: 'idle',
            clientId: 'client-1',
            updatedAt: 2000,
        })

        expect(useSessionRunStore.getState().activeRuns['sess-1']).toBeUndefined()
    })

    it('hydrates multiple runs and filters out idle runs', () => {
        useSessionRunStore.getState().hydrate([
            {
                sessionId: 'sess-1',
                runId: 'run-1',
                status: 'thinking',
                clientId: 'client-1',
                updatedAt: 1000,
            },
            {
                sessionId: 'sess-2',
                runId: 'run-2',
                status: 'tool',
                clientId: 'client-2',
                updatedAt: 1500,
            },
            {
                sessionId: 'sess-3',
                runId: 'run-3',
                status: 'idle',
                clientId: 'client-3',
                updatedAt: 2000,
            },
        ])

        const runs = useSessionRunStore.getState().activeRuns
        expect(runs['sess-1']?.status).toBe('thinking')
        expect(runs['sess-2']?.status).toBe('tool')
        expect(runs['sess-3']).toBeUndefined()
        expect(Object.keys(runs)).toHaveLength(2)
    })

    it('merges active runs during hydrate based on timestamps and protects recently updated local runs', () => {
        const now = Date.now()

        // Setup existing active runs
        useSessionRunStore.setState({
            activeRuns: {
                'sess-newer-local': {
                    sessionId: 'sess-newer-local',
                    runId: 'run-local',
                    status: 'running',
                    clientId: 'client-local',
                    updatedAt: now,
                },
                'sess-older-local': {
                    sessionId: 'sess-older-local',
                    runId: 'run-old',
                    status: 'thinking',
                    clientId: 'client-local',
                    updatedAt: now - 5000,
                },
                'sess-recent-unlisted': {
                    sessionId: 'sess-recent-unlisted',
                    runId: 'run-recent',
                    status: 'tool',
                    clientId: 'client-local',
                    updatedAt: now - 500, // Updated 500ms ago (< 2000ms)
                },
                'sess-stale-unlisted': {
                    sessionId: 'sess-stale-unlisted',
                    runId: 'run-stale',
                    status: 'running',
                    clientId: 'client-local',
                    updatedAt: now - 5000, // Updated 5000ms ago (> 2000ms)
                },
            },
        })

        // Remote hydrate payload
        useSessionRunStore.getState().hydrate([
            {
                sessionId: 'sess-newer-local',
                runId: 'run-remote-old',
                status: 'tool',
                clientId: 'client-remote',
                updatedAt: now - 1000, // Stale compared to local (now)
            },
            {
                sessionId: 'sess-older-local',
                runId: 'run-remote-new',
                status: 'running',
                clientId: 'client-remote',
                updatedAt: now, // Newer than local (now - 5000)
            },
            {
                sessionId: 'sess-brand-new',
                runId: 'run-brand-new',
                status: 'thinking',
                clientId: 'client-remote',
                updatedAt: now,
            },
        ])

        const runs = useSessionRunStore.getState().activeRuns

        // sess-newer-local should keep local state because local updatedAt (now) >= remote (now - 1000)
        expect(runs['sess-newer-local']?.runId).toBe('run-local')
        expect(runs['sess-newer-local']?.status).toBe('running')

        // sess-older-local should update to remote state because remote updatedAt (now) >= local (now - 5000)
        expect(runs['sess-older-local']?.runId).toBe('run-remote-new')
        expect(runs['sess-older-local']?.status).toBe('running')

        // sess-brand-new should be added
        expect(runs['sess-brand-new']?.runId).toBe('run-brand-new')
        expect(runs['sess-brand-new']?.status).toBe('thinking')

        // sess-recent-unlisted was updated < 2s ago, so it is retained
        expect(runs['sess-recent-unlisted']?.runId).toBe('run-recent')

        // sess-stale-unlisted was updated > 2s ago, so it is deleted
        expect(runs['sess-stale-unlisted']).toBeUndefined()
    })

    it('marks non-current session as unread (normal) when completed normally', () => {
        useSessionStore.setState({
            sessions: [
                { id: 'sess-active', title: 'Active Chat', pinned: false, createdAt: 1, updatedAt: 1 },
                { id: 'sess-background', title: 'Bg Chat', pinned: false, createdAt: 1, updatedAt: 1 },
            ],
            currentSessionId: 'sess-active',
        })

        // Background session starts running
        useSessionRunStore.getState().setRun('sess-background', {
            sessionId: 'sess-background',
            runId: 'run-bg',
            status: 'running',
            clientId: 'client-1',
            updatedAt: 1000,
        })

        // Background session completes normally (idle)
        useSessionRunStore.getState().setRun('sess-background', {
            sessionId: 'sess-background',
            runId: 'run-bg',
            status: 'idle',
            clientId: 'client-1',
            updatedAt: 2000,
        })

        const bgSession = useSessionStore.getState().sessions.find((s) => s.id === 'sess-background')
        expect(bgSession?.unread).toBe(true)
    })

    it('marks non-current session as unread (error) when completed with error', () => {
        useSessionStore.setState({
            sessions: [
                { id: 'sess-active', title: 'Active Chat', pinned: false, createdAt: 1, updatedAt: 1 },
                { id: 'sess-bg-err', title: 'Bg Error Chat', pinned: false, createdAt: 1, updatedAt: 1 },
            ],
            currentSessionId: 'sess-active',
        })

        // Background session encounters error
        useSessionRunStore.getState().setRun('sess-bg-err', {
            sessionId: 'sess-bg-err',
            runId: 'run-err',
            status: 'error',
            error: 'Network Timeout',
            clientId: 'client-1',
            updatedAt: 1000,
        })

        let bgSession = useSessionStore.getState().sessions.find((s) => s.id === 'sess-bg-err')
        expect(bgSession?.unread).toBe('error')

        // And when it transitions to idle afterwards, stays error unread
        useSessionRunStore.getState().setRun('sess-bg-err', {
            sessionId: 'sess-bg-err',
            runId: 'run-err',
            status: 'idle',
            clientId: 'client-1',
            updatedAt: 2000,
        })

        bgSession = useSessionStore.getState().sessions.find((s) => s.id === 'sess-bg-err')
        expect(bgSession?.unread).toBe('error')
    })

    it('does NOT mark session as unread when completed if the session is currently being viewed', () => {
        useSessionStore.setState({
            sessions: [
                { id: 'sess-viewing', title: 'Viewing Chat', pinned: false, createdAt: 1, updatedAt: 1 },
            ],
            currentSessionId: 'sess-viewing',
        })

        useSessionRunStore.getState().setRun('sess-viewing', {
            sessionId: 'sess-viewing',
            runId: 'run-viewing',
            status: 'running',
            clientId: 'client-1',
            updatedAt: 1000,
        })

        useSessionRunStore.getState().setRun('sess-viewing', {
            sessionId: 'sess-viewing',
            runId: 'run-viewing',
            status: 'idle',
            clientId: 'client-1',
            updatedAt: 2000,
        })

        const viewingSession = useSessionStore.getState().sessions.find((s) => s.id === 'sess-viewing')
        expect(viewingSession?.unread).toBeUndefined()
    })
})
