import { useEffect } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { definePluginEntry } from '@cpa/plugin-sdk'
import type {
    ActionContribution,
    HostServices,
    NavigationContribution,
    PluginContext,
    ScheduleService,
    ScheduledTaskItem,
    ViewContribution,
} from '@cpa/plugin-api'
import { Clock, getDefaultHostServices } from '@cpa/plugin-ui'
import { ScheduledView } from './components/ScheduledView.js'
import { ScheduledCreateDrawer } from './components/ScheduledCreateDrawer.js'
import { useScheduledTasksStore, type ScheduledTask } from './stores/scheduledTasksStore.js'
import { initScheduledTaskRunner } from './scheduler/scheduledScheduler.js'

export { ScheduledView, ScheduledCreateDrawer }

function isScheduledPath(pathname: string | undefined): boolean {
    const path = pathname ?? '/'
    return path === '/scheduled' || path.startsWith('/scheduled/')
}

export function SchedulerDrawerOverlay() {
    const modalOpen = useScheduledTasksStore((s) => s.modalOpen)
    const editingTask = useScheduledTasksStore((s) => s.editingTask)
    const historyDrawerOpen = useScheduledTasksStore((s) => s.historyDrawerOpen)
    const historyTask = useScheduledTasksStore((s) => s.historyTask)
    const closeModal = useScheduledTasksStore((s) => s.closeModal)
    const closeHistoryDrawer = useScheduledTasksStore((s) => s.closeHistoryDrawer)

    const isScheduledPage = useRouterState({
        select: (state) => isScheduledPath(state?.location?.pathname),
    })

    useEffect(() => {
        if (!isScheduledPage && (modalOpen || historyDrawerOpen)) {
            closeModal()
            closeHistoryDrawer()
        }
    }, [isScheduledPage, modalOpen, historyDrawerOpen, closeModal, closeHistoryDrawer])

    if (!isScheduledPage || (!modalOpen && !historyDrawerOpen)) return null

    return (
        <ScheduledCreateDrawer
            open={modalOpen || historyDrawerOpen}
            onClose={() => {
                closeModal()
                closeHistoryDrawer()
            }}
            editingTask={editingTask || historyTask}
        />
    )
}

let activeDisposables: Array<() => void> = []

