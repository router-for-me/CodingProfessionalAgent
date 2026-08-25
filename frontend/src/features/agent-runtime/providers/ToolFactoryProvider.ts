/**
 * ToolFactoryProvider: unified tool factory provider and metadata-driven approval policies.
 * Creates coding tools, subagent tools, session tools, and dynamic plugin tools.
 */

import type {
    AgentTarget,
    AgentTool,
    HostServices,
    ToolFactoryContext,
    ToolFactoryContribution,
    ToolRiskLevel,
} from '@cpa/plugin-api'
import { adaptPluginToolToAgentTool } from '@cpa/plugin-sdk'
import type { ModelCatalogEntry } from '@/features/models/types'
import {
    rendererRegistry,
    type RendererRegistry,
} from '@/plugins/platform/rendererRegistry'
import {
    agentRegistry,
} from '@/plugins/platform/AgentPluginRuntimeHost'
import type { WorktreeRunPolicy } from '../context/worktreeMode'
import type { NativeBridge } from '../native/types'
import { isAbsolutePath } from '@cpa/plugin-sdk'

export interface ToolApprovalPolicy {
    riskLevel: ToolRiskLevel
    requiresApproval: boolean
    approvalCategory?: string
}

export interface ToolFactoryProviderContext {
    cwd?: string
    platform?: 'darwin' | 'linux' | 'win32' | string
    services?: HostServices
    bridge?: NativeBridge
    model?: ModelCatalogEntry
    imageProcessor?: any
    worktreePolicy?: WorktreeRunPolicy
    extensionRegistry?: RendererRegistry
    targetAgent?: AgentTarget
    scheduleId?: string | null
    sessionId?: string | null
    subAgents?: unknown
    models?: readonly ModelCatalogEntry[]
    onRename?: ((sessionId: string, title: string) => void) | ((newTitle: string) => void)
    [key: string]: unknown
}

export interface CreateToolsFromProvidersOptions {
    imageProcessor?: any
    extensionRegistry?: RendererRegistry
    targetAgent?: AgentTarget
    scheduleId?: string | null
    sessionId?: string | null
    worktreePolicy?: WorktreeRunPolicy
    subAgents?: unknown
    models?: readonly ModelCatalogEntry[]
    onRename?: ((sessionId: string, title: string) => void) | ((newTitle: string) => void)
}

export type CreateCodingToolsOptions = CreateToolsFromProvidersOptions

/**
 * Standard tool approval policies indexed by tool name and aliases.
 */
const KNOWN_APPROVAL_POLICIES: ReadonlyMap<string, ToolApprovalPolicy> = new Map([
    // Coding tools
    ['read', { riskLevel: 'read', requiresApproval: false, approvalCategory: 'filesystem-read' }],
    ['bash', { riskLevel: 'process', requiresApproval: true, approvalCategory: 'shell-execution' }],
    ['pwsh', { riskLevel: 'process', requiresApproval: true, approvalCategory: 'shell-execution' }],
    ['powershell', { riskLevel: 'process', requiresApproval: true, approvalCategory: 'shell-execution' }],
    ['edit', { riskLevel: 'write', requiresApproval: true, approvalCategory: 'filesystem-write' }],
    ['write', { riskLevel: 'write', requiresApproval: true, approvalCategory: 'filesystem-write' }],

    // Session & metadata tools
    ['title', { riskLevel: 'session', requiresApproval: false, approvalCategory: 'session-metadata' }],
    ['set_session_title', { riskLevel: 'session', requiresApproval: false, approvalCategory: 'session-metadata' }],
    ['session_search', { riskLevel: 'session', requiresApproval: false, approvalCategory: 'session-query' }],
    ['session_create', { riskLevel: 'session', requiresApproval: false, approvalCategory: 'session-lifecycle' }],

    // Subagent tools
    ['spawn_agent', { riskLevel: 'process', requiresApproval: false, approvalCategory: 'subagent-lifecycle' }],
    ['send_message', { riskLevel: 'process', requiresApproval: false, approvalCategory: 'subagent-communication' }],
    ['send_input', { riskLevel: 'process', requiresApproval: false, approvalCategory: 'subagent-communication' }],
    ['stop_agent', { riskLevel: 'process', requiresApproval: false, approvalCategory: 'subagent-lifecycle' }],

    // Interactive & management tools
    ['ask', { riskLevel: 'read', requiresApproval: false, approvalCategory: 'user-interaction' }],
    ['todo', { riskLevel: 'session', requiresApproval: false, approvalCategory: 'task-management' }],
    ['manage_todo_list', { riskLevel: 'session', requiresApproval: false, approvalCategory: 'task-management' }],

    // Memory tools
    ['memories_list', { riskLevel: 'read', requiresApproval: false, approvalCategory: 'memory-read' }],
    ['memories_read', { riskLevel: 'read', requiresApproval: false, approvalCategory: 'memory-read' }],
    ['memories_search', { riskLevel: 'read', requiresApproval: false, approvalCategory: 'memory-read' }],
    ['memory_search', { riskLevel: 'read', requiresApproval: false, approvalCategory: 'memory-read' }],
    ['memories_add_ad_hoc_note', { riskLevel: 'write', requiresApproval: false, approvalCategory: 'memory-write' }],
    ['memory_store', { riskLevel: 'write', requiresApproval: false, approvalCategory: 'memory-write' }],
])

