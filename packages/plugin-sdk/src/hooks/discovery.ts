/**
 * Discovery and persistence of Hook configurations.
 * Loads and saves user-level, project-level, and plugin hooks.
 */

import type { NativeBridge } from '../agentAdapter.js'
import { getAppConfigDirName } from '@cpa/plugin-api'
import { computeHookHash } from './hash.js'
import type {
    HookEventName,
    HookEventsConfig,
    HookMetadata,
    HookSource,
    HooksConfigFile,
    MatcherGroup,
} from './types.js'
import { HOOK_EVENT_NAMES } from './types.js'

export const USER_HOOKS_FILENAME = 'hooks.json'
export const PROJECT_HOOKS_RELATIVE_PATH = '.cpa/hooks.json'
export const LEGACY_PROJECT_HOOKS_RELATIVE_PATH = '.codex/hooks.json'
export const ROOT_PROJECT_HOOKS_RELATIVE_PATH = 'hooks.json'

export function generateHookKey(
    source: string,
    eventName: HookEventName,
    groupIndex: number,
    handlerIndex: number,
): string {
    const eventKey = eventName.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '')
    return `${source}:${eventKey}:${groupIndex}:${handlerIndex}`
}

function normalizePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/\/+/g, '/')
}

export async function getUserHooksPath(bridge?: NativeBridge): Promise<string> {
    if (!bridge || typeof bridge.runtimeInfo !== 'function') {
        return normalizePath(`/${getAppConfigDirName()}/${USER_HOOKS_FILENAME}`)
    }
    const runtime = await bridge.runtimeInfo().catch(() => ({ platform: 'darwin', homeDir: '' }))
    const base = (runtime as any)?.homeDir || ''
    const configDirName = (runtime as any)?.appConfigDirName || getAppConfigDirName((runtime as any)?.isDebug)
    return normalizePath(`${base}/${configDirName}/${USER_HOOKS_FILENAME}`)
}

export function getProjectHooksPath(projectPath: string): string {
    return normalizePath(`${projectPath}/${PROJECT_HOOKS_RELATIVE_PATH}`)
}

export async function readJsonFile<T>(bridge?: NativeBridge, filePath?: string): Promise<T | null> {
    if (!bridge || !filePath || typeof bridge.readFile !== 'function') {
        return null
    }
    try {
        const bytes = await bridge.readFile(filePath)
        const text = new TextDecoder().decode(bytes)
        return JSON.parse(text) as T
    } catch {
        return null
    }
}

export async function writeJsonFile(
    bridge?: NativeBridge,
    filePath?: string,
    data?: unknown,
): Promise<void> {
    if (!bridge || !filePath) return
    const normalized = normalizePath(filePath)
    const lastSlash = normalized.lastIndexOf('/')
    if (lastSlash > 0) {
        const parentDir = normalized.slice(0, lastSlash)
        if (bridge.mkdirAll) {
            await bridge.mkdirAll(parentDir)
        }
    }
    const text = JSON.stringify(data, null, 2)
    const bytes = new TextEncoder().encode(text)
    if (bridge.writeFile) {
        await bridge.writeFile(filePath, bytes)
    }
}

export async function loadUserHooks(bridge?: NativeBridge): Promise<{ file: HooksConfigFile; path: string }> {
    if (!bridge) {
        return { file: { description: 'User-level lifecycle hooks', hooks: {}, state: {} }, path: '' }
    }
    const path = await getUserHooksPath(bridge)
    const file = (await readJsonFile<HooksConfigFile>(bridge, path)) ?? {
        description: 'User-level lifecycle hooks',
        hooks: {},
        state: {},
    }
    return { file, path }
}

export async function saveUserHooks(bridge?: NativeBridge, file?: HooksConfigFile): Promise<void> {
    if (!bridge || !file) return
    const path = await getUserHooksPath(bridge)
    await writeJsonFile(bridge, path, file)
}

export async function loadProjectHooks(
    bridge?: NativeBridge,
    projectPath?: string | null,
): Promise<{ file: HooksConfigFile; path: string; exists: boolean } | null> {
    if (!bridge || !projectPath || !projectPath.trim()) {
        return null
    }

    // 1. Check .cpa/hooks.json
    const cpaPath = getProjectHooksPath(projectPath)
    const cpaFile = await readJsonFile<HooksConfigFile>(bridge, cpaPath)
    if (cpaFile) {
        return { file: cpaFile, path: cpaPath, exists: true }
    }

    // 2. Check legacy .codex/hooks.json
    const legacyPath = normalizePath(`${projectPath}/${LEGACY_PROJECT_HOOKS_RELATIVE_PATH}`)
    const legacyFile = await readJsonFile<HooksConfigFile>(bridge, legacyPath)
    if (legacyFile) {
        return { file: legacyFile, path: legacyPath, exists: true }
    }

    // 3. Check root hooks.json in project root directory
    const rootPath = normalizePath(`${projectPath}/${ROOT_PROJECT_HOOKS_RELATIVE_PATH}`)
    const rootFile = await readJsonFile<HooksConfigFile>(bridge, rootPath)
    if (rootFile) {
        return { file: rootFile, path: rootPath, exists: true }
    }

    return {
        file: {
            description: 'Project lifecycle hooks',
            hooks: {},
            state: {},
        },
        path: cpaPath,
        exists: false,
    }
}

