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
        const idxSkills = prompt.indexOf('<available_skills>')
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
            tools: [{ name: 'read', description: 'Read files' }],
            extensionRegistry: registry,
        }

        const snapshot = await loadResourcesFromProviders(input)

        expect(snapshot.skills.some((s) => s.name === 'custom-tool-skill')).toBe(true)
        expect(snapshot.systemPrompt).toContain('custom-tool-skill')
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
})