/**
 * Standard alias mappings (alias -> canonical name or bidirectional pairs).
 */
const KNOWN_TOOL_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
    ['pwsh', ['powershell', 'bash']],
    ['powershell', ['pwsh', 'bash']],
    ['bash', ['pwsh', 'powershell']],
    ['send_message', ['send_input']],
    ['send_input', ['send_message']],
    ['memories_search', ['memory_search']],
    ['memory_search', ['memories_search']],
    ['memories_add_ad_hoc_note', ['memory_store']],
    ['memory_store', ['memories_add_ad_hoc_note']],
])

/**
 * Dynamic registry of approval policies for dynamically contributed tools.
 */
const dynamicApprovalPolicies = new Map<string, ToolApprovalPolicy>()
const aliasGroups = new Set<Set<string>>()

/**
 * Register metadata from a ToolFactoryContribution into the policy cache.
 */
export function registerToolFactoryMetadata(contribution: ToolFactoryContribution): void {
    const policy: ToolApprovalPolicy = {
        riskLevel: contribution.riskLevel ?? 'read',
        requiresApproval: Boolean(contribution.requiresApproval),
        approvalCategory: contribution.approvalCategory,
    }
    dynamicApprovalPolicies.set(contribution.id, policy)

    const group = new Set<string>([contribution.id])
    if (contribution.aliases) {
        for (const alias of contribution.aliases) {
            group.add(alias)
            dynamicApprovalPolicies.set(alias, policy)
        }
    }
    aliasGroups.add(group)
}

/**
 * Select the approval policy for a tool name or AgentTool instance.
 */
export function selectApprovalPolicy(
    toolOrName: AgentTool | string,
    customPolicies?: Map<string, ToolApprovalPolicy>
): ToolApprovalPolicy {
    const name = typeof toolOrName === 'string' ? toolOrName : toolOrName.name

    if (customPolicies?.has(name)) {
        return customPolicies.get(name)!
    }
    if (dynamicApprovalPolicies.has(name)) {
        return dynamicApprovalPolicies.get(name)!
    }
    if (KNOWN_APPROVAL_POLICIES.has(name)) {
        return KNOWN_APPROVAL_POLICIES.get(name)!
    }

    // Check alias groups
    for (const group of aliasGroups) {
        if (group.has(name)) {
            for (const item of group) {
                if (customPolicies?.has(item)) return customPolicies.get(item)!
                if (dynamicApprovalPolicies.has(item)) return dynamicApprovalPolicies.get(item)!
                if (KNOWN_APPROVAL_POLICIES.has(item)) return KNOWN_APPROVAL_POLICIES.get(item)!
            }
        }
    }

    // Check static aliases
    const staticAliases = KNOWN_TOOL_ALIASES.get(name)
    if (staticAliases) {
        for (const alias of staticAliases) {
            if (customPolicies?.has(alias)) return customPolicies.get(alias)!
            if (dynamicApprovalPolicies.has(alias)) return dynamicApprovalPolicies.get(alias)!
            if (KNOWN_APPROVAL_POLICIES.has(alias)) return KNOWN_APPROVAL_POLICIES.get(alias)!
        }
    }

    // Check if tool instance has metadata attached
    if (typeof toolOrName === 'object' && toolOrName !== null) {
        const anyTool = toolOrName as unknown as Record<string, unknown>
        if (typeof anyTool.requiresApproval === 'boolean') {
            return {
                riskLevel: (anyTool.riskLevel as ToolRiskLevel) ?? 'read',
                requiresApproval: Boolean(anyTool.requiresApproval),
                approvalCategory: anyTool.approvalCategory as string | undefined,
            }
        }
    }

    // Default safe fallback
    return {
        riskLevel: 'read',
        requiresApproval: false,
    }
}

/**
 * Check if a tool requires approval based on its metadata.
 */
export function isMutatingToolName(name: string): boolean {
    return selectApprovalPolicy(name).requiresApproval
}

/**
 * Find a tool in a tool list by its name or alias.
 */
