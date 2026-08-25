import { beforeEach, describe, expect, it } from 'vitest'
import {
    useScheduledTasksStore,
    reconcileTaskProjects,
    type ScheduledTask,
} from './scheduledTasksStore.js'
import type { Project } from '@cpa/plugin-api'

describe('scheduledTasksStore', () => {
    beforeEach(() => {
        useScheduledTasksStore.setState({
            tasks: [],
            modalOpen: false,
            editingTask: null,
        })
    })

    it('adds a new scheduled task and sets default enabled state', () => {
        const store = useScheduledTasksStore.getState()
        const task = store.addTask({
            title: 'Daily Build',
            schedule: 'Weekdays 8:00',
            description: 'Run build tests',
            prompt: 'Please check CI and build status',
        })

        expect(task.id).toBeTruthy()
        expect(task.title).toBe('Daily Build')
        expect(task.enabled).toBe(true)
        expect(task.status).toBe('active')
        expect(task.unread).toBe(true)
        expect(useScheduledTasksStore.getState().tasks).toHaveLength(1)
    })

    it('reconciles persisted project references by path', () => {
        const projects: Project[] = [
            {
                id: 'project-original',
                name: 'Workspace',
                path: '/workspace/project',
                paths: ['/workspace/project'],
                pinned: false,
                createdAt: 1000,
                updatedAt: 1000,
            },
        ]
        const tasks: ScheduledTask[] = [
            {
                id: 'task-1',
                title: 'Daily Build',
                schedule: 'Weekdays 8:00',
                prompt: 'Run build tests',
                enabled: true,
                createdAt: 1000,
                projectId: 'project-original',
            },
        ]

        useScheduledTasksStore.getState().hydrate(tasks, projects)
        expect(useScheduledTasksStore.getState().tasks[0]?.projectPath).toBe(
            '/workspace/project',
        )

        const recreatedProjects: Project[] = [
            {
                id: 'project-recreated',
                name: 'Workspace',
                path: '/workspace/project',
                paths: ['/workspace/project'],
                pinned: false,
                createdAt: 2000,
                updatedAt: 2000,
            },
        ]
        useScheduledTasksStore
            .getState()
            .hydrate(useScheduledTasksStore.getState().tasks, recreatedProjects)

        expect(useScheduledTasksStore.getState().tasks[0]).toMatchObject({
            projectId: 'project-recreated',
            projectName: 'Workspace',
            projectPath: '/workspace/project',
        })
    })

    it('updates an existing scheduled task', () => {
        const store = useScheduledTasksStore.getState()
        const task = store.addTask({
            title: 'Daily Build',
            schedule: 'Weekdays 8:00',
            prompt: 'Please check CI and build status',
        })

        store.updateTask(task.id, {
            title: 'Updated Daily Build',
            schedule: 'Weekdays 9:00',
        })

        const updated = useScheduledTasksStore.getState().tasks.find((t) => t.id === task.id)
        expect(updated?.title).toBe('Updated Daily Build')
        expect(updated?.schedule).toBe('Weekdays 9:00')
    })

    it('toggles task enabled state', () => {
        const store = useScheduledTasksStore.getState()
        const task = store.addTask({
            title: 'Weekly Review',
            schedule: 'Friday 16:00',
            prompt: 'Summarize work',
        })

        expect(task.enabled).toBe(true)
        store.toggleTask(task.id)
        expect(useScheduledTasksStore.getState().tasks[0]?.enabled).toBe(false)
        expect(useScheduledTasksStore.getState().tasks[0]?.status).toBe('paused')
        store.toggleTask(task.id)
        expect(useScheduledTasksStore.getState().tasks[0]?.enabled).toBe(true)
        expect(useScheduledTasksStore.getState().tasks[0]?.status).toBe('active')
    })

    it('deletes a scheduled task', () => {
        const store = useScheduledTasksStore.getState()
        const task = store.addTask({
            title: 'Task to Delete',
            schedule: 'Daily',
            prompt: 'Do something',
        })

        expect(useScheduledTasksStore.getState().tasks).toHaveLength(1)
        store.deleteTask(task.id)
        expect(useScheduledTasksStore.getState().tasks).toHaveLength(0)
    })

    it('sets task status and syncs enabled boolean', () => {
        const store = useScheduledTasksStore.getState()
        const task = store.addTask({
            title: 'Status Test',
            schedule: 'Daily',
            prompt: 'Prompt',
        })

        store.setTaskStatus(task.id, 'paused')
        expect(useScheduledTasksStore.getState().tasks[0]?.status).toBe('paused')
        expect(useScheduledTasksStore.getState().tasks[0]?.enabled).toBe(false)

        store.setTaskStatus(task.id, 'active')
        expect(useScheduledTasksStore.getState().tasks[0]?.status).toBe('active')
        expect(useScheduledTasksStore.getState().tasks[0]?.enabled).toBe(true)

        store.setTaskStatus(task.id, 'completed')
        expect(useScheduledTasksStore.getState().tasks[0]?.status).toBe('completed')
        expect(useScheduledTasksStore.getState().tasks[0]?.enabled).toBe(false)
    })

    it('marks all tasks as read and individual task as read', () => {
        const store = useScheduledTasksStore.getState()
        const task1 = store.addTask({ title: 'T1', schedule: 'D', prompt: 'P' })
        const task2 = store.addTask({ title: 'T2', schedule: 'D', prompt: 'P' })

        expect(useScheduledTasksStore.getState().tasks[0]?.unread).toBe(true)
        expect(useScheduledTasksStore.getState().tasks[1]?.unread).toBe(true)

        store.markAsRead(task1.id)
        expect(useScheduledTasksStore.getState().tasks.find((t) => t.id === task1.id)?.unread).toBe(false)
        expect(useScheduledTasksStore.getState().tasks.find((t) => t.id === task2.id)?.unread).toBe(true)

        store.markAllAsRead()
        expect(useScheduledTasksStore.getState().tasks.every((t) => !t.unread)).toBe(true)
    })
})
