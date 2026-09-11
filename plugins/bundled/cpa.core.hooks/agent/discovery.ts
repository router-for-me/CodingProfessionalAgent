/**
 * Discovery and persistence of Hook configurations.
 * Loads and saves user-level, project-level, and plugin hooks.
 */

import type { NativeBridge } from './types.js'
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
    bridge?: NativeBridge,
    projectPath?: string,
    file?: HooksConfigFile,
): Promise<void> {
    if (!bridge || !projectPath || !file) return
    const path = getProjectHooksPath(projectPath)
    await writeJsonFile(bridge, path, file)
}

export async function convertConfigFileToMetadata(
    file: HooksConfigFile,
    source: HookSource,
    sourcePath: string,
    pluginId: string | null = null,
    baseDisplayOrder = 0,
): Promise<HookMetadata[]> {
    const hooks: HookMetadata[] = []
    const eventsConfig = file.hooks ?? {}
    const stateRecord = file.state ?? {}
    let orderCounter = baseDisplayOrder

    for (const eventName of HOOK_EVENT_NAMES) {
        const groups: MatcherGroup[] = eventsConfig[eventName] ?? []
        for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
            const group = groups[groupIndex]
            const matcher = group.matcher ?? null
            const handlerList = group.hooks ?? []

            for (let handlerIndex = 0; handlerIndex < handlerList.length; handlerIndex++) {
                const handler = handlerList[handlerIndex]
                const key = generateHookKey(source, eventName, groupIndex, handlerIndex)
                const state = stateRecord[key]
                let enabled = state?.enabled ?? true
                const currentHash = await computeHookHash(eventName, matcher, handler)
                const trustedHash = state?.trusted_hash

                let trustStatus: HookMetadata['trustStatus'] = 'trusted'
                if (source === 'system') {
                    trustStatus = 'managed'
                } else if (!trustedHash) {
                    trustStatus = 'untrusted'
                } else if (trustedHash !== currentHash) {
                    trustStatus = 'modified'
                }

                let timeoutSec = 30
                let statusMessage: string | null = null
                let additionalContextLimit: number | null = null

                if (handler.type === 'command') {
                    timeoutSec = handler.timeout ?? 30
                    statusMessage = handler.statusMessage ?? null
                    additionalContextLimit = handler.additionalContextLimit ?? null
                } else if (handler.type === 'mcp_tool') {
                    timeoutSec = handler.timeout ?? 30
                    statusMessage = handler.statusMessage ?? 'MCP tool hooks are unsupported without an MCP executor'
                    enabled = false
                }

                hooks.push({
                    key,
                    eventName,
                    matcher,
                    timeoutSec,
                    statusMessage,
                    additionalContextLimit,
                    sourcePath,
                    source,
                    pluginId,
                    displayOrder: orderCounter++,
                    enabled,
                    isManaged: source === 'system',
                    currentHash,
                    trustStatus,
                    handler,
                })
            }
        }
    }

    return hooks
}

export interface DiscoveredHooks {
    userHooks: HookMetadata[]
    projectHooks: HookMetadata[]
    pluginHooks: HookMetadata[]
    allHooks: HookMetadata[]
}

export async function discoverAllHooks(
    bridge?: NativeBridge,
    projectPath?: string | null,
    pluginConfigs?: Array<{ pluginId: string; manifestPath: string; hooks: HookEventsConfig }>,
): Promise<DiscoveredHooks> {
    if (!bridge) {
        return {
            userHooks: [],
            projectHooks: [],
            pluginHooks: [],
            allHooks: [],
        }
    }
    const userRes = await loadUserHooks(bridge)
    const userHooks = await convertConfigFileToMetadata(userRes.file, 'user', userRes.path, null, 100)

    let projectHooks: HookMetadata[] = []
    if (projectPath) {
        const projRes = await loadProjectHooks(bridge, projectPath)
        if (projRes && projRes.exists) {
            projectHooks = await convertConfigFileToMetadata(
                projRes.file,
                'project',
                projRes.path,
                null,
                200,
            )
        }
    }

    const pluginHooks: HookMetadata[] = []
    if (pluginConfigs && pluginConfigs.length > 0) {
        for (let i = 0; i < pluginConfigs.length; i++) {
            const cfg = pluginConfigs[i]
            const pHooks = await convertConfigFileToMetadata(
                { hooks: cfg.hooks },
                'plugin',
                cfg.manifestPath,
                cfg.pluginId,
                300 + i * 100,
            )
            pluginHooks.push(...pHooks)
        }
    }

    const allHooks = [...userHooks, ...projectHooks, ...pluginHooks].sort(
        (a, b) => a.displayOrder - b.displayOrder,
    )

    return {
        userHooks,
        projectHooks,
        pluginHooks,
        allHooks,
    }
}