export function findToolByNameOrAlias(
    tools: readonly AgentTool[],
    name: string
): AgentTool | undefined {
    // 1. Exact name match
    const exact = tools.find((t) => t.name === name)
    if (exact) return exact

    // 2. Static alias match
    const staticAliases = KNOWN_TOOL_ALIASES.get(name)
    if (staticAliases) {
        for (const alias of staticAliases) {
            const matched = tools.find((t) => t.name === alias)
            if (matched) return matched
        }
    }

    // 3. Dynamic alias group match
    for (const group of aliasGroups) {
        if (group.has(name)) {
            for (const item of group) {
                const matched = tools.find((t) => t.name === item)
                if (matched) return matched
            }
        }
    }

    return undefined
}

export { adaptPluginToolToAgentTool }

/**
 * Helper to determine whether the tool provider context belongs to a session
 * created by a scheduled task.
 */
export function isScheduledSessionContext(context: ToolFactoryProviderContext): boolean {
    if (typeof context.scheduleId === 'string' && context.scheduleId.trim().length > 0) {
        return true
    }
    if (typeof context.sessionId === 'string' && context.sessionId.trim().length > 0) {
        const sid = context.sessionId.trim()
        const services = context.services
        if (services?.sessions?.getSnapshot) {
            const session = services.sessions.getSnapshot().find((s) => s.id === sid)
            if (typeof session?.scheduleId === 'string' && session.scheduleId.trim().length > 0) {
                return true
            }
        }
    }
    return false
}

/**
 * Creates tools from registered ToolFactoryContributions and legacy dynamic tools.
 * If cwd is missing or not a valid directory, returns [].
 */
export async function createToolsFromProviders(
    context: ToolFactoryProviderContext
): Promise<AgentTool[]> {
    const cwd = context.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) {
        return []
    }
    if (!isAbsolutePath(cwd)) {
        return []
    }

    const bridge = context.bridge
    if (bridge) {
        try {
            const stat = await bridge.stat(cwd)
            if (!stat.isDir) {
                return []
            }
        } catch {
            return []
        }
    }

    let platform = context.platform
    if (!platform && bridge) {
        const runtime = await bridge.runtimeInfo().catch(() => ({
            platform: 'darwin' as const,
            userConfigDir: '',
            tempDir: '',
            homeDir: '',
        }))
        platform = (runtime.platform as 'darwin' | 'linux' | 'win32') || 'darwin'
    } else if (!platform) {
        platform = 'darwin'
    }

    const targetAgent: AgentTarget = context.targetAgent ?? 'all'
    const registry = context.extensionRegistry ?? agentRegistry

    // Gather all tool factory contributions from registry (fallback to rendererRegistry if empty)
    const registeredFactories = registry ? registry.getToolFactories(targetAgent) : []
    const fallbackFactories =
        registry !== rendererRegistry && registeredFactories.length === 0
            ? rendererRegistry.getToolFactories(targetAgent)
            : []
    const allFactories: ToolFactoryContribution[] = [
        ...registeredFactories,
        ...fallbackFactories,
    ]

    allFactories.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))

    const normalizedPlatform: 'darwin' | 'linux' | 'win32' =
        platform === 'win32' || platform === 'windows'
            ? 'win32'
            : platform === 'linux'
              ? 'linux'
              : 'darwin'

    const tools: AgentTool[] = []
    const effectiveContext: ToolFactoryProviderContext & ToolFactoryContext = {
        ...context,
        platform: normalizedPlatform,
        services: (context.services ?? {}) as HostServices,
    }

    const isScheduled = isScheduledSessionContext(context)

    for (const factory of allFactories) {
        const requiresScheduled =
            factory.requiresScheduledSession ??
            factory.descriptor?.requiresScheduledSession
        if (requiresScheduled && !isScheduled) {
            continue
        }

        registerToolFactoryMetadata(factory)
        try {
            const tool = await factory.create(effectiveContext)
            if (tool) {
                if (tool.requiresScheduledSession && !isScheduled) {
                    continue
                }
                tools.push(tool)
            }
        } catch (err) {
            console.error(`[ToolFactoryProvider] Failed to create tool "${factory.id}":`, err)
        }
    }

    // Handle legacy AgentToolContributions that didn't use ToolFactoryContribution
    if (registry) {
        const legacyTools = registry.getAgentTools(targetAgent)
        const builtInNames = new Set([
            'read',
            'bash',
            'pwsh',
            'powershell',
            'edit',
            'write',
            'shell',
            ...tools.map((t) => t.name),
        ])

        const adaptedLegacyTools = legacyTools
            .filter((lt) => !builtInNames.has(lt.name))
            .filter((lt) => {
                if (lt.requiresScheduledSession && !isScheduled) {
                    return false
                }
                return true
            })
            .map(adaptPluginToolToAgentTool)

        tools.push(...adaptedLegacyTools)
    }

    return tools
}

/**
 * ToolFactoryProvider facade class for OOP usage.
 */
export class ToolFactoryProvider {
    static createTools = createToolsFromProviders
    static selectApprovalPolicy = selectApprovalPolicy
    static findToolByNameOrAlias = findToolByNameOrAlias
    static isMutatingToolName = isMutatingToolName
}
