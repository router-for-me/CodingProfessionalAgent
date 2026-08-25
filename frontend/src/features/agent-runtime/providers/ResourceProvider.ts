/**
 * ResourceProvider: unified agent resource loading and orchestration.
 * Manages context files, skills, prompt templates, memories, and system prompts
 * contributed by core providers and dynamic plugin providers.
 */

import type {
    AgentTarget,
    ResourceKind,
    ResourceProvider,
    ResourceProviderInput,
} from '@cpa/plugin-api'
import type { PersonalityTone } from '@/types/models'
import {
    rendererRegistry,
    type RendererRegistry,
} from '@/plugins/platform/rendererRegistry'
import {
    agentRegistry,
} from '@/plugins/platform/AgentPluginRuntimeHost'
import {
    type ContextDiagnostic,
    type ContextFile,
    type PromptDiagnostic,
    type PromptSource,
    type PromptTemplate,
    type Skill,
    type SkillDiagnostic,
    expandPromptTemplate,
    expandSkillCommand,
    formatSkillsForPrompt,
    isAbsolutePath,
} from '@cpa/plugin-sdk'
import {
    buildSystemPrompt,
    type SystemPromptTool,
} from '../context/systemPrompt'
import {
    formatWorktreeModePrompt,
    type WorktreeRunPolicy,
} from '../context/worktreeMode'
import type { NativeBridge } from '../native/types'

export type {
    ResourceKind,
    ResourceProvider,
    ResourceProviderInput,
}

export interface ResourceDiagnostic {
    type: 'warning' | 'collision'
    message: string
    path?: string
    resourceType?: 'context' | 'skill' | 'prompt' | 'system'
    source?: string
    collision?: {
        resourceType: 'skill' | 'prompt'
        name: string
        winnerPath: string
        loserPath: string
    }
}

export interface ResourcePromptPart {
    id: string
    content: string
    order?: number
}

export interface ResourceSnapshot {
    readonly contextFiles: readonly ContextFile[]
    readonly system?: PromptSource
    readonly appendSystem?: PromptSource
    readonly skills: readonly Skill[]
    readonly prompts: readonly PromptTemplate[]
    readonly systemPrompt: string
    readonly systemPromptParts?: readonly ResourcePromptPart[]
    readonly diagnostics: readonly ResourceDiagnostic[]
}

export interface LoadResourceSnapshotInput {
    /** Primary project cwd; invalid/undefined loads global-only resources. */
    cwd?: string
    /** All validated project source folders exposed to the agent. */
    projectPaths?: readonly string[]
    agentDir: string
    homeDir?: string
    bridge: NativeBridge
    /** Actual tools available for this run (closed-world). */
    tools?: readonly SystemPromptTool[]
    promptGuidelines?: readonly string[]
    /** User's UI language / locale (e.g. 'zh-CN', 'en'). */
    language?: string
    /** User's selected personality tone constraint. */
    personality?: PersonalityTone | string
    /** Enable local memory context injection and tools. Defaults to true. */
    localMemoryEnabled?: boolean
    /** Optional extension registry for dynamic plugin prompts (defaults to agentRegistry). */
    extensionRegistry?: RendererRegistry
    /** Optional Git worktree runtime policy constraints. */
    worktreePolicy?: WorktreeRunPolicy
    /** Target agent scope ('main' or 'subagent', defaults to 'main'). */
    agentTarget?: AgentTarget
    /** Optional session ID. */
    sessionId?: string
}

export interface ContextProviderItem {
    files?: readonly ContextFile[]
    system?: PromptSource
    appendSystem?: PromptSource
    diagnostics?: readonly ContextDiagnostic[]
    path?: string
    content?: string
}

export interface SystemPromptProviderItem {
    id?: string
    guideline?: string
    content?: string
    order?: number
}

/**
 * Load agent resources from registered providers in deterministic order.
 */
