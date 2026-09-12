import { create } from 'zustand'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import type {
    WorktreeSessionSetup,
    WorktreeSetupStatus,
    WorktreeSetupStepStatus,
} from '@cpa/plugin-api'

export type { WorktreeSessionSetup, WorktreeSetupStatus, WorktreeSetupStepStatus }

export type WorktreeRunnerFn = (input: {
    sessionId: string
    sourceTreePath: string
    worktreePath?: string
    branch?: string | null
    baseBranch?: string | null
    branchPrefix?: string | null
    environmentId?: string | null
    worktreeRootDir?: string
    fetchUpstream?: boolean
    onProgress?: (step: 'preparing' | 'checking_out' | 'setting_up' | 'ready' | 'error') => void
    onLog?: (chunk: string) => void
}) => Promise<{ ok: boolean; worktreePath?: string; branch?: string; error?: string; exitCode?: number }>

let registeredWorktreeRunner: WorktreeRunnerFn | null = null

export function setWorktreeRunner(runner: WorktreeRunnerFn | null): void {
    registeredWorktreeRunner = runner
}

export interface SetupWorktreeParams {
    sessionId: string
    sourceTreePath: string
    branch?: string | null
    baseBranch?: string | null
    branchPrefix?: string | null
    environmentId?: string | null
    worktreeRootDir?: string
    fetchUpstream?: boolean
}

interface WorktreeSetupState {
    setups: Record<string, WorktreeSessionSetup>
    getSetup: (sessionId: string) => WorktreeSessionSetup | undefined
    startSetup: (params: SetupWorktreeParams) => Promise<{ ok: boolean; worktreePath?: string; branch?: string }>
    retrySetup: (sessionId: string) => Promise<{ ok: boolean; worktreePath?: string; branch?: string }>
    continueAnyway: (sessionId: string) => void
    toggleDetails: (sessionId: string) => void
    clearSetup: (sessionId: string) => void
    setSetupState: (sessionId: string, partial: Partial<WorktreeSessionSetup>) => void
    importSetups: (setups: Record<string, WorktreeSessionSetup>) => void
}

function syncSetupToSession(sessionId: string, setup: WorktreeSessionSetup | undefined) {
    if (setup) {
        useSessionStore.getState().setSessionWorktreeSetup?.(sessionId, setup)
    }
}

