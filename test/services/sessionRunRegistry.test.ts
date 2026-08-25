import { describe, it, expect } from 'vitest'
import { SessionRunRegistry } from '../../plugins/bundled/cpa.core.session-manager/main/sessionRunRegistry.js'
import type { NativeEvent } from '../../src/shared/types.js'

describe('SessionRunRegistry', () => {
    it('registers active run and emits session:run-status event', () => {
        const events: NativeEvent[] = []
        const emitEvent = (e: NativeEvent) => {
            events.push(e)
        }
        const registry = new SessionRunRegistry(emitEvent)

        registry.registerOrUpdate({
            sessionId: 'sess-1',
            runId: 'run-1',
            clientId: 'client-desktop',
            status: 'running',
        })

        expect(registry.getActiveRuns()).toHaveLength(1)
        expect(registry.getActiveRuns()[0]?.sessionId).toBe('sess-1')
        expect(registry.getActiveRuns()[0]?.runId).toBe('run-1')
        expect(registry.getActiveRuns()[0]?.clientId).toBe('client-desktop')
        expect(registry.getActiveRuns()[0]?.status).toBe('running')
        expect(registry.getActiveRuns()[0]?.updatedAt).toBeGreaterThan(0)

        expect(events).toHaveLength(1)
        expect(events[0]?.kind).toBe('session:run-status')
        expect(events[0]?.operationId).toBe('run-status-sess-1')

        const parsed = JSON.parse(events[0]?.data ?? '{}')
        expect(parsed.sessionId).toBe('sess-1')
        expect(parsed.status).toBe('running')
        expect(parsed.runId).toBe('run-1')
        expect(parsed.clientId).toBe('client-desktop')
    })

    it('updates run status when status changes', () => {
        const events: NativeEvent[] = []
        const registry = new SessionRunRegistry((e) => {
            events.push(e)
        })

        registry.registerOrUpdate({
            sessionId: 'sess-1',
            runId: 'run-1',
            clientId: 'client-desktop',
            status: 'running',
        })

        registry.registerOrUpdate({
            sessionId: 'sess-1',
            runId: 'run-1',
            clientId: 'client-desktop',
            status: 'thinking',
        })

        expect(registry.getActiveRuns()).toHaveLength(1)
        expect(registry.getActiveRuns()[0]?.status).toBe('thinking')
        expect(events).toHaveLength(2)

        const parsed = JSON.parse(events[1]?.data ?? '{}')
        expect(parsed.status).toBe('thinking')
    })

    it('clears active run when status is idle', () => {
        const events: NativeEvent[] = []
        const registry = new SessionRunRegistry((e) => {
            events.push(e)
        })

        registry.registerOrUpdate({
            sessionId: 'sess-1',
            runId: 'run-1',
            clientId: 'client-desktop',
            status: 'running',
        })
        registry.registerOrUpdate({
            sessionId: 'sess-1',
            runId: 'run-1',
            clientId: 'client-desktop',
            status: 'idle',
        })

        expect(registry.getActiveRuns()).toHaveLength(0)
        expect(events).toHaveLength(2)

        const parsed = JSON.parse(events[1]?.data ?? '{}')
        expect(parsed.status).toBe('idle')
        expect(parsed.sessionId).toBe('sess-1')
    })

    it('ignores stale idle status if runId does not match current active run', () => {
        const events: NativeEvent[] = []
        const registry = new SessionRunRegistry((e) => {
            events.push(e)
        })

        // Client 1 starts run-1
        registry.registerOrUpdate({
            sessionId: 'sess-1',
            runId: 'run-1',
            clientId: 'client-1',
            status: 'running',
        })

        // Client 2 takes over with run-2
        registry.registerOrUpdate({
            sessionId: 'sess-1',
            runId: 'run-2',
            clientId: 'client-2',
            status: 'running',
        })

        expect(registry.getActiveRuns()).toHaveLength(1)
        expect(registry.getActiveRuns()[0]?.runId).toBe('run-2')
        expect(events).toHaveLength(2)

        // Late idle event arrives from stale run-1
        registry.registerOrUpdate({
            sessionId: 'sess-1',
            runId: 'run-1',
            clientId: 'client-1',
            status: 'idle',
        })

        // Should still be run-2 and no new broadcast event emitted
        expect(registry.getActiveRuns()).toHaveLength(1)
        expect(registry.getActiveRuns()[0]?.runId).toBe('run-2')
        expect(registry.getActiveRuns()[0]?.clientId).toBe('client-2')
        expect(events).toHaveLength(2)
    })

    it('unregisters an active run and broadcasts idle', () => {
        const events: NativeEvent[] = []
        const registry = new SessionRunRegistry((e) => {
            events.push(e)
        })

        registry.registerOrUpdate({
            sessionId: 'sess-1',
            runId: 'run-1',
            clientId: 'client-desktop',
            status: 'tool',
        })

        registry.unregister('sess-1')

        expect(registry.getActiveRuns()).toHaveLength(0)
        expect(events).toHaveLength(2)

        const parsed = JSON.parse(events[1]?.data ?? '{}')
        expect(parsed.sessionId).toBe('sess-1')
        expect(parsed.status).toBe('idle')
        expect(parsed.runId).toBe('run-1')
        expect(parsed.clientId).toBe('client-desktop')
    })

    it('is idempotent when unregistering unknown session or unregistering twice', () => {
        const events: NativeEvent[] = []
        const registry = new SessionRunRegistry((e) => {
            events.push(e)
        })

        // Unregistering unknown session does nothing and does not emit event
        registry.unregister('unknown-session')
        expect(events).toHaveLength(0)

        // Register session
        registry.registerOrUpdate({
            sessionId: 'sess-1',
            runId: 'run-1',
            clientId: 'client-desktop',
            status: 'running',
        })
        expect(events).toHaveLength(1)

        // First unregister succeeds and broadcasts idle
        registry.unregister('sess-1')
        expect(events).toHaveLength(2)
        expect(registry.getActiveRuns()).toHaveLength(0)

        // Second unregister does not emit anything
        registry.unregister('sess-1')
        expect(events).toHaveLength(2)
    })

    it('cleans up all runs associated with disconnected client', () => {
        const events: NativeEvent[] = []
        const registry = new SessionRunRegistry((e) => {
            events.push(e)
        })

        registry.registerOrUpdate({
            sessionId: 'sess-1',
            runId: 'run-1',
            clientId: 'client-web-1',
            status: 'thinking',
        })
        registry.registerOrUpdate({
            sessionId: 'sess-2',
            runId: 'run-2',
            clientId: 'client-web-2',
            status: 'tool',
        })
        registry.registerOrUpdate({
            sessionId: 'sess-3',
            runId: 'run-3',
            clientId: 'client-web-1',
            status: 'running',
        })

        expect(registry.getActiveRuns()).toHaveLength(3)

        registry.cleanupClientRuns('client-web-1')

        expect(registry.getActiveRuns()).toHaveLength(1)
        expect(registry.getActiveRuns()[0]?.sessionId).toBe('sess-2')

        const idleEvents = events.filter((e) => {
            const data = JSON.parse(e.data ?? '{}')
            return data.status === 'idle'
        })
        expect(idleEvents).toHaveLength(2)
        const idleSessionIds = idleEvents.map((e) => JSON.parse(e.data ?? '{}').sessionId)
        expect(idleSessionIds).toContain('sess-1')
        expect(idleSessionIds).toContain('sess-3')
    })

    it('is idempotent when cleaning up unknown client', () => {
        const events: NativeEvent[] = []
        const registry = new SessionRunRegistry((e) => {
            events.push(e)
        })

        registry.registerOrUpdate({
            sessionId: 'sess-1',
            runId: 'run-1',
            clientId: 'client-1',
            status: 'running',
        })
        expect(events).toHaveLength(1)

        // Cleaning up non-existent client does nothing and does not broadcast
        registry.cleanupClientRuns('unknown-client')
        expect(registry.getActiveRuns()).toHaveLength(1)
        expect(events).toHaveLength(1)

        // Cleaning up client-1 removes the run and broadcasts idle
        registry.cleanupClientRuns('client-1')
        expect(registry.getActiveRuns()).toHaveLength(0)
        expect(events).toHaveLength(2)

        // Cleaning up client-1 again does nothing
        registry.cleanupClientRuns('client-1')
        expect(events).toHaveLength(2)
    })

    it('does not remove newer run on another client when cleaning up original client after takeover', () => {
        const events: NativeEvent[] = []
        const registry = new SessionRunRegistry((e) => {
            events.push(e)
        })

        // Client 1 starts session 1
        registry.registerOrUpdate({
            sessionId: 'sess-1',
            runId: 'run-1',
            clientId: 'client-1',
            status: 'running',
        })

        // Client 2 takes over session 1
        registry.registerOrUpdate({
            sessionId: 'sess-1',
            runId: 'run-2',
            clientId: 'client-2',
            status: 'running',
        })
        expect(events).toHaveLength(2)

        // Client 1 disconnects and cleans up its runs
        registry.cleanupClientRuns('client-1')

        // sess-1 should still be active under client-2, no idle event broadcasted
        expect(registry.getActiveRuns()).toHaveLength(1)
        expect(registry.getActiveRuns()[0]?.sessionId).toBe('sess-1')
        expect(registry.getActiveRuns()[0]?.clientId).toBe('client-2')
        expect(registry.getActiveRuns()[0]?.runId).toBe('run-2')
        expect(events).toHaveLength(2)
    })

    it('returns a shallow copy from getActiveRuns so internal state is not mutated', () => {
        const registry = new SessionRunRegistry(() => {})
        registry.registerOrUpdate({
            sessionId: 'sess-1',
            runId: 'run-1',
            clientId: 'client-desktop',
            status: 'running',
        })

        const runs = registry.getActiveRuns()
        runs[0].status = 'idle'

        expect(registry.getActiveRuns()[0]?.status).toBe('running')
    })

    it('manages resume prompt state and broadcasts updates and actions', () => {
        const events: NativeEvent[] = []
        const registry = new SessionRunRegistry((e) => {
            events.push(e)
        })

        // Initial default state
        expect(registry.getResumePromptState()).toEqual({
            isOpen: false,
            totalCount: 0,
            countdown: 0,
            unfinishedSessionIds: [],
            unfinishedSubAgentIds: [],
        })

        // Broadcast new prompt state
        registry.broadcastResumePromptState({
            isOpen: true,
            totalCount: 2,
            countdown: 30,
            unfinishedSessionIds: ['sess-1'],
            unfinishedSubAgentIds: ['sub-1'],
        })

        expect(registry.getResumePromptState()).toEqual({
            isOpen: true,
            totalCount: 2,
            countdown: 30,
            unfinishedSessionIds: ['sess-1'],
            unfinishedSubAgentIds: ['sub-1'],
        })

        expect(events).toHaveLength(1)
        expect(events[0].kind).toBe('session:resume-prompt-state')
        const stateData = JSON.parse(events[0].data ?? '{}')
        expect(stateData.isOpen).toBe(true)
        expect(stateData.countdown).toBe(30)
        expect(stateData.totalCount).toBe(2)

        // Dispatch action
        registry.dispatchResumePromptAction('continue')
        expect(events).toHaveLength(2)
        expect(events[1].kind).toBe('session:resume-prompt-action')
        expect(JSON.parse(events[1].data ?? '{}')).toEqual({ action: 'continue' })
    })
})