export async function loadResourcesFromProviders(
    input: LoadResourceSnapshotInput,
): Promise<ResourceSnapshot> {
    const diagnostics: ResourceDiagnostic[] = []
    const tools = input.tools ?? []
    const hasReadTool = tools.some((tool) => tool.name === 'read')
    const agentTarget: AgentTarget = input.agentTarget ?? 'main'

    const agentCheck = validateAbsoluteResourcePath(input.agentDir, 'agentDir')
    if (agentCheck) {
        diagnostics.push({
            type: 'warning',
            message: agentCheck,
            path: input.agentDir,
            resourceType: 'system',
            source: 'cpa.core.resources',
        })
        return freezeSnapshot({
            contextFiles: [],
            skills: [],
            prompts: [],
            systemPrompt: buildSystemPrompt({
                tools,
                promptGuidelines: input.promptGuidelines,
                language: input.language,
                personality: input.personality,
            }),
            systemPromptParts: [
                {
                    id: 'base',
                    content: buildSystemPrompt({
                        tools,
                        promptGuidelines: input.promptGuidelines,
                        language: input.language,
                        personality: input.personality,
                    }),
                },
            ],
            diagnostics,
        })
    }

    const cwdValid = isValidAbsolutePath(input.cwd)
    const effectiveCwd = cwdValid ? input.cwd! : undefined
    if (input.cwd !== undefined && input.cwd !== null && input.cwd !== '' && !cwdValid) {
        diagnostics.push({
            type: 'warning',
            message: `cwd is invalid; loading global resources only: ${input.cwd}`,
            path: String(input.cwd),
            resourceType: 'system',
            source: 'cpa.core.resources',
        })
    }

    const effectiveProjectPaths = collectProjectPaths(
        effectiveCwd,
        input.projectPaths,
    )

    const registry = input.extensionRegistry ?? agentRegistry
    const registeredProviders = registry
        ? registry.getResourceProviders<any>(undefined, agentTarget)
        : []
    const fallbackProviders =
        registry !== rendererRegistry && registeredProviders.length === 0
            ? rendererRegistry.getResourceProviders<any>(undefined, agentTarget)
            : []

    const allProviders: ResourceProvider<any>[] = [
        ...registeredProviders,
        ...fallbackProviders,
    ]

    allProviders.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))

    const providerInput: ResourceProviderInput = {
        cwd: effectiveCwd,
        projectPath: effectiveCwd,
        projectPaths: effectiveProjectPaths,
        sessionId: input.sessionId,
        agentTarget,
        agentDir: input.agentDir,
        homeDir: input.homeDir,
        bridge: input.bridge,
        tools,
        promptGuidelines: input.promptGuidelines,
        language: input.language,
        personality: input.personality,
        localMemoryEnabled: input.localMemoryEnabled !== false,
        worktreePolicy: input.worktreePolicy,
        extensionRegistry: registry,
    }

    let contextFiles: ContextFile[] = []
    let system: PromptSource | undefined
    let appendSystem: PromptSource | undefined

    const skillMap = new Map<string, Skill>()
    const promptMap = new Map<string, PromptTemplate>()
    const providerSystemPromptParts: ResourcePromptPart[] = []
    const providerGuidelines: string[] = []

    for (const provider of allProviders) {
        try {
            const items = await provider.load(providerInput)
            if (!Array.isArray(items)) continue

            for (const item of items) {
                if (!item) continue

                if (provider.kind === 'context') {
                    // Context provider contribution
                    if ('files' in item && Array.isArray(item.files)) {
                        for (const file of item.files) {
                            if (file && typeof file.path === 'string') {
                                contextFiles.push(cloneContextFile(file))
                            }
                        }
                        if (item.system && !system) {
                            system = clonePromptSource(item.system)
                        }
                        if (item.appendSystem && !appendSystem) {
                            appendSystem = clonePromptSource(item.appendSystem)
                        }
                        if (Array.isArray(item.diagnostics)) {
                            for (const diag of item.diagnostics) {
                                diagnostics.push(mapContextDiagnostic(diag, provider.id))
                            }
                        }
                    } else if ('path' in item && 'content' in item) {
                        contextFiles.push(cloneContextFile(item as ContextFile))
                    }
                } else if (provider.kind === 'skill') {
                    // Skill provider contribution
                    if ('skills' in item && Array.isArray(item.skills)) {
                        for (const skill of item.skills) {
                            addSkillWithCollisionCheck(skill, skillMap, diagnostics, provider.id)
                        }
                        if (Array.isArray(item.diagnostics)) {
                            for (const diag of item.diagnostics) {
                                diagnostics.push(mapSkillDiagnostic(diag, provider.id))
                            }
                        }
                    } else if ('name' in item && 'body' in item) {
                        addSkillWithCollisionCheck(item as Skill, skillMap, diagnostics, provider.id)
                    }
                } else if (provider.kind === 'prompt-template') {
                    // Prompt template provider contribution
                    if ('prompts' in item && Array.isArray(item.prompts)) {
                        for (const prompt of item.prompts) {
                            addPromptWithCollisionCheck(prompt, promptMap, diagnostics, provider.id)
                        }
                        if (Array.isArray(item.diagnostics)) {
                            for (const diag of item.diagnostics) {
                                diagnostics.push(mapPromptDiagnostic(diag, provider.id))
                            }
                        }
                    } else if ('name' in item && 'content' in item) {
                        addPromptWithCollisionCheck(item as PromptTemplate, promptMap, diagnostics, provider.id)
                    }
                } else if (provider.kind === 'system-prompt') {
                    // System prompt provider contribution
                    const pItem = item as SystemPromptProviderItem
                    if (typeof pItem.guideline === 'string' && pItem.guideline.trim().length > 0) {
                        providerGuidelines.push(pItem.guideline.trim())
                    }
                    if (typeof pItem.content === 'string' && pItem.content.trim().length > 0) {
                        const partId = pItem.id ?? provider.id
                        if (!providerSystemPromptParts.some((p) => p.id === partId)) {
                            providerSystemPromptParts.push({
                                id: partId,
                                content: pItem.content.trim(),
                                order: pItem.order ?? provider.order ?? 100,
                            })
                        }
                    }
                }
            }
        } catch (err) {
            diagnostics.push({
                type: 'warning',
                message: `Resource provider "${provider.id}" failed: ${err instanceof Error ? err.message : String(err)}`,
                resourceType: provider.kind === 'context' ? 'context' : provider.kind === 'skill' ? 'skill' : provider.kind === 'prompt-template' ? 'prompt' : 'system',
                source: provider.id,
            })
        }
    }

    // Also collect legacy / directly registered system prompts from ExtensionRegistry
    if (registry) {
        const legacyPrompts = registry.getSystemPrompts(agentTarget)
        for (const lp of legacyPrompts) {
            if (lp.guideline && lp.guideline.trim().length > 0) {
                providerGuidelines.push(lp.guideline.trim())
            }
            if (lp.content && lp.content.trim().length > 0) {
                // Avoid duplicating if already contributed by a provider with the same id
                if (!providerSystemPromptParts.some((p) => p.id === lp.id)) {
                    providerSystemPromptParts.push({
                        id: lp.id,
                        content: lp.content.trim(),
                        order: lp.order ?? 100,
                    })
                }
            }
        }
    }

    const skills = Array.from(skillMap.values()).map(cloneSkill)
    const prompts = Array.from(promptMap.values()).map(clonePrompt)

    const effectivePromptGuidelines = [
        ...(input.promptGuidelines ?? []),
        ...providerGuidelines,
    ]

    providerSystemPromptParts.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))

    const appendContents: string[] = []
    if (appendSystem?.content) {
        appendContents.push(appendSystem.content)
    }
    for (const part of providerSystemPromptParts) {
        appendContents.push(part.content)
    }

    const combinedAppendSystemPrompt = appendContents.filter(Boolean).join('\n\n')

    // Assemble base system prompt
    const basePrompt = buildSystemPrompt({
        customPrompt: system?.content,
        appendSystemPrompt: combinedAppendSystemPrompt || undefined,
        contextFiles,
        tools,
        promptGuidelines: effectivePromptGuidelines,
        language: input.language,
        personality: input.personality,
    })

    const skillsSection = formatSkillsForPrompt(skills, hasReadTool)
    let systemPrompt = basePrompt + skillsSection
    if (effectiveCwd) {
        systemPrompt += `\nCurrent working directory: ${normalizePromptPath(effectiveCwd)}`
    }
    if (effectiveProjectPaths.length > 0) {
        systemPrompt += '\nAllowed project paths:'
        for (const path of effectiveProjectPaths) {
            systemPrompt += `\n- ${normalizePromptPath(path)}`
        }
    }
    if (input.worktreePolicy) {
        systemPrompt += `\n${formatWorktreeModePrompt(input.worktreePolicy)}`
    }

    // Build structured systemPromptParts array for inspection and rendering stability
    const seenPartIds = new Set<string>()
    const systemPromptParts: ResourcePromptPart[] = []

    function addSystemPromptPart(part: ResourcePromptPart): void {
        if (seenPartIds.has(part.id)) {
            return
        }
        seenPartIds.add(part.id)
        systemPromptParts.push(part)
    }

    addSystemPromptPart({
        id: 'base',
        content: system?.content ?? 'Coding Professional Agent',
    })
    if (appendSystem?.content) {
        addSystemPromptPart({
            id: 'append-system',
            content: appendSystem.content,
        })
    }
    for (const part of providerSystemPromptParts) {
        addSystemPromptPart(part)
    }
    if (contextFiles.length > 0) {
        addSystemPromptPart({
            id: 'project-context',
            content: contextFiles.map((f) => `<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`).join('\n\n'),
        })
    }
    if (skillsSection.length > 0) {
        addSystemPromptPart({
            id: 'skills',
            content: skillsSection,
        })
    }
    if (effectiveCwd) {
        addSystemPromptPart({
            id: 'cwd',
            content: `Current working directory: ${normalizePromptPath(effectiveCwd)}`,
        })
    }
    if (effectiveProjectPaths.length > 0) {
        addSystemPromptPart({
            id: 'project-paths',
            content: `Allowed project paths:\n${effectiveProjectPaths.map((p) => `- ${normalizePromptPath(p)}`).join('\n')}`,
        })
    }
    if (input.worktreePolicy) {
        addSystemPromptPart({
            id: 'worktree-mode',
            content: formatWorktreeModePrompt(input.worktreePolicy),
        })
    }

    // Deterministic diagnostics sorting
    diagnostics.sort(compareDiagnostics)

    return freezeSnapshot({
        contextFiles,
        ...(system ? { system } : {}),
        ...(appendSystem ? { appendSystem } : {}),
        skills,
        prompts,
        systemPrompt,
        systemPromptParts,
        diagnostics,
    })
}