export const useWorktreeSetupStore = create<WorktreeSetupState>((set, get) => ({
    setups: {},

    getSetup: (sessionId: string) => get().setups[sessionId],

    importSetups: (newSetups: Record<string, WorktreeSessionSetup>) => {
        set((state) => ({
            setups: {
                ...state.setups,
                ...newSetups,
            },
        }))
    },

    startSetup: async (params: SetupWorktreeParams) => {
        const {
            sessionId,
            sourceTreePath,
            branch,
            baseBranch: customBaseBranch,
            environmentId,
            worktreeRootDir: customRootDir,
            fetchUpstream: customFetchUpstream,
        } = params

        const settings = useSettingsStore.getState().settings.worktrees
        const gitSettings = useSettingsStore.getState().settings.git
        const branchPrefix = params.branchPrefix ?? gitSettings?.branchPrefix ?? 'cpa/'
        const worktreeRootDir = customRootDir ?? settings?.rootDir
        const fetchUpstream = customFetchUpstream ?? (settings?.fetchUpstream ?? true)

        const project = environmentId
            ? useProjectStore
                  .getState()
                  .projects.find((p) => p.id === environmentId || p.name === environmentId)
            : undefined

        const initialSetup: WorktreeSessionSetup = {
            sessionId,
            status: 'preparing',
            stepWorkspace: 'running',
            stepCheckout: 'pending',
            stepEnvironment: 'pending',
            sourceTreePath,
            branch: branch || undefined,
            baseBranch: customBaseBranch || branch || undefined,
            environmentId,
            environmentName: project?.name,
            logs: '',
            expandedDetails: true,
        }

        set((state) => ({
            setups: {
                ...state.setups,
                [sessionId]: initialSetup,
            },
        }))
        syncSetupToSession(sessionId, initialSetup)

        let currentWorktreePath: string | undefined = undefined
        let currentBranch: string | undefined = branch || undefined

        try {
            if (!registeredWorktreeRunner) {
                throw new Error('Worktree runner not registered')
            }
            const wtResult = await registeredWorktreeRunner({
                sessionId,
                sourceTreePath,
                branch,
                baseBranch: customBaseBranch,
                branchPrefix,
                environmentId,
                worktreeRootDir,
                fetchUpstream,
                onProgress: (step) => {
                    if (step === 'preparing') {
                        set((state) => {
                            const cur = state.setups[sessionId]
                            if (!cur) return state
                            const next = {
                                ...cur,
                                status: 'preparing' as const,
                                stepWorkspace: 'running' as const,
                            }
                            syncSetupToSession(sessionId, next)
                            return {
                                setups: {
                                    ...state.setups,
                                    [sessionId]: next,
                                },
                            }
                        })
                    } else if (step === 'checking_out') {
                        set((state) => {
                            const cur = state.setups[sessionId]
                            if (!cur) return state
                            const next = {
                                ...cur,
                                status: 'checking_out' as const,
                                stepWorkspace: 'done' as const,
                                stepCheckout: 'running' as const,
                            }
                            syncSetupToSession(sessionId, next)
                            return {
                                setups: {
                                    ...state.setups,
                                    [sessionId]: next,
                                },
                            }
                        })
                    } else if (step === 'setting_up') {
                        set((state) => {
                            const cur = state.setups[sessionId]
                            if (!cur) return state
                            const next = {
                                ...cur,
                                stepWorkspace: 'done' as const,
                                stepCheckout: 'done' as const,
                                stepEnvironment: 'running' as const,
                                status: 'setting_up' as const,
                                worktreePath: currentWorktreePath,
                                branch: currentBranch,
                                baseBranch: cur.baseBranch || customBaseBranch || branch || undefined,
                            }
                            syncSetupToSession(sessionId, next)
                            return {
                                setups: {
                                    ...state.setups,
                                    [sessionId]: next,
                                },
                            }
                        })
                    }
                },
                onLog: (chunk) => {
                    set((state) => {
                        const cur = state.setups[sessionId]
                        if (!cur) return state
                        const next = {
                            ...cur,
                            logs: cur.logs + chunk,
                        }
                        syncSetupToSession(sessionId, next)
                        return {
                            setups: {
                                ...state.setups,
                                [sessionId]: next,
                            },
                        }
                    })
                },
            })

            currentWorktreePath = wtResult.worktreePath
            currentBranch = wtResult.branch ?? currentBranch

            if (wtResult.ok) {
                set((state) => {
                    const cur = state.setups[sessionId]
                    if (!cur) return state
                    const next = {
                        ...cur,
                        status: 'ready' as const,
                        stepWorkspace: 'done' as const,
                        stepCheckout: 'done' as const,
                        stepEnvironment: 'done' as const,
                        worktreePath: currentWorktreePath,
                        branch: currentBranch,
                        exitCode: 0,
                    }
                    syncSetupToSession(sessionId, next)
                    return {
                        setups: {
                            ...state.setups,
                            [sessionId]: next,
                        },
                    }
                })

                return { ok: true, worktreePath: currentWorktreePath, branch: currentBranch }
            } else {
                set((state) => {
                    const cur = state.setups[sessionId]
                    if (!cur) return state
                    const isCheckoutFailed = cur.stepCheckout === 'running' || cur.stepWorkspace === 'running'
                    const next = {
                        ...cur,
                        status: 'error' as const,
                        stepWorkspace: cur.stepWorkspace === 'running' ? ('error' as const) : cur.stepWorkspace,
                        stepCheckout: isCheckoutFailed ? ('error' as const) : cur.stepCheckout,
                        stepEnvironment: !isCheckoutFailed ? ('error' as const) : ('pending' as const),
                        worktreePath: currentWorktreePath,
                        branch: currentBranch ?? cur.branch,
                        error: wtResult.error,
                        exitCode: wtResult.exitCode ?? 1,
                        expandedDetails: true,
                    }
                    syncSetupToSession(sessionId, next)
                    return {
                        setups: {
                            ...state.setups,
                            [sessionId]: next,
                        },
                    }
                })

                return { ok: false, worktreePath: currentWorktreePath, branch: currentBranch }
            }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            set((state) => {
                const cur = state.setups[sessionId]
                if (!cur) return state
                const isCheckoutFailed = cur.stepCheckout === 'running' || cur.stepWorkspace === 'running'
                const next = {
                    ...cur,
                    status: 'error' as const,
                    stepWorkspace: cur.stepWorkspace === 'running' ? ('error' as const) : cur.stepWorkspace,
                    stepCheckout: isCheckoutFailed ? ('error' as const) : cur.stepCheckout,
                    stepEnvironment: !isCheckoutFailed ? ('error' as const) : ('pending' as const),
                    error: errorMsg,
                    logs: cur.logs + `\nError: ${errorMsg}\n`,
                    expandedDetails: true,
                }
                syncSetupToSession(sessionId, next)
                return {
                    setups: {
                        ...state.setups,
                        [sessionId]: next,
                    },
                }
            })

            return { ok: false, worktreePath: currentWorktreePath }
        }
    },

    retrySetup: async (sessionId: string) => {
        const setup = get().setups[sessionId]
        if (!setup) return { ok: false }

        if (!setup.worktreePath) {
            return get().startSetup({
                sessionId,
                sourceTreePath: setup.sourceTreePath || '',
                branch: setup.branch,
                environmentId: setup.environmentId,
            })
        }

        // Re-run environment setup only
        set((state) => {
            const cur = state.setups[sessionId]
            if (!cur) return state
            const next = {
                ...cur,
                status: 'setting_up' as const,
                stepEnvironment: 'running' as const,
                logs: '',
                error: undefined,
                exitCode: undefined,
            }
            syncSetupToSession(sessionId, next)
            return {
                setups: {
                    ...state.setups,
                    [sessionId]: next,
                },
            }
        })

        try {
            if (!registeredWorktreeRunner) {
                throw new Error('Worktree runner not registered')
            }
            const wtResult = await registeredWorktreeRunner({
                sessionId,
                worktreePath: setup.worktreePath,
                sourceTreePath: setup.sourceTreePath || setup.worktreePath,
                branch: setup.branch,
                environmentId: setup.environmentId,
                onLog: (chunk) => {
                    set((state) => {
                        const cur = state.setups[sessionId]
                        if (!cur) return state
                        const next = {
                            ...cur,
                            logs: cur.logs + chunk,
                        }
                        syncSetupToSession(sessionId, next)
                        return {
                            setups: {
                                ...state.setups,
                                [sessionId]: next,
                            },
                        }
                    })
                },
            })

            if (wtResult.ok) {
                set((state) => {
                    const cur = state.setups[sessionId]
                    if (!cur) return state
                    const next = {
                        ...cur,
                        status: 'ready' as const,
                        stepEnvironment: 'done' as const,
                        exitCode: 0,
                    }
                    syncSetupToSession(sessionId, next)
                    return {
                        setups: {
                            ...state.setups,
                            [sessionId]: next,
                        },
                    }
                })

                return {
                    ok: true,
                    worktreePath: setup.worktreePath,
                    branch: setup.branch,
                }
            } else {
                set((state) => {
                    const cur = state.setups[sessionId]
                    if (!cur) return state
                    const next = {
                        ...cur,
                        status: 'error' as const,
                        stepEnvironment: 'error' as const,
                        error: wtResult.error,
                        exitCode: wtResult.exitCode ?? 1,
                        expandedDetails: true,
                    }
                    syncSetupToSession(sessionId, next)
                    return {
                        setups: {
                            ...state.setups,
                            [sessionId]: next,
                        },
                    }
                })
                return { ok: false, worktreePath: setup.worktreePath }
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err)
            set((state) => {
                const cur = state.setups[sessionId]
                if (!cur) return state
                const next = {
                    ...cur,
                    status: 'error' as const,
                    stepEnvironment: 'error' as const,
                    error: errorMsg,
                    exitCode: 1,
                    expandedDetails: true,
                }
                syncSetupToSession(sessionId, next)
                return {
                    setups: {
                        ...state.setups,
                        [sessionId]: next,
                    },
                }
            })
            return { ok: false, worktreePath: setup.worktreePath }
        }
    },

    continueAnyway: (sessionId: string) => {
        set((state) => {
            const cur = state.setups[sessionId]
            if (!cur) return state
            const next = {
                ...cur,
                status: 'ready' as const,
            }
            syncSetupToSession(sessionId, next)
            return {
                setups: {
                    ...state.setups,
                    [sessionId]: next,
                },
            }
        })

        const setup = get().setups[sessionId]
        if (setup?.worktreePath) {
            useSessionStore.getState().setSessionWorktree?.(
                sessionId,
                'worktree',
                setup.worktreePath,
                setup.environmentId,
            )
            if (setup.branch) {
                useSessionStore.getState().setSessionBranch?.(sessionId, setup.branch)
            }
        }
    },

    toggleDetails: (sessionId: string) => {
        set((state) => {
            const cur = state.setups[sessionId]
            if (!cur) return state
            const next = {
                ...cur,
                expandedDetails: !cur.expandedDetails,
            }
            syncSetupToSession(sessionId, next)
            return {
                setups: {
                    ...state.setups,
                    [sessionId]: next,
                },
            }
        })
    },

    clearSetup: (sessionId: string) => {
        set((state) => {
            const next = { ...state.setups }
            delete next[sessionId]
            return { setups: next }
        })
        useSessionStore.getState().setSessionWorktreeSetup?.(sessionId, undefined)
    },

    setSetupState: (sessionId: string, partial: Partial<WorktreeSessionSetup>) => {
        set((state) => {
            const cur = state.setups[sessionId]
            if (!cur) return state
            const next = {
                ...cur,
                ...partial,
            }
            syncSetupToSession(sessionId, next)
            return {
                setups: {
                    ...state.setups,
                    [sessionId]: next,
                },
            }
        })
    },
}))