export async function saveProjectHooks(
    bridge: NativeBridge,
    projectPath: string,
    file: HooksConfigFile,
): Promise<void> {
    const path = getProjectHooksPath(projectPath)
    await writeJsonFile(bridge, path, file)
}

export async function convertConfigFileToMetadata(
    file: HooksConfigFile,
    source: HookSource,
    sourcePath: string,
    pluginId: string | null = null,
): Promise<HookMetadata[]> {
    const result: HookMetadata[] = []
    const hooksConfig = file.hooks ?? {}
    const stateMap = file.state ?? {}

    let displayOrder = 0

    for (const eventName of HOOK_EVENT_NAMES) {
        const groups: MatcherGroup[] | undefined = hooksConfig[eventName]
        if (!groups || !Array.isArray(groups)) continue

        for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
            const group = groups[groupIndex]
            const matcher = group.matcher ?? null
            const handlers = group.hooks ?? []

            for (let handlerIndex = 0; handlerIndex < handlers.length; handlerIndex++) {
                const handler = handlers[handlerIndex]
                const key = generateHookKey(source, eventName, groupIndex, handlerIndex)
                const currentHash = await computeHookHash(eventName, matcher, handler)

                const isManaged = source === 'user' || source === 'plugin'
                let isEnabled = true
                let trustStatus: HookMetadata['trustStatus'] = isManaged ? 'managed' : 'untrusted'

                const state = stateMap[key]
                if (state) {
                    if (typeof state.enabled === 'boolean') {
                        isEnabled = state.enabled
                    }
                    if (!isManaged) {
                        if (state.trusted_hash) {
                            if (state.trusted_hash === currentHash) {
                                trustStatus = 'trusted'
                            } else {
                                trustStatus = 'modified'
                                isEnabled = false
                            }
                        }
                    }
                }

                if (!isManaged && trustStatus === 'untrusted') {
                    isEnabled = false
                }

                let statusMessage: string | null = null
                if (handler.type !== 'command') {
                    statusMessage = `Handler type "${handler.type}" is not supported yet`
                    isEnabled = false
                }

                result.push({
                    key,
                    eventName,
                    matcher,
                    timeoutSec: (handler as any).timeout ?? 30,
                    statusMessage: statusMessage ?? (handler as any).statusMessage ?? null,
                    additionalContextLimit: (handler as any).additionalContextLimit ?? null,
                    sourcePath,
                    source,
                    pluginId,
                    displayOrder: displayOrder++,
                    enabled: isEnabled,
                    isManaged,
                    currentHash,
                    trustStatus,
                    handler,
                })
            }
        }
    }

    return result
}

export async function discoverAllHooks(
    bridge?: NativeBridge,
    projectPath: string | null = null,
    pluginConfigs: Array<{ pluginId: string; manifestPath: string; hooks: HookEventsConfig }> = [],
): Promise<{
    userHooks: HookMetadata[]
    projectHooks: HookMetadata[]
    pluginHooks: HookMetadata[]
}> {
    if (!bridge) {
        return {
            userHooks: [],
            projectHooks: [],
            pluginHooks: [],
        }
    }
    const userRes = await loadUserHooks(bridge)
    const userHooks = await convertConfigFileToMetadata(userRes.file, 'user', userRes.path)

    let projectHooks: HookMetadata[] = []
    if (projectPath) {
        const projRes = await loadProjectHooks(bridge, projectPath)
        if (projRes && projRes.exists) {
            projectHooks = await convertConfigFileToMetadata(projRes.file, 'project', projRes.path)
        }
    }

    const pluginHooks: HookMetadata[] = []
    for (const plugin of pluginConfigs) {
        const fakeFile: HooksConfigFile = { hooks: plugin.hooks }
        const converted = await convertConfigFileToMetadata(
            fakeFile,
            'plugin',
            plugin.manifestPath,
            plugin.pluginId,
        )
        pluginHooks.push(...converted)
    }

    return {
        userHooks,
        projectHooks,
        pluginHooks,
    }
}