/**
 * Expand a user command against a frozen snapshot (skills then templates).
 * Does not re-read disk.
 */
export function expandSnapshotCommand(text: string, snapshot: ResourceSnapshot): string {
    const afterSkill = expandSkillCommand(text, snapshot.skills)
    if (afterSkill !== text) {
        return afterSkill
    }
    return expandPromptTemplate(text, snapshot.prompts)
}

function addSkillWithCollisionCheck(
    skill: Skill,
    skillMap: Map<string, Skill>,
    diagnostics: ResourceDiagnostic[],
    source: string,
): void {
    const existing = skillMap.get(skill.name)
    if (existing) {
        diagnostics.push({
            type: 'collision',
            message: `skill name "${skill.name}" collision: first winner kept`,
            path: skill.filePath,
            resourceType: 'skill',
            source,
            collision: {
                resourceType: 'skill',
                name: skill.name,
                winnerPath: existing.filePath,
                loserPath: skill.filePath,
            },
        })
        return
    }
    skillMap.set(skill.name, skill)
}

function addPromptWithCollisionCheck(
    prompt: PromptTemplate,
    promptMap: Map<string, PromptTemplate>,
    diagnostics: ResourceDiagnostic[],
    source: string,
): void {
    const existing = promptMap.get(prompt.name)
    if (existing) {
        diagnostics.push({
            type: 'collision',
            message: `prompt template name "${prompt.name}" collision: first winner kept`,
            path: prompt.filePath,
            resourceType: 'prompt',
            source,
            collision: {
                resourceType: 'prompt',
                name: prompt.name,
                winnerPath: existing.filePath,
                loserPath: prompt.filePath,
            },
        })
        return
    }
    promptMap.set(prompt.name, prompt)
}

