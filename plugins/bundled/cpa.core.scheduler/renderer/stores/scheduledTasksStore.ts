import { useSyncExternalStore } from 'react'
import type { Project, ScheduledTaskItem } from '@cpa/plugin-api'
import {
    findScheduledTaskProject,
    getPrimaryProjectPath,
} from '../scheduler/scheduledTaskProject.js'

export interface ScheduledTask extends ScheduledTaskItem {
    description?: string
    unread?: boolean
    runIn?: string
    chatSessionId?: string | null
    chatTitle?: string
    notification?: string
    projectId?: string | null
    projectName?: string
    projectPath?: string
    modelId?: string
    modelLabel?: string
    reasoningLevel?: string
}

export interface ScheduledTasksState {
    tasks: ScheduledTask[]
    modalOpen: boolean
    editingTask: ScheduledTask | null
    historyDrawerOpen: boolean
    historyTask: ScheduledTask | null
    addTask: (task: {
        title: string
        schedule: string
        description?: string
        prompt: string
        enabled?: boolean
        status?: 'active' | 'paused' | 'completed'
        unread?: boolean
        runIn?: string
        chatSessionId?: string | null
        chatTitle?: string
        notification?: string
        projectId?: string | null
        projectName?: string
        projectPath?: string
        modelId?: string
        modelLabel?: string
        reasoningLevel?: string
    }) => ScheduledTask
    updateTask: (id: string, updates: Partial<Omit<ScheduledTask, 'id' | 'createdAt'>>) => void
    deleteTask: (id: string) => void
    toggleTask: (id: string) => void
    setTaskStatus: (id: string, status: 'active' | 'paused' | 'completed') => void
    markAllAsRead: () => void
    markAsRead: (id: string) => void
    openCreateModal: () => void
    openEditModal: (task: ScheduledTask) => void
    closeModal: () => void
    openHistoryModal: (task: ScheduledTask) => void
    closeHistoryModal: () => void
    openHistoryDrawer: (task: ScheduledTask) => void
    closeHistoryDrawer: () => void
    hydrate: (tasks: ScheduledTask[], projects?: readonly Project[]) => void
}

function createStore<T extends object>(
    initializer: (
        set: (patch: Partial<T> | ((prev: T) => Partial<T>)) => void,
        get: () => T,
    ) => T,
) {
    let state: T
    const listeners = new Set<() => void>()

    const getState = () => state
    const setState = (patch: Partial<T> | ((prev: T) => Partial<T>)) => {
        const nextPartial = typeof patch === 'function' ? (patch as any)(state) : patch
        state = { ...state, ...nextPartial }
        for (const l of Array.from(listeners)) {
            l()
        }
    }
    const subscribe = (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
    }

    state = initializer(setState, getState)

    function useStore<U = T>(selector: (s: T) => U = (s) => s as any): U {
        return useSyncExternalStore(
            subscribe,
            () => selector(state),
            () => selector(state),
        )
    }

    useStore.getState = getState
    useStore.setState = setState
    useStore.subscribe = subscribe

    return useStore
}

function generateId(): string {
    return 'sched-' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36)
}

export function reconcileTaskProjects(
    tasks: ScheduledTask[],
    projects: readonly Project[] = [],
): ScheduledTask[] {
    if (!projects || projects.length === 0) return tasks
    let reconciledTasks: ScheduledTask[] | null = null

    tasks.forEach((task, index) => {
        const project = findScheduledTaskProject(task, projects)
        if (!project) return

        const projectPath = getPrimaryProjectPath(project)
        if (
            task.projectId === project.id &&
            task.projectName === project.name &&
            (!projectPath || task.projectPath === projectPath)
        ) {
            return
        }

        reconciledTasks ??= tasks.slice()
        reconciledTasks[index] = {
            ...task,
            projectId: project.id,
            projectName: project.name,
            ...(projectPath ? { projectPath } : {}),
        }
    })

    return reconciledTasks ?? tasks
}