export const schedulerRendererEntry = definePluginEntry({
    runtime: 'renderer',
    async activate(context: PluginContext) {
        activeDisposables = []

        // 1. Register Scheduled View
        context.register<ViewContribution>({
            kind: 'view',
            id: 'scheduled',
            value: {
                id: 'scheduled',
                path: '/scheduled',
                component: ScheduledView,
                layout: {
                    showComposer: false,
                    rightPanelMode: 'hidden',
                    reserveWindowToolbar: false,
                },
            },
        })

        // 2. Register Navigation Item
        context.register<NavigationContribution>({
            kind: 'navigation',
            id: 'scheduled',
            value: {
                id: 'scheduled',
                viewId: 'scheduled',
                order: 40,
                labelKey: 'nav.scheduled',
                icon: Clock,
            },
        })

        // 3. Register Action
        context.register<ActionContribution>({
            kind: 'action',
            id: 'manage-scheduled-tasks',
            value: {
                id: 'manage-scheduled-tasks',
                title: 'shortcuts.item.manageScheduledTasks.title',
                description: 'shortcuts.item.manageScheduledTasks.desc',
                handler: (actionCtx: any) => {
                    if (actionCtx?.navigate) {
                        void actionCtx.navigate({ to: '/scheduled' })
                    }
                    useScheduledTasksStore.getState().openCreateModal()
                },
            },
        })

        // 4. Register Workspace Overlay for Drawer
        context.register({
            kind: 'slot',
            id: 'scheduled-drawer-overlay',
            target: 'workspace.overlay',
            value: {
                id: 'scheduled-drawer-overlay',
                component: SchedulerDrawerOverlay,
            },
        })

        const defaultServices = getDefaultHostServices()
        const services: HostServices | undefined =
            (context as any).services ?? defaultServices

        const resolveScheduleService = (): ScheduleService | undefined => {
            const currentServices: HostServices | undefined =
                (context as any).services ?? getDefaultHostServices()
            let sched = currentServices?.schedule
            if (!sched && typeof context.getService === 'function') {
                try {
                    sched = context.getService<ScheduleService>('schedule')
                } catch {
                    try {
                        sched = context.getService<ScheduleService>('host.services.schedule')
                    } catch {
                        // Not registered in harness container
                    }
                }
            }
            return sched
        }

        let isHydrating = false
        let saveChain = Promise.resolve()
        let lastTasksJson = JSON.stringify(useScheduledTasksStore.getState().tasks)

        const hydrateTasks = async () => {
            const sched = resolveScheduleService()
            if (!sched) return
            try {
                isHydrating = true
                const tasks = await sched.list()
                if (Array.isArray(tasks)) {
                    const currentServices = (context as any).services ?? getDefaultHostServices()
                    const projects = currentServices?.projects?.getSnapshot?.() ?? []
                    useScheduledTasksStore.getState().hydrate(tasks as ScheduledTask[], projects)
                    lastTasksJson = JSON.stringify(useScheduledTasksStore.getState().tasks)
                }
            } catch (err) {
                console.error('[cpa.core.scheduler] Failed to hydrate tasks:', err)
            } finally {
                isHydrating = false
            }
        }

        // Defer hydration until after the current platform generation commits.
        // Renderer activate runs while Main is still staged, so kvstore/schedule RPCs
        // are not dispatchable yet during synchronous activate.
        let hydrateTimer: ReturnType<typeof setTimeout> | undefined
        hydrateTimer = setTimeout(() => {
            void hydrateTasks()
        }, 0)
        activeDisposables.push(() => {
            if (hydrateTimer) clearTimeout(hydrateTimer)
        })

        if (context.events && typeof context.events.on === 'function') {
            const unsubEvents = context.events.on('schedule:updated', (payload: any) => {
                if (payload?.data) {
                    try {
                        const tasks = typeof payload.data === 'string' ? JSON.parse(payload.data) : payload.data
                        if (Array.isArray(tasks)) {
                            isHydrating = true
                            const currentServices = (context as any).services ?? getDefaultHostServices()
                            const projects = currentServices?.projects?.getSnapshot?.() ?? []
                            useScheduledTasksStore.getState().hydrate(tasks as ScheduledTask[], projects)
                            lastTasksJson = JSON.stringify(useScheduledTasksStore.getState().tasks)
                            isHydrating = false
                            return
                        }
                    } catch {
                        // Fall back to RPC fetch
                    } finally {
                        isHydrating = false
                    }
                }
                void hydrateTasks()
            })
            activeDisposables.push(unsubEvents)
        }

        // 5. Serialized save on store updates
        const unsubscribeStore = useScheduledTasksStore.subscribe(() => {
            if (isHydrating) return
            const currentTasks = useScheduledTasksStore.getState().tasks
            const currentJson = JSON.stringify(currentTasks)
            if (currentJson === lastTasksJson) return
            lastTasksJson = currentJson

            const sched = resolveScheduleService()
            if (sched) {
                saveChain = saveChain
                    .then(async () => {
                        await sched.save(currentTasks as ScheduledTaskItem[])
                    })
                    .catch((err) => {
                        console.error('[cpa.core.scheduler] Failed to save scheduled tasks:', err)
                        const errorMsg = err instanceof Error ? err.message : String(err)
                        const message = `Failed to save scheduled tasks: ${errorMsg}`

                        let notified = false
                        try {
                            const notif = context.getService<any>('notifications')
                            if (notif?.show) {
                                notif.show({ type: 'error', message })
                                notified = true
                            }
                        } catch {}

                        if (!notified) {
                            try {
                                const ui = context.getService<any>('ui')
                                if (ui?.pushToast) {
                                    ui.pushToast(message, 'error')
                                    notified = true
                                }
                            } catch {}
                        }

                        if (!notified) {
                            if (services?.notifications?.show) {
                                services.notifications.show({ type: 'error', message })
                            } else if (services?.ui?.pushToast) {
                                services.ui.pushToast(message, 'error')
                            }
                        }
                    })
            }
        })
        activeDisposables.push(unsubscribeStore)

        // 6. Start scheduler runner
        const stopRunner = initScheduledTaskRunner(services)
        activeDisposables.push(stopRunner)

        if (Array.isArray((context as any).subscriptions)) {
            (context as any).subscriptions.push(...activeDisposables)
        }
    },

    async deactivate() {
        for (const dispose of activeDisposables) {
            try {
                dispose()
            } catch (err) {
                console.error('[cpa.core.scheduler] Error during cleanup:', err)
            }
        }
        activeDisposables = []
    },
})

export const entry = schedulerRendererEntry
export default schedulerRendererEntry
