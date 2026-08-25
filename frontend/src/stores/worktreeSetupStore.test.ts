import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useWorktreeSetupStore } from './worktreeSetupStore'
import { createHostServices } from '@/application/services/createHostServices'
import { useProjectStore } from './projectStore'
import { useSessionStore } from './sessionStore'
import * as worktreeManager from '@/lib/worktreeManager'
import * as environmentRunner from '@/lib/environmentRunner'

vi.mock('@/lib/worktreeManager', () => ({
    createWorktreeForProject: vi.fn(),
}))

vi.mock('@/lib/environmentRunner', () => ({
    runEnvironmentSetup: vi.fn(),
}))

describe('worktreeSetupStore', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        createHostServices()
        useWorktreeSetupStore.setState({ setups: {} })
        useSessionStore.setState({ sessions: [], currentSessionId: null })
        useProjectStore.setState({
            projects: [
                {
                    id: 'proj-1',
                    name: 'My Project',
                    paths: ['/projects/my-app'],
                    setupScript: 'echo setting up',
                    pinned: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            ],
        })
    })

    it('successfully completes worktree without running environment setup when no environment is selected', async () => {
        useSessionStore.setState({
            sessions: [
                {
                    id: 'sess-no-env',
                    title: 'Test Session',
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    pinned: false,
                },
            ],
        })

        vi.mocked(worktreeManager.createWorktreeForProject).mockResolvedValue({
            worktreePath: '/worktrees/proj-wt-123',
            branch: 'codex/12345678',
            isNewBranch: true,
        })

        const res = await useWorktreeSetupStore.getState().startSetup({
            sessionId: 'sess-no-env',
            sourceTreePath: '/projects/my-app',
            environmentId: null,
        })

        expect(res.ok).toBe(true)
        expect(res.worktreePath).toBe('/worktrees/proj-wt-123')
        expect(res.branch).toBe('codex/12345678')
        // runEnvironmentSetup should NOT be called when no environment is chosen
        expect(environmentRunner.runEnvironmentSetup).not.toHaveBeenCalled()

        const setup = useWorktreeSetupStore.getState().getSetup('sess-no-env')
        expect(setup?.status).toBe('ready')
        expect(setup?.stepWorkspace).toBe('done')
        expect(setup?.stepCheckout).toBe('done')
        expect(setup?.stepEnvironment).toBe('done')

        const session = useSessionStore.getState().sessions.find((s) => s.id === 'sess-no-env')
        expect(session?.worktreePath).toBe('/worktrees/proj-wt-123')
        expect(session?.branch).toBe('codex/12345678')
    })

    it('successfully runs environment setup when an environment is selected', async () => {
        vi.mocked(worktreeManager.createWorktreeForProject).mockResolvedValue({
            worktreePath: '/worktrees/proj-wt-123',
            branch: 'cpa/12345678',
            isNewBranch: true,
        })

        vi.mocked(environmentRunner.runEnvironmentSetup).mockResolvedValue({
            ok: true,
            scriptRan: true,
            exitCode: 0,
            output: 'Setup completed',
        })

        const res = await useWorktreeSetupStore.getState().startSetup({
            sessionId: 'sess-with-env',
            sourceTreePath: '/projects/my-app',
            environmentId: 'proj-1',
        })

        expect(res.ok).toBe(true)
        expect(res.worktreePath).toBe('/worktrees/proj-wt-123')
        expect(environmentRunner.runEnvironmentSetup).toHaveBeenCalledWith(
            expect.objectContaining({
                sourceTreePath: '/projects/my-app',
                worktreePath: '/worktrees/proj-wt-123',
                project: expect.objectContaining({ id: 'proj-1' }),
            }),
        )

        const setup = useWorktreeSetupStore.getState().getSetup('sess-with-env')
        expect(setup?.status).toBe('ready')
        expect(setup?.stepWorkspace).toBe('done')
        expect(setup?.stepCheckout).toBe('done')
        expect(setup?.stepEnvironment).toBe('done')
    })

    it('handles environment setup failure with error logs and retry', async () => {
        useSessionStore.setState({
            sessions: [
                {
                    id: 'sess-1',
                    title: 'Session 1',
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    pinned: false,
                },
            ],
        })

        vi.mocked(worktreeManager.createWorktreeForProject).mockResolvedValue({
            worktreePath: '/worktrees/proj-wt-123',
            branch: 'cpa/12345678',
            isNewBranch: true,
        })

        vi.mocked(environmentRunner.runEnvironmentSetup).mockResolvedValue({
            ok: false,
            scriptRan: true,
            exitCode: 1,
            output: 'Setup script exited with code 1',
            error: 'Setup script exited with code 1',
        })

        const res = await useWorktreeSetupStore.getState().startSetup({
            sessionId: 'sess-1',
            sourceTreePath: '/projects/my-app',
            environmentId: 'proj-1',
        })

        expect(res.ok).toBe(false)
        const setup = useWorktreeSetupStore.getState().getSetup('sess-1')
        expect(setup?.status).toBe('error')
        expect(setup?.stepEnvironment).toBe('error')
        expect(setup?.exitCode).toBe(1)

        // Verifies setup was automatically synced to sessionStore
        const session = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1')
        expect(session?.worktreeSetup?.status).toBe('error')
        expect(session?.worktreeSetup?.stepEnvironment).toBe('error')

        expect(session?.branch).toBeUndefined()

        vi.mocked(environmentRunner.runEnvironmentSetup).mockResolvedValue({
            ok: true,
            scriptRan: true,
            exitCode: 0,
            output: 'Setup completed on retry',
        })

        const retryResult = await useWorktreeSetupStore.getState().retrySetup('sess-1')

        expect(retryResult).toEqual({
            ok: true,
            worktreePath: '/worktrees/proj-wt-123',
            branch: 'cpa/12345678',
        })
        expect(useWorktreeSetupStore.getState().getSetup('sess-1')?.status).toBe('ready')
        expect(
            useSessionStore.getState().sessions.find((s) => s.id === 'sess-1'),
        ).toMatchObject({
            workLocation: 'worktree',
            worktreePath: '/worktrees/proj-wt-123',
            branch: 'cpa/12345678',
            worktreeSetup: expect.objectContaining({ status: 'ready' }),
        })
    })

    it('syncs the worktree branch when continuing after an environment failure', () => {
        useSessionStore.setState({
            sessions: [
                {
                    id: 'sess-continue',
                    title: 'Continue Session',
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    pinned: false,
                },
            ],
        })
        useWorktreeSetupStore.setState({
            setups: {
                'sess-continue': {
                    sessionId: 'sess-continue',
                    status: 'error',
                    stepWorkspace: 'done',
                    stepCheckout: 'done',
                    stepEnvironment: 'error',
                    worktreePath: '/worktrees/proj-wt-continue',
                    branch: 'cpa/continue-branch',
                    environmentId: 'proj-1',
                    logs: 'Setup failed',
                    expandedDetails: true,
                },
            },
        })

        useWorktreeSetupStore.getState().continueAnyway('sess-continue')

        expect(useWorktreeSetupStore.getState().getSetup('sess-continue')?.status).toBe('ready')
        expect(
            useSessionStore.getState().sessions.find((s) => s.id === 'sess-continue'),
        ).toMatchObject({
            workLocation: 'worktree',
            worktreePath: '/worktrees/proj-wt-continue',
            branch: 'cpa/continue-branch',
            environmentId: 'proj-1',
            worktreeSetup: expect.objectContaining({ status: 'ready' }),
        })
    })
})