function freezeSnapshot(snapshot: {
    contextFiles: ContextFile[]
    system?: PromptSource
    appendSystem?: PromptSource
    skills: Skill[]
    prompts: PromptTemplate[]
    systemPrompt: string
    systemPromptParts?: ResourcePromptPart[]
    diagnostics: ResourceDiagnostic[]
}): ResourceSnapshot {
    for (const file of snapshot.contextFiles) {
        Object.freeze(file)
    }
    if (snapshot.system) {
        Object.freeze(snapshot.system)
    }
    if (snapshot.appendSystem) {
        Object.freeze(snapshot.appendSystem)
    }
    for (const skill of snapshot.skills) {
        Object.freeze(skill)
    }
    for (const prompt of snapshot.prompts) {
        Object.freeze(prompt)
    }
    if (snapshot.systemPromptParts) {
        for (const part of snapshot.systemPromptParts) {
            Object.freeze(part)
        }
    }
    for (const diag of snapshot.diagnostics) {
        if (diag.collision) {
            Object.freeze(diag.collision)
        }
        Object.freeze(diag)
    }

    const frozen: ResourceSnapshot = {
        contextFiles: Object.freeze([...snapshot.contextFiles]),
        ...(snapshot.system ? { system: snapshot.system } : {}),
        ...(snapshot.appendSystem ? { appendSystem: snapshot.appendSystem } : {}),
        skills: Object.freeze([...snapshot.skills]),
        prompts: Object.freeze([...snapshot.prompts]),
        systemPrompt: snapshot.systemPrompt,
        ...(snapshot.systemPromptParts ? { systemPromptParts: Object.freeze([...snapshot.systemPromptParts]) } : {}),
        diagnostics: Object.freeze([...snapshot.diagnostics]),
    }
    return Object.freeze(frozen)
}

