import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import type { Session, Project } from '@/types/models'
import {
    getLastUsedProjectWorktreeSettings,
    saveLastUsedProjectWorktreeSettings,
} from './projectWorktreeSettings'

describe('projectWorktreeSettings', () => {
    beforeEach(() => {
        useProjectStore.setState({ projects: [] })
        useSessionStore.setState({ sessions: [], currentSessionId: null })
    })

    it('returns empty object when projectId is not provided', () => {
        expect(getLastUsedProjectWorktreeSettings(null)).toEqual({})
        expect(getLastUsedProjectWorktreeSettings(undefined)).toEqual({})
    })

    it('returns worktree and environment settings from the most recent session', () => {
        const project: Project = {
            id: 'proj-1',
            name: 'Project 1',
            pinned: false,
            createdAt: 1000,
            updatedAt: 1000,
        }
        const sessionOlder: Session = {
            id: 's-old',
            projectId: 'proj-1',
            title: 'Old Session',
            pinned: false,
            workLocation: 'local',
            environmentId: null,
            createdAt: 1000,
            updatedAt: 1000,
        }
        const sessionNewer: Session = {
            id: 's-new',
            projectId: 'proj-1',
            title: 'New Session',
            pinned: false,
            workLocation: 'worktree',
            environmentId: 'env-custom',
            createdAt: 2000,
            updatedAt: 2000,
        }

        useProjectStore.setState({ projects: [project] })
        useSessionStore.setState({ sessions: [sessionOlder, sessionNewer] })

        const settings = getLastUsedProjectWorktreeSettings('proj-1')
        expect(settings).toEqual({
            workLocation: 'worktree',
            environmentId: 'env-custom',
        })
    })

    it('returns local settings when the most recent session switched back to local', () => {
        const sessionOlder: Session = {
            id: 's-old',
            projectId: 'proj-1',
            title: 'Old Worktree Session',
            pinned: false,
            workLocation: 'worktree',
            environmentId: 'env-custom',
            createdAt: 1000,
            updatedAt: 1000,
        }
        const sessionNewer: Session = {
            id: 's-new',
            projectId: 'proj-1',
            title: 'New Local Session',
            pinned: false,
            workLocation: 'local',
            environmentId: null,
            createdAt: 2000,
            updatedAt: 2000,
        }

        useSessionStore.setState({ sessions: [sessionOlder, sessionNewer] })

        const settings = getLastUsedProjectWorktreeSettings('proj-1')
        expect(settings).toEqual({
            workLocation: 'local',
            environmentId: null,
        })
    })

    it('prefers unarchived active sessions over archived ones', () => {
        const sessionActive: Session = {
            id: 's-active',
            projectId: 'proj-1',
            title: 'Active Worktree Session',
            pinned: false,
            workLocation: 'worktree',
            environmentId: 'env-active',
            createdAt: 1000,
            updatedAt: 1000,
        }
        const sessionArchived: Session = {
            id: 's-archived',
            projectId: 'proj-1',
            title: 'Archived Local Session',
            pinned: false,
            workLocation: 'local',
            environmentId: null,
            createdAt: 2000,
            updatedAt: 2000,
            archivedAt: 2500,
        }

        useSessionStore.setState({ sessions: [sessionActive, sessionArchived] })

        const settings = getLastUsedProjectWorktreeSettings('proj-1')
        expect(settings).toEqual({
            workLocation: 'worktree',
            environmentId: 'env-active',
        })
    })

    it('falls back to project entity properties when no sessions exist', () => {
        const project: Project = {
            id: 'proj-1',
            name: 'Project 1',
            pinned: false,
            workLocation: 'worktree',
            environmentId: 'env-from-proj',
            createdAt: 1000,
            updatedAt: 1000,
        }

        useProjectStore.setState({ projects: [project] })
        useSessionStore.setState({ sessions: [] })

        const settings = getLastUsedProjectWorktreeSettings('proj-1')
        expect(settings).toEqual({
            workLocation: 'worktree',
            environmentId: 'env-from-proj',
        })
    })

    it('saveLastUsedProjectWorktreeSettings updates the project record in projectStore', () => {
        const project: Project = {
            id: 'proj-1',
            name: 'Project 1',
            pinned: false,
            createdAt: 1000,
            updatedAt: 1000,
        }

        useProjectStore.setState({ projects: [project] })

        saveLastUsedProjectWorktreeSettings('proj-1', {
            workLocation: 'worktree',
            environmentId: 'env-saved',
        })

        const updated = useProjectStore.getState().projects.find((p) => p.id === 'proj-1')
        expect(updated?.workLocation).toBe('worktree')
        expect(updated?.environmentId).toBe('env-saved')
    })
})
