import { describe, expect, it, vi } from 'vitest'
import React, { useEffect, useRef } from 'react'
import { render, screen, act } from '@testing-library/react'
import {
    HostServicesProvider,
    useAgentRunState,
    setDefaultHostServices,
} from './HostServicesContext.js'
import type { HostServices, AgentRunState } from '@cpa/plugin-api'

describe('useAgentRunState stability and multi-session concurrency', () => {
    it('maintains referentially stable snapshots across multiple concurrent sessions and renders', () => {
        const listeners: Record<string, Set<() => void>> = {
            'sess-a': new Set(),
            'sess-b': new Set(),
        }

        const runStates: Record<string, AgentRunState> = {
            'sess-a': { isStreaming: false, activeRunId: null },
            'sess-b': { isStreaming: true, activeRunId: 'run-b-1', runState: { status: 'running' } },
        }

        const mockServices: Partial<HostServices> = {
            chatMessages: {
                getDisplayMessages: () => [],
                getEntries: () => [],
                replaceSessionEntries: () => {},
                getAgentRunState: (sessionId: string) => ({ ...(runStates[sessionId] ?? { isStreaming: false, activeRunId: null }) }),
                subscribeAgentRunState: (sessionId: string, listener: () => void) => {
                    if (!listeners[sessionId]) listeners[sessionId] = new Set()
                    listeners[sessionId].add(listener)
                    return () => {
                        listeners[sessionId]?.delete(listener)
                    }
                },
            },
        }

        const snapshotsA: AgentRunState[] = []
        const snapshotsB: AgentRunState[] = []

        function SessionAComponent() {
            const stateA = useAgentRunState('sess-a')
            snapshotsA.push(stateA)
            return <div data-testid="sess-a">{stateA.isStreaming ? 'streaming' : 'idle'}</div>
        }

        function SessionBComponent() {
            const stateB = useAgentRunState('sess-b')
            snapshotsB.push(stateB)
            return <div data-testid="sess-b">{stateB.isStreaming ? 'streaming' : 'idle'}</div>
        }

        function MultiSessionContainer({ renderBoth = true }: { renderBoth?: boolean }) {
            return (
                <HostServicesProvider services={mockServices as HostServices}>
                    <SessionAComponent />
                    {renderBoth && <SessionBComponent />}
                </HostServicesProvider>
            )
        }

        const { rerender } = render(<MultiSessionContainer />)

        expect(screen.getByTestId('sess-a')).toHaveTextContent('idle')
        expect(screen.getByTestId('sess-b')).toHaveTextContent('streaming')

        // Re-render container without state changes
        rerender(<MultiSessionContainer />)

        // Snapshots should be referentially stable for sess-a and sess-b across renders
        expect(snapshotsA.length).toBeGreaterThanOrEqual(2)
        expect(snapshotsB.length).toBeGreaterThanOrEqual(2)
        expect(snapshotsA[snapshotsA.length - 1]).toBe(snapshotsA[0])
        expect(snapshotsB[snapshotsB.length - 1]).toBe(snapshotsB[0])

        // When sess-a state changes, sess-b snapshot MUST remain strictly stable and unchanged
        act(() => {
            runStates['sess-a'] = { isStreaming: true, activeRunId: 'run-a-1', runState: { status: 'running' } }
            listeners['sess-a']?.forEach((l) => l())
        })

        expect(screen.getByTestId('sess-a')).toHaveTextContent('streaming')
        expect(snapshotsA[snapshotsA.length - 1]).not.toBe(snapshotsA[0])
        // sess-b snapshot reference must still be referentially equal to previous sess-b snapshot
        expect(snapshotsB[snapshotsB.length - 1]).toBe(snapshotsB[0])

        // Unmount session B: should unsubscribe without infinite loop or error
        rerender(<MultiSessionContainer renderBoth={false} />)
        expect(listeners['sess-b']?.size ?? 0).toBe(0)
    })
})
