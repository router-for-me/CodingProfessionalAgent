/**
 * Application operations for Hook configurations.
 * Coordinates I/O through HostServices without embedding I/O inside Zustand store.
 */

import type {
    CommandHookHandlerConfig,
    HookEventName,
    HookHandlerConfig,
    HookMetadata,
    HostServices,
    MatcherGroup,
} from '@cpa/plugin-api'
import { useHooksStore, type HooksState } from './hooksStore.js'

export async function fetchHooks(services: HostServices, projectPaths: string[] = []): Promise<void> {
    const store = useHooksStore.getState()
    store.setLoading(true)

    try {
        const hookService = services?.hooks
        if (!hookService) {
            store.setLoading(false)
            return
        }

        const userConfig = await hookService.load('')

        const projectMap: HooksState['projectConfigs'] = {}
        for (const projPath of projectPaths) {
            if (!projPath) continue
            const projConfig = await hookService.load(projPath)
            if (projConfig && projConfig.file) {
                projectMap[projPath] = {
                    file: projConfig.file,
                    path: projConfig.path || `${projPath}/.cpa/hooks.json`,
                    hooks: (projConfig.projectHooks as HookMetadata[]) || [],
                }
            }
        }

        store.setHooksData({
            userConfigFile: userConfig.userConfigFile ?? userConfig.file ?? null,
            userConfigPath: userConfig.userConfigPath ?? userConfig.path ?? null,
            userHooks: (userConfig.userHooks as HookMetadata[]) || [],
            projectConfigs: projectMap,
        })
    } catch (err) {
        console.error('Failed to fetch hooks:', err)
        store.setLoading(false)
    }
}

export async function saveEditingHook(
    services: HostServices,
    data: {
        source: 'user' | string
        eventName: HookEventName
        matcher: string
        handler: HookHandlerConfig
    },
    projectPaths: string[] = [],
): Promise<void> {
    const { source, eventName, matcher, handler } = data
    const hookService = services?.hooks
    if (!hookService) return

    if (source === 'user') {
        const userConfig = await hookService.load('')
        const file = userConfig.userConfigFile ?? userConfig.file ?? { hooks: {}, state: {} }
        if (!file.hooks) file.hooks = {}
        if (!(file.hooks as any)[eventName]) (file.hooks as any)[eventName] = []

        const groups: MatcherGroup[] = (file.hooks as any)[eventName]!
        const trimmedMatcher = matcher.trim() || undefined
        let targetGroup = groups.find((g) => g.matcher === trimmedMatcher)

        if (!targetGroup) {
            targetGroup = {
                matcher: trimmedMatcher,
                hooks: [],
            }
            groups.push(targetGroup)
        }

        targetGroup.hooks.push(handler)
        await hookService.save('user', { file })
    } else {
        const projConfig = await hookService.load(source)
        if (projConfig && projConfig.file) {
            const file = projConfig.file
            if (!file.hooks) file.hooks = {}
            if (!(file.hooks as any)[eventName]) (file.hooks as any)[eventName] = []

            const groups: MatcherGroup[] = (file.hooks as any)[eventName]!
            const trimmedMatcher = matcher.trim() || undefined
            let targetGroup = groups.find((g) => g.matcher === trimmedMatcher)

            if (!targetGroup) {
                targetGroup = {
                    matcher: trimmedMatcher,
                    hooks: [],
                }
                groups.push(targetGroup)
            }

            targetGroup.hooks.push(handler)
            await hookService.save(source, { file })
        }
    }

    useHooksStore.getState().closeEditor()
    await fetchHooks(services, projectPaths)
}

export async function deleteHook(
    services: HostServices,
    hook: HookMetadata,
    projectPaths: string[] = [],
): Promise<void> {
    const hookService = services?.hooks
    if (!hookService) return
    const isUser = hook.source === 'user'

    if (isUser) {
        const userConfig = await hookService.load('')
        const file = userConfig.userConfigFile ?? userConfig.file
        if (file && file.hooks && (file.hooks as any)[hook.eventName]) {
            const groups: MatcherGroup[] = (file.hooks as any)[hook.eventName]!
            for (let i = groups.length - 1; i >= 0; i--) {
                const g = groups[i]
                if (g.matcher === (hook.matcher || undefined)) {
                    g.hooks = g.hooks.filter(
                        (h: HookHandlerConfig) =>
                            !(
                                h.type === hook.handler.type &&
                                (h.type === 'command'
                                    ? h.command === (hook.handler as CommandHookHandlerConfig).command
                                    : false)
                            ),
                    )
                    if (g.hooks.length === 0) {
                        groups.splice(i, 1)
                    }
                }
            }
            await hookService.save('user', { file })
        }
    } else {
        const projPath = hook.sourcePath
            .replace(/\/\.cpa\/hooks\.json$/, '')
            .replace(/\/\.codex\/hooks\.json$/, '')
        const projConfig = await hookService.load(projPath)
        if (
            projConfig &&
            projConfig.file &&
            projConfig.file.hooks &&
            (projConfig.file.hooks as any)[hook.eventName]
        ) {
            const groups: MatcherGroup[] = (projConfig.file.hooks as any)[hook.eventName]!
            for (let i = groups.length - 1; i >= 0; i--) {
                const g = groups[i]
                if (g.matcher === (hook.matcher || undefined)) {
                    g.hooks = g.hooks.filter(
                        (h: HookHandlerConfig) =>
                            !(
                                h.type === hook.handler.type &&
                                (h.type === 'command'
                                    ? h.command === (hook.handler as CommandHookHandlerConfig).command
                                    : false)
                            ),
                    )
                    if (g.hooks.length === 0) {
                        groups.splice(i, 1)
                    }
                }
            }
            await hookService.save(projPath, { file: projConfig.file })
        }
    }

    await fetchHooks(services, projectPaths)
}

export async function toggleHookEnabled(
    services: HostServices,
    hook: HookMetadata,
    projectPaths: string[] = [],
): Promise<void> {
    const hookService = services?.hooks
    if (!hookService) return
    const isUser = hook.source === 'user'

    if (isUser) {
        const userConfig = await hookService.load('')
        const file = userConfig.userConfigFile ?? userConfig.file
        if (file) {
            if (!file.state) file.state = {}
            const current = file.state[hook.key]?.enabled ?? true
            file.state[hook.key] = {
                ...file.state[hook.key],
                enabled: !current,
                trusted_hash: hook.currentHash,
            }
            await hookService.save('user', { file })
        }
    } else {
        const projPath = hook.sourcePath
            .replace(/\/\.cpa\/hooks\.json$/, '')
            .replace(/\/\.codex\/hooks\.json$/, '')
        const projConfig = await hookService.load(projPath)
        if (projConfig && projConfig.file) {
            const file = projConfig.file
            if (!file.state) file.state = {}
            const current = file.state[hook.key]?.enabled ?? true
            file.state[hook.key] = {
                ...file.state[hook.key],
                enabled: !current,
                trusted_hash: hook.currentHash,
            }
            await hookService.save(projPath, { file })
        }
    }

    await fetchHooks(services, projectPaths)
}
