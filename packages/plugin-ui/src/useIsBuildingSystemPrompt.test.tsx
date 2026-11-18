import React from 'react'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ChatMessageService, HostServices } from '@cpa/plugin-api'
import { HostServicesProvider, useIsBuildingSystemPrompt } from './HostServicesContext.js'

function BuildState({ sessionId }: { sessionId: string }) {
    const building = useIsBuildingSystemPrompt(sessionId)
    return <div data-testid="build-state">{building ? 'building' : 'idle'}</div>
}

describe('useIsBuildingSystemPrompt', () => {
    it('reads the current session, handles notifications, and cleans up on session changes and unmount', () => {
        const building = new Set(['s1'])
        const listeners = new Map<string, Set<() => void>>()
        const chatMessages: ChatMessageService = {
            getDisplayMessages: () => [],
            getEntries: () => [],
            replaceSessionEntries: () => {},
            isBuildingSystemPrompt: (sessionId) => building.has(sessionId),
            subscribeSystemPromptBuild: (sessionId, listener) => {
                const sessionListeners = listeners.get(sessionId) ?? new Set()
                listeners.set(sessionId, sessionListeners)
                sessionListeners.add(listener)
                return () => { sessionListeners.delete(listener) }
            },
        }
        const services = { chatMessages } as HostServices
        const view = (sessionId: string) => (
            <HostServicesProvider services={services}>
                <BuildState sessionId={sessionId} />
            </HostServicesProvider>
        )
        const { rerender, unmount } = render(view('s1'))
        expect(screen.getByTestId('build-state')).toHaveTextContent('building')

        rerender(view('s2'))
        expect(screen.getByTestId('build-state')).toHaveTextContent('idle')
        expect(listeners.get('s1')?.size).toBe(0)
        act(() => {
            building.add('s2')
            listeners.get('s2')?.forEach((listener) => listener())
        })
        expect(screen.getByTestId('build-state')).toHaveTextContent('building')
        act(() => {
            building.delete('s2')
            listeners.get('s2')?.forEach((listener) => listener())
        })
        expect(screen.getByTestId('build-state')).toHaveTextContent('idle')
        unmount()
        expect(listeners.get('s2')?.size).toBe(0)
    })

    it('defaults to idle when the optional service methods are unavailable', () => {
        render(
            <HostServicesProvider services={{ chatMessages: {} } as HostServices}>
                <BuildState sessionId="s1" />
            </HostServicesProvider>,
        )
        expect(screen.getByTestId('build-state')).toHaveTextContent('idle')
    })

    it('does not query or subscribe without a session ID', () => {
        const accessedSessions: string[] = []
        const services = {
            chatMessages: {
                isBuildingSystemPrompt: (sessionId: string) => {
                    accessedSessions.push(sessionId)
                    return true
                },
                subscribeSystemPromptBuild: (sessionId: string) => {
                    accessedSessions.push(sessionId)
                    return () => {}
                },
            },
        } as unknown as HostServices
        render(
            <HostServicesProvider services={services}>
                <BuildState sessionId="" />
            </HostServicesProvider>,
        )
        expect(screen.getByTestId('build-state')).toHaveTextContent('idle')
        expect(accessedSessions).toEqual([])
    })
})