function cloneContextFile(file: ContextFile): ContextFile {
    return { path: file.path, content: file.content }
}

function clonePromptSource(source: PromptSource): PromptSource {
    return { path: source.path, content: source.content }
}

function cloneSkill(skill: Skill): Skill {
    return {
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        baseDir: skill.baseDir,
        disableModelInvocation: skill.disableModelInvocation,
        body: skill.body,
    }
}

function clonePrompt(prompt: PromptTemplate): PromptTemplate {
    return {
        name: prompt.name,
        description: prompt.description,
        ...(prompt.argumentHint !== undefined ? { argumentHint: prompt.argumentHint } : {}),
        content: prompt.content,
        filePath: prompt.filePath,
    }
}

function mapContextDiagnostic(diag: ContextDiagnostic, source: string): ResourceDiagnostic {
    return {
        type: 'warning',
        message: diag.message,
        path: diag.path,
        resourceType: 'context',
        source,
    }
}

function mapSkillDiagnostic(diag: SkillDiagnostic, source: string): ResourceDiagnostic {
    return {
        type: diag.type,
        message: diag.message,
        path: diag.path,
        resourceType: 'skill',
        source,
        ...(diag.collision
            ? {
                  collision: {
                      resourceType: 'skill' as const,
                      name: diag.collision.name,
                      winnerPath: diag.collision.winnerPath,
                      loserPath: diag.collision.loserPath,
                  },
              }
            : {}),
    }
}

function mapPromptDiagnostic(diag: PromptDiagnostic, source: string): ResourceDiagnostic {
    return {
        type: diag.type,
        message: diag.message,
        path: diag.path,
        resourceType: 'prompt',
        source,
        ...(diag.collision
            ? {
                  collision: {
                      resourceType: 'prompt' as const,
                      name: diag.collision.name,
                      winnerPath: diag.collision.winnerPath,
                      loserPath: diag.collision.loserPath,
                  },
              }
            : {}),
    }
}

function compareDiagnostics(a: ResourceDiagnostic, b: ResourceDiagnostic): number {
    const typeOrder = (t: ResourceDiagnostic['type']) => (t === 'collision' ? 0 : 1)
    const byType = typeOrder(a.type) - typeOrder(b.type)
    if (byType !== 0) {
        return byType
    }
    const fields: Array<[string, string]> = [
        [a.resourceType ?? '', b.resourceType ?? ''],
        [a.path ?? '', b.path ?? ''],
        [a.message, b.message],
        [a.collision?.resourceType ?? '', b.collision?.resourceType ?? ''],
        [a.collision?.name ?? '', b.collision?.name ?? ''],
        [a.collision?.winnerPath ?? '', b.collision?.winnerPath ?? ''],
        [a.collision?.loserPath ?? '', b.collision?.loserPath ?? ''],
    ]
    for (const [left, right] of fields) {
        const cmp = compareCodePoints(left, right)
        if (cmp !== 0) {
            return cmp
        }
    }
    return 0
}

function compareCodePoints(a: string, b: string): number {
    if (a < b) {
        return -1
    }
    if (a > b) {
        return 1
    }
    return 0
}

function isValidAbsolutePath(value: string | undefined | null): value is string {
    if (typeof value !== 'string' || value.length === 0) {
        return false
    }
    if (hasControlChars(value)) {
        return false
    }
    try {
        return isAbsolutePath(value)
    } catch {
        return false
    }
}

function validateAbsoluteResourcePath(value: string, label: string): string | null {
    if (typeof value !== 'string' || value.length === 0) {
        return `${label} must be a non-empty absolute path`
    }
    if (hasControlChars(value)) {
        return `${label} is invalid: control characters are not allowed`
    }
    try {
        if (!isAbsolutePath(value)) {
            return `${label} must be an absolute path: ${value}`
        }
    } catch (error) {
        return `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`
    }
    return null
}

function collectProjectPaths(
    cwd: string | undefined,
    paths: readonly string[] | undefined,
): string[] {
    const result: string[] = []
    const seen = new Set<string>()
    for (const path of [cwd, ...(paths ?? [])]) {
        if (!path || seen.has(path) || !isValidAbsolutePath(path)) continue
        seen.add(path)
        result.push(path)
    }
    return result
}

function normalizePromptPath(value: string): string {
    return value.replace(/\\/g, '/')
}

function hasControlChars(value: string): boolean {
    for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i)
        if (code < 0x20 || code === 0x7f) {
            return true
        }
    }
    return false
}