export const useScheduledTasksStore = createStore<ScheduledTasksState>((set) => ({
    tasks: [],
    modalOpen: false,
    editingTask: null,
    historyDrawerOpen: false,
    historyTask: null,

    hydrate: (tasks, projects = []) => {
        const reconciled = reconcileTaskProjects(tasks, projects)
        set({ tasks: reconciled })
    },

    addTask: (taskData) => {
        const isEnabled = taskData.enabled ?? true
        const newTask: ScheduledTask = {
            id: generateId(),
            title: taskData.title.trim(),
            schedule: taskData.schedule.trim(),
            description: taskData.description?.trim() || undefined,
            prompt: taskData.prompt.trim(),
            enabled: isEnabled,
            status: taskData.status ?? (isEnabled ? 'active' : 'paused'),
            unread: taskData.unread ?? true,
            createdAt: Date.now(),
            lastRunAt: null,
            runIn: taskData.runIn || 'existing-chat',
            chatSessionId: taskData.chatSessionId || null,
            chatTitle: taskData.chatTitle,
            notification: taskData.notification || 'important',
            projectId: taskData.projectId || null,
            projectName: taskData.projectName,
            projectPath: taskData.projectPath,
            modelId: taskData.modelId,
            modelLabel: taskData.modelLabel,
            reasoningLevel: taskData.reasoningLevel,
        }

        set((state) => ({
            tasks: [newTask, ...state.tasks],
            modalOpen: false,
            editingTask: null,
        }))

        return newTask
    },

    updateTask: (id, updates) => {
        set((state) => {
            const nextTasks = state.tasks.map((task) => {
                if (task.id !== id) return task
                const nextEnabled = updates.enabled ?? task.enabled
                let nextStatus = updates.status ?? task.status
                if (updates.enabled !== undefined && updates.status === undefined) {
                    nextStatus = nextEnabled ? 'active' : 'paused'
                }
                return {
                    ...task,
                    ...updates,
                    title: updates.title !== undefined ? updates.title.trim() : task.title,
                    schedule: updates.schedule !== undefined ? updates.schedule.trim() : task.schedule,
                    prompt: updates.prompt !== undefined ? updates.prompt.trim() : task.prompt,
                    description:
                        updates.description !== undefined
                            ? updates.description?.trim() || undefined
                            : task.description,
                    enabled: nextEnabled,
                    status: nextStatus,
                }
            })
            return {
                tasks: nextTasks,
                editingTask: state.editingTask?.id === id ? null : state.editingTask,
                modalOpen: state.editingTask?.id === id ? false : state.modalOpen,
            }
        })
    },

    deleteTask: (id) => {
        set((state) => ({
            tasks: state.tasks.filter((task) => task.id !== id),
            editingTask: state.editingTask?.id === id ? null : state.editingTask,
            modalOpen: state.editingTask?.id === id ? false : state.modalOpen,
            historyTask: state.historyTask?.id === id ? null : state.historyTask,
            historyDrawerOpen: state.historyTask?.id === id ? false : state.historyDrawerOpen,
        }))
    },

    toggleTask: (id) => {
        set((state) => ({
            tasks: state.tasks.map((task) => {
                if (task.id !== id) return task
                const nextEnabled = !task.enabled
                return {
                    ...task,
                    enabled: nextEnabled,
                    status: nextEnabled ? 'active' : 'paused',
                }
            }),
        }))
    },

    setTaskStatus: (id, status) => {
        set((state) => ({
            tasks: state.tasks.map((task) => {
                if (task.id !== id) return task
                return {
                    ...task,
                    status,
                    enabled: status === 'active',
                }
            }),
        }))
    },

    markAllAsRead: () => {
        set((state) => ({
            tasks: state.tasks.map((t) => ({ ...t, unread: false })),
        }))
    },

    markAsRead: (id) => {
        set((state) => ({
            tasks: state.tasks.map((t) => (t.id === id ? { ...t, unread: false } : t)),
        }))
    },

    openCreateModal: () => set({ modalOpen: true, editingTask: null }),
    openEditModal: (task) => set({ modalOpen: true, editingTask: task }),
    closeModal: () => set({ modalOpen: false, editingTask: null }),
    openHistoryModal: (task) =>
        set({ historyDrawerOpen: true, historyTask: task, modalOpen: false, editingTask: null }),
    closeHistoryModal: () => set({ historyDrawerOpen: false, historyTask: null }),
    openHistoryDrawer: (task) =>
        set({ historyDrawerOpen: true, historyTask: task, modalOpen: false, editingTask: null }),
    closeHistoryDrawer: () => set({ historyDrawerOpen: false, historyTask: null }),
}))
