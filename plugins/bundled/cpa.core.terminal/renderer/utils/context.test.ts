import { describe, expect, it } from 'vitest'
import { resolveTerminalContext } from './context.js'

describe('resolveTerminalContext', () => {
    it('uses the project root when a session has a project', () => {
        const context = resolveTerminalContext({
            sessionId: 'session-1',
            sessions: [{ id: 'session-1', projectId: 'project-1' }],
            projects: [{ id: 'project-1', name: 'Project One', path: '/workspace/project-one' }],
            pendingProjectId: null,
            fallbackTitle: 'Default Terminal',
        })

        expect(context).toEqual({
            title: 'Project One',
            cwd: '/workspace/project-one',
        })
    })

    it('falls back to pending project when session has none', () => {
        const context = resolveTerminalContext({
            sessionId: null,
            sessions: [],
            projects: [{ id: 'project-2', name: 'Project Two', path: '/workspace/project-two' }],
            pendingProjectId: 'project-2',
            fallbackTitle: 'Default Terminal',
        })

        expect(context).toEqual({
            title: 'Project Two',
            cwd: '/workspace/project-two',
        })
    })

    it('falls back to default title and empty cwd when no project is matched', () => {
        const context = resolveTerminalContext({
            sessionId: null,
            sessions: [],
            projects: [],
            pendingProjectId: null,
            fallbackTitle: 'Default Terminal',
        })

        expect(context).toEqual({
            title: 'Default Terminal',
            cwd: '',
        })
    })
})
