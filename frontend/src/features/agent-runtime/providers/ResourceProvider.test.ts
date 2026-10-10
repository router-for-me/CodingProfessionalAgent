import { beforeEach, describe, expect, it } from 'vitest'
import { RendererRegistry } from '@/plugins/platform/rendererRegistry'
import { FakeNativeBridge } from '../native/fakeNativeBridge'
import { resourcesAgentEntry } from '../../../../../plugins/bundled/cpa.core.resources/agent/index'
import {
    loadResourcesFromProviders,
    type LoadResourceSnapshotInput,
    type ResourceProvider,
} from './ResourceProvider'

const AGENT = '/config/coding-professional-agent/agent'
const REPO = '/repo'
const HOME = '/home/user'

function skillMd(name: string, description: string, body: string): string {
    return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}\n`
}

function activateResourcesEntry(entry: any, registry: RendererRegistry): void {
    const fakeContext = {
        register: (contrib: any) => {
            if (contrib.kind === 'resource-provider') {
                registry.registerResourceProvider(contrib.value)
            }
        },
        getService: () => undefined,
    }
    entry.activate(fakeContext as any)
}

describe('ResourceProvider', () => {
    let bridge: FakeNativeBridge
    let registry: RendererRegistry

    beforeEach(() => {
        bridge = new FakeNativeBridge()
        registry = new RendererRegistry()
        activateResourcesEntry(resourcesAgentEntry, registry)
    })

    it('keeps context skills prompts memories and system prompts in the current order', async () => {
        bridge.setFile(`${AGENT}/AGENTS.md`, 'global agents')
        bridge.setFile(`${AGENT}/SYSTEM.md`, 'CUSTOM BASE SYSTEM')
        bridge.setFile(`${AGENT}/APPEND_SYSTEM.md`, 'APPEND_SYSTEM_CONTENT')
        bridge.setFile(`${REPO}/AGENTS.md`, 'repo agents')
        bridge.setFile(
            `${AGENT}/skills/demo/SKILL.md`,
            skillMd('demo', 'Demo skill', 'DEMO SKILL BODY'),
        )
        bridge.setFile(
            `${AGENT}/prompts/fix.md`,
            '---\ndescription: Fix things\n---\nFix $1\n',
        )
        bridge.setFile(
            `${HOME}/.coding-professional-agent/memories/memory_summary.md`,
            'Memory summary content.',
        )

        registry.registerResourceProvider({
            id: 'cpa.core.memories',
            kind: 'system-prompt',
            order: 15,
            targetAgent: 'main',
            load: async (providerInput: any) => {
                if (providerInput.localMemoryEnabled === false) return []
                try {
                    const bytes = await providerInput.bridge.readFile(
                        `${providerInput.homeDir}/.coding-professional-agent/memories/memory_summary.md`,
                    )
                    const text = new TextDecoder().decode(bytes)
                    return [
                        {
                            id: 'memory',
                            content: `## Memory\n\n${text}`,
                            order: 15,
                        },
                    ]
                } catch {
                    return []
                }
            },
        })

        registry.registerSystemPrompt({
            id: 'extra-guideline',
            guideline: 'Always verify things',
            targetAgent: 'main',
            order: 50,
        })
        registry.registerSystemPrompt({
            id: 'plugin-prompt-block',
            content: '[EXTRA PLUGIN PROMPT BLOCK]',
            targetAgent: 'main',
            order: 60,
        })

        // Also add files that generate diagnostics to check diagnostic sources and ordering
        bridge.setFile(
            `${REPO}/.cpa/skills/demo/SKILL.md`,
            skillMd('demo', 'Duplicate demo', 'DUPLICATE BODY'),
        )
        bridge.setFile(
            `${REPO}/.cpa/prompts/fix.md`,
            '---\ndescription: Duplicate fix\n---\nFix duplicate\n',
        )

        const input: LoadResourceSnapshotInput = {
            cwd: REPO,
            projectPaths: [REPO, '/shared'],
            agentDir: AGENT,
            homeDir: HOME,
            bridge,
            agentTarget: 'main',
            tools: [
                { name: 'read', description: 'Read files' },
                { name: 'bash', description: 'Run commands' },
                { name: 'skill_search', description: 'Search skills' },
            ],
            extensionRegistry: registry,
            localMemoryEnabled: true,
        }

        const snapshot = await loadResourcesFromProviders(input)

        // Verify diagnostics preserve source and collision details
        const existingDiagnosticOrder = ['prompt', 'skill']
        expect(snapshot.diagnostics.map((item) => item.resourceType)).toEqual(existingDiagnosticOrder)
        expect(snapshot.diagnostics.map((item) => item.source)).toEqual(['cpa.core.prompt-templates', 'cpa.core.skills'])

        // Verify system prompt parts preserve exact sequential order
        const existingPromptPartOrder = [
            'base',
            'append-system',
            'memory',
            'plugin-prompt-block',
            'project-context',
            'skills',
            'cwd',
            'project-paths',
        ]
        expect(snapshot.systemPromptParts?.map((item) => item.id)).toEqual(existingPromptPartOrder)

        // Verify the full rendered prompt contains all assembled sections in sequence
        const prompt = snapshot.systemPrompt
        const idxBase = prompt.indexOf('CUSTOM BASE SYSTEM')
        const idxAppend = prompt.indexOf('APPEND_SYSTEM_CONTENT')
        const idxMemory = prompt.indexOf('Memory summary content.')
        const idxPlugin = prompt.indexOf('[EXTRA PLUGIN PROMPT BLOCK]')
        const idxProject = prompt.indexOf('<project_context>')
        const idxSkills = prompt.indexOf('<skill_names>')
        const idxCwd = prompt.indexOf('Current working directory: /repo')
        const idxPaths = prompt.indexOf('Allowed project paths:')

        expect(idxBase).toBeGreaterThanOrEqual(0)
        expect(idxAppend).toBeGreaterThan(idxBase)
        expect(idxMemory).toBeGreaterThan(idxAppend)
        expect(idxPlugin).toBeGreaterThan(idxMemory)
        expect(idxProject).toBeGreaterThan(idxPlugin)
        expect(idxSkills).toBeGreaterThan(idxProject)
        expect(idxCwd).toBeGreaterThan(idxSkills)
        expect(idxPaths).toBeGreaterThan(idxCwd)
    })

    it('allows dynamic plugins to contribute custom resource providers', async () => {
        const customSkillProvider: ResourceProvider = {
            id: 'plugin.custom-skills',
            kind: 'skill',
            order: 25,
            load: async () => [
                {
                    name: 'custom-tool-skill',
                    description: 'Skill provided dynamically',
                    filePath: '/virtual/custom/SKILL.md',
                    baseDir: '/virtual/custom',
                    disableModelInvocation: false,
                    body: 'DYNAMIC SKILL BODY',
                },
            ],
        }

        registry.registerResourceProvider(customSkillProvider)

        const input: LoadResourceSnapshotInput = {
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            agentTarget: 'main',
            tools: [
                { name: 'read', description: 'Read files' },
                { name: 'skill_search', description: 'Search skills' },
            ],
            extensionRegistry: registry,
        }

        const snapshot = await loadResourcesFromProviders(input)

        expect(snapshot.skills.some((s) => s.name === 'custom-tool-skill')).toBe(true)
        expect((snapshot.searchableSkills ?? []).some((s) => s.name === 'custom-tool-skill')).toBe(true)
        expect(snapshot.systemPrompt).toContain('- custom-tool-skill')
        expect(snapshot.systemPrompt).not.toContain('Skill provided dynamically')
    })

    it('respects agentTarget filtering when loading resource providers', async () => {
        const mainOnlyProvider: ResourceProvider = {
            id: 'plugin.main-only',
            kind: 'system-prompt',
            order: 10,
            targetAgent: 'main',
            load: async () => [
                {
                    id: 'main-only-guideline',
                    guideline: 'Main agent guideline',
                },
            ],
        }

        const subagentOnlyProvider: ResourceProvider = {
            id: 'plugin.subagent-only',
            kind: 'system-prompt',
            order: 10,
            targetAgent: 'subagent',
            load: async () => [
                {
                    id: 'subagent-only-guideline',
                    guideline: 'Subagent guideline',
                },
            ],
        }

        registry.registerResourceProvider(mainOnlyProvider)
        registry.registerResourceProvider(subagentOnlyProvider)

        const mainSnapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            agentTarget: 'main',
            extensionRegistry: registry,
        })

        expect(mainSnapshot.systemPrompt).toContain('Main agent guideline')
        expect(mainSnapshot.systemPrompt).not.toContain('Subagent guideline')

        const subagentSnapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            agentTarget: 'subagent',
            extensionRegistry: registry,
        })

        expect(subagentSnapshot.systemPrompt).toContain('Subagent guideline')
        expect(subagentSnapshot.systemPrompt).not.toContain('Main agent guideline')
    })

    it('omits memory when localMemoryEnabled is false', async () => {
        bridge.setFile(
            `${HOME}/.coding-professional-agent/memories/memory_summary.md`,
            'User prefers dark mode.',
        )

        registry.registerResourceProvider({
            id: 'cpa.core.memories',
            kind: 'system-prompt',
            order: 15,
            targetAgent: 'main',
            load: async (providerInput: any) => {
                if (providerInput.localMemoryEnabled === false) return []
                try {
                    const bytes = await providerInput.bridge.readFile(
                        `${providerInput.homeDir}/.coding-professional-agent/memories/memory_summary.md`,
                    )
                    const text = new TextDecoder().decode(bytes)
                    return [
                        {
                            id: 'memory',
                            content: `## Memory\n\n${text}`,
                            order: 15,
                        },
                    ]
                } catch {
                    return []
                }
            },
        })

        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            homeDir: HOME,
            bridge,
            agentTarget: 'main',
            extensionRegistry: registry,
            localMemoryEnabled: false,
        })

        expect(snapshot.systemPrompt).not.toContain('## Memory')
        expect(snapshot.systemPrompt).not.toContain('User prefers dark mode.')
    })

    it('deduplicates system prompt parts by part.id when identical IDs are registered', async () => {
        registry.registerResourceProvider({
            id: 'provider-1',
            kind: 'system-prompt',
            order: 10,
            load: async () => [
                {
                    id: 'duplicate-block',
                    content: 'First copy of duplicate block',
                    order: 10,
                },
            ],
        })
        registry.registerResourceProvider({
            id: 'provider-2',
            kind: 'system-prompt',
            order: 11,
            load: async () => [
                {
                    id: 'duplicate-block',
                    content: 'Second copy of duplicate block',
                    order: 11,
                },
            ],
        })

        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            agentTarget: 'main',
            extensionRegistry: registry,
        })

        const duplicateParts = snapshot.systemPromptParts?.filter((p) => p.id === 'duplicate-block')
        expect(duplicateParts).toHaveLength(1)
        expect(duplicateParts?.[0]?.content).toBe('First copy of duplicate block')
    })

    it('freezes the snapshot and its sub-arrays deeply', async () => {
        bridge.setFile(`${REPO}/AGENTS.md`, 'repo instructions')
        bridge.setFile(
            `${AGENT}/skills/demo/SKILL.md`,
            skillMd('demo', 'Demo', 'BODY'),
        )

        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            agentTarget: 'main',
            tools: [{ name: 'read', description: 'Read' }],
        })

        expect(Object.isFrozen(snapshot)).toBe(true)
        expect(Object.isFrozen(snapshot.contextFiles)).toBe(true)
        expect(Object.isFrozen(snapshot.skills)).toBe(true)
        expect(Object.isFrozen(snapshot.prompts)).toBe(true)
        expect(Object.isFrozen(snapshot.diagnostics)).toBe(true)
    })

    it('injects subagent roles XML block and priority instructions when roles are configured and spawn_agent is available', async () => {
        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            agentTarget: 'main',
            tools: [{ name: 'spawn_agent', description: 'Spawn agent' }],
            subagentsSettings: {
                enabled: true,
                concurrency: 10,
                maxPerSession: 3,
                maxDepth: 1,
                roles: [
                    {
                        id: 'role-1',
                        name: '代码审查员',
                        description: '负责代码质量与安全审计',
                        modelId: 'claude-sonnet-5',
                        reasoningEffort: 'high',
                    },
                ],
            },
        })

        expect(snapshot.systemPrompt).toContain('<available_roles>')
        expect(snapshot.systemPrompt).toContain(
            'When encountering scenarios matching any of these defined roles when dispatching a sub-agent, prioritize using the user-defined subagent role rather than deciding the model, reasoning effort, or prompt on your own.'
        )
        expect(snapshot.systemPrompt).toContain('<id>role-1</id>')
        expect(snapshot.systemPrompt).toContain('<name>代码审查员</name>')
        expect(snapshot.systemPrompt).toContain('<description>负责代码质量与安全审计</description>')
        expect(snapshot.systemPrompt).toContain('<model>claude-sonnet-5</model>')
        expect(snapshot.systemPrompt).toContain('<reasoning_effort>high</reasoning_effort>')
        expect(snapshot.systemPrompt).toContain('</available_roles>')

        const rolesPart = snapshot.systemPromptParts?.find((p) => p.id === 'subagent-roles')
        expect(rolesPart).toBeDefined()
        expect(rolesPart?.content).toContain('<available_roles>')
    })

    it('does not inject subagent roles if spawn_agent tool is missing or roles list is empty', async () => {
        const snapshotNoSpawn = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            agentTarget: 'main',
            tools: [{ name: 'read', description: 'Read' }],
            subagentsSettings: {
                enabled: true,
                concurrency: 10,
                maxPerSession: 3,
                maxDepth: 1,
                roles: [
                    {
                        id: 'role-1',
                        name: '代码审查员',
                        description: '负责代码质量与安全审计',
                        modelId: 'claude-sonnet-5',
                        reasoningEffort: 'high',
                    },
                ],
            },
        })
        expect(snapshotNoSpawn.systemPrompt).not.toContain('<available_roles>')

        const snapshotEmptyRoles = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            agentTarget: 'main',
            tools: [{ name: 'spawn_agent', description: 'Spawn agent' }],
            subagentsSettings: {
                enabled: true,
                concurrency: 10,
                maxPerSession: 3,
                maxDepth: 1,
                roles: [],
            },
        })
        expect(snapshotEmptyRoles.systemPrompt).not.toContain('<available_roles>')
    })

    it('injects <git> section into systemPrompt and systemPromptParts when gitSettings are configured', async () => {
        const bridge = new FakeNativeBridge()
        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            agentTarget: 'main',
            gitSettings: {
                mergeMethod: 'squash',
                alwaysForcePush: true,
                createDraftPr: false,
                commitInstructions: 'Follow conventional commit standard',
                prInstructions: 'Include testing plan and screenshot',
            },
        })

        expect(snapshot.systemPrompt).toContain('<git>')
        expect(snapshot.systemPrompt).toContain('Use the "squash" method when merging pull requests.')
        expect(snapshot.systemPrompt).not.toContain('Pull request merge method:')
        expect(snapshot.systemPrompt).toContain('When pushing branches to the remote repository, always use force push with lease (e.g. "git push --force-with-lease").')
        expect(snapshot.systemPrompt).not.toContain('Always force push:')
        expect(snapshot.systemPrompt).toContain('Do not create pull requests as draft by default (create regular, ready-for-review pull requests).')
        expect(snapshot.systemPrompt).not.toContain('Create draft pull requests:')
        expect(snapshot.systemPrompt).toContain('Commit instructions: Follow conventional commit standard')
        expect(snapshot.systemPrompt).toContain('Pull request instructions: Include testing plan and screenshot')
        expect(snapshot.systemPrompt).toContain('</git>')

        const gitPart = snapshot.systemPromptParts?.find((p) => p.id === 'git')
        expect(gitPart).toBeDefined()
        expect(gitPart?.content).toContain('<git>')
        expect(gitPart?.content).toContain('Follow conventional commit standard')
    })

    it('omits un-filled Git settings and does not inject empty <git> section when gitSettings is empty', async () => {
        const bridge = new FakeNativeBridge()
        const snapshotEmpty = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            agentTarget: 'main',
            gitSettings: {
                commitInstructions: '',
                prInstructions: '   ',
            },
        })

        expect(snapshotEmpty.systemPrompt).not.toContain('<git>')
        expect(snapshotEmpty.systemPrompt).not.toContain('</git>')
        expect(snapshotEmpty.systemPromptParts?.some((p) => p.id === 'git')).toBe(false)

        const snapshotPartial = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            agentTarget: 'main',
            gitSettings: {
                commitInstructions: 'Prefix with [JIRA-123]',
            },
        })

        expect(snapshotPartial.systemPrompt).toContain('<git>')
        expect(snapshotPartial.systemPrompt).toContain('Commit instructions: Prefix with [JIRA-123]')
        expect(snapshotPartial.systemPrompt).not.toContain('merging pull requests')
        expect(snapshotPartial.systemPrompt).not.toContain('force push')
        expect(snapshotPartial.systemPrompt).not.toContain('pull requests as draft')
        expect(snapshotPartial.systemPrompt).not.toContain('Pull request instructions')
    })

    it('respects skillsSettings: auto in prompt & snapshot, explicit in snapshot only, disabled omitted from both', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setFile(
            `${AGENT}/skills/alpha/SKILL.md`,
            '---\nname: alpha\ndescription: Alpha skill\n---\nAlpha body\n',
        )
        bridge.setFile(
            `${AGENT}/skills/beta/SKILL.md`,
            '---\nname: beta\ndescription: Beta skill\n---\nBeta body\n',
        )
        bridge.setFile(
            `${AGENT}/skills/gamma/SKILL.md`,
            '---\nname: gamma\ndescription: Gamma skill\n---\nGamma body\n',
        )

        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            agentTarget: 'main',
            extensionRegistry: registry,
            tools: [
                { name: 'read', description: 'Read files' },
                { name: 'skill_search', description: 'Search skills' },
            ],
            skillsSettings: {
                defaultMode: 'auto',
                skills: {
                    beta: 'explicit',
                    gamma: 'disabled',
                },
            },
        })

        // Alpha is auto: searchable, but the prompt only points at skill_search.
        expect((snapshot.searchableSkills ?? []).map((s) => s.name)).toEqual(['alpha'])
        expect(snapshot.systemPrompt).toContain('- alpha')
        expect(snapshot.systemPrompt).not.toContain('Alpha skill')
        expect(snapshot.skills.some((s) => s.name === 'alpha')).toBe(true)

        // Beta is explicit: not searchable, but preserved for direct invocation.
        expect((snapshot.searchableSkills ?? []).some((s) => s.name === 'beta')).toBe(false)
        expect(snapshot.systemPrompt).not.toContain('Beta skill')
        expect(snapshot.skills.some((s) => s.name === 'beta')).toBe(true)

        // Gamma is disabled: omitted from both catalogs.
        expect((snapshot.searchableSkills ?? []).some((s) => s.name === 'gamma')).toBe(false)
        expect(snapshot.systemPrompt).not.toContain('Gamma skill')
        expect(snapshot.skills.some((s) => s.name === 'gamma')).toBe(false)
    })

    it('applies defaultMode when individual skills have default or no explicit mode', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setFile(
            `${AGENT}/skills/s1/SKILL.md`,
            '---\nname: s1\ndescription: Skill One\n---\nBody One\n',
        )
        bridge.setFile(
            `${AGENT}/skills/s2/SKILL.md`,
            '---\nname: s2\ndescription: Skill Two\n---\nBody Two\n',
        )

        // When defaultMode is 'explicit', s1 and s2 follow default: snapshot only, omitted from prompt
        const snapshotExplicit = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            agentTarget: 'main',
            extensionRegistry: registry,
            tools: [
                { name: 'read', description: 'Read files' },
                { name: 'skill_search', description: 'Search skills' },
            ],
            skillsSettings: {
                defaultMode: 'explicit',
                skills: {
                    s2: 'default',
                },
            },
        })

        expect(snapshotExplicit.searchableSkills).toEqual([])
        expect(snapshotExplicit.systemPrompt).not.toContain('<skill_names>')
        expect(snapshotExplicit.skills.map((s) => s.name)).toEqual(['s1', 's2'])

        // When defaultMode is 'disabled', s1 is disabled unless overridden to auto
        const snapshotDisabled = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            agentTarget: 'main',
            extensionRegistry: registry,
            tools: [
                { name: 'read', description: 'Read files' },
                { name: 'skill_search', description: 'Search skills' },
            ],
            skillsSettings: {
                defaultMode: 'disabled',
                skills: {
                    s1: 'auto',
                },
            },
        })

        expect((snapshotDisabled.searchableSkills ?? []).map((s) => s.name)).toEqual(['s1'])
        expect(snapshotDisabled.systemPrompt).toContain('- s1')
        expect(snapshotDisabled.systemPrompt).not.toContain('Skill One')
        expect(snapshotDisabled.skills.map((s) => s.name)).toEqual(['s1'])
    })
})
