import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RendererRegistry as ExtensionRegistry, rendererRegistry } from '@/plugins/platform/rendererRegistry'
import { FakeNativeBridge } from '../native/fakeNativeBridge'
import { expandSkillCommand, expandPromptTemplate } from '@cpa/plugin-sdk'
import { expandSnapshotCommand, loadResourcesFromProviders } from './resourceLoader'
import { formatWorktreeModePrompt } from './worktreeMode'
import { resourcesAgentEntry } from '../../../../../plugins/bundled/cpa.core.resources/agent/index'

const AGENT = '/config/coding-professional-agent/agent'
const REPO = '/repo'

function skillMd(name: string, description: string, body: string): string {
    return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}\n`
}

function activateResources(reg: ExtensionRegistry): void {
    resourcesAgentEntry.activate({
        register: (c: any) => {
            if (c.kind === 'resource-provider') {
                reg.registerResourceProvider(c.value ?? c)
            }
        },
    } as any)
}

describe('loadResourcesFromProviders', () => {
    beforeEach(() => {
        rendererRegistry.clear()
        activateResources(rendererRegistry)
    })
    it('captures contextFiles, SYSTEM/APPEND, skills, prompts, systemPrompt, diagnostics in one snapshot', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setFile(`${AGENT}/AGENTS.md`, 'global agents')
        bridge.setFile(`${AGENT}/SYSTEM.md`, 'CUSTOM SYSTEM')
        bridge.setFile(`${AGENT}/APPEND_SYSTEM.md`, 'APPEND HERE')
        bridge.setFile(`${REPO}/AGENTS.md`, 'repo agents')
        bridge.setFile(
            `${AGENT}/skills/demo/SKILL.md`,
            skillMd('demo', 'Demo skill', 'SKILL BODY'),
        )
        bridge.setFile(
            `${AGENT}/prompts/fix.md`,
            '---\ndescription: Fix things\n---\nFix $1\n',
        )

        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            projectPaths: [REPO, '/shared'],
            agentDir: AGENT,
            bridge,
            tools: [
                { name: 'read', description: 'Read files' },
                { name: 'bash', description: 'Run commands' },
            ],
        })

        expect(snapshot.contextFiles.map((f) => f.path)).toEqual([
            `${AGENT}/AGENTS.md`,
            `${REPO}/AGENTS.md`,
        ])
        expect(snapshot.system?.content).toBe('CUSTOM SYSTEM')
        expect(snapshot.appendSystem?.content).toBe('APPEND HERE')
        expect(snapshot.skills.map((s) => s.name)).toEqual(['demo'])
        expect(snapshot.prompts.map((p) => p.name)).toEqual(['fix'])
        expect(snapshot.systemPrompt).toContain('CUSTOM SYSTEM')
        expect(snapshot.systemPrompt).toContain('APPEND HERE')
        expect(snapshot.systemPrompt).toContain('<project_context>')
        expect(snapshot.systemPrompt).toContain('<available_skills>')
        expect(snapshot.systemPrompt).toContain('Current working directory: /repo')
        expect(snapshot.systemPrompt).toContain(
            'Allowed project paths:\n- /repo\n- /shared',
        )
    })

    it('orders system sections: base → APPEND → project instructions → skills → cwd', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setFile(`${AGENT}/APPEND_SYSTEM.md`, 'APPEND_MARKER')
        bridge.setFile(`${REPO}/AGENTS.md`, 'PROJECT_MARKER')
        bridge.setFile(
            `${AGENT}/skills/s/SKILL.md`,
            skillMd('s', 'S', 'BODY'),
        )

        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            tools: [{ name: 'read', description: 'Read' }],
        })

        const prompt = snapshot.systemPrompt
        const idxBase = prompt.indexOf('Coding Professional Agent')
        const idxAppend = prompt.indexOf('APPEND_MARKER')
        const idxProject = prompt.indexOf('PROJECT_MARKER')
        const idxSkills = prompt.indexOf('<available_skills>')
        const idxCwd = prompt.indexOf('Current working directory:')

        expect(idxBase).toBeGreaterThanOrEqual(0)
        expect(idxAppend).toBeGreaterThan(idxBase)
        expect(idxProject).toBeGreaterThan(idxAppend)
        expect(idxSkills).toBeGreaterThan(idxProject)
        expect(idxCwd).toBeGreaterThan(idxSkills)
    })

    it('omits skills section when read tool is unavailable (closed-world)', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setFile(
            `${AGENT}/skills/s/SKILL.md`,
            skillMd('s', 'S', 'BODY'),
        )

        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            tools: [{ name: 'bash', description: 'Run' }],
        })

        expect(snapshot.skills).toHaveLength(1)
        expect(snapshot.systemPrompt).not.toContain('<available_skills>')
        expect(snapshot.systemPrompt).not.toContain('Use the read tool')
        // Explicit expansion still works from snapshot skills.
        expect(expandSkillCommand('/skill:s', snapshot.skills)).toBe('BODY')
    })

    it('freezes snapshot deeply so callers cannot mutate skills/prompts/context', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setFile(`${REPO}/AGENTS.md`, 'agents')
        bridge.setFile(
            `${AGENT}/skills/s/SKILL.md`,
            skillMd('s', 'S', 'BODY'),
        )
        bridge.setFile(`${AGENT}/prompts/p.md`, 'Prompt $1\n')

        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            tools: [{ name: 'read', description: 'Read' }],
        })

        expect(Object.isFrozen(snapshot)).toBe(true)
        expect(Object.isFrozen(snapshot.skills)).toBe(true)
        expect(Object.isFrozen(snapshot.skills[0])).toBe(true)
        expect(Object.isFrozen(snapshot.prompts)).toBe(true)
        expect(Object.isFrozen(snapshot.prompts[0])).toBe(true)
        expect(Object.isFrozen(snapshot.contextFiles)).toBe(true)
        expect(Object.isFrozen(snapshot.diagnostics)).toBe(true)

        expect(() => {
            ;(snapshot.skills as SkillMut[])[0] = {
                name: 'hack',
                description: 'x',
                filePath: '/x',
                baseDir: '/x',
                disableModelInvocation: false,
                body: 'HACK',
            }
        }).toThrow()

        expect(() => {
            ;(snapshot.skills[0] as { body: string }).body = 'mutated'
        }).toThrow()
    })

    it('ignores file drift after load for expansion and systemPrompt contents', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setFile(
            `${AGENT}/skills/s/SKILL.md`,
            skillMd('s', 'S', 'ORIGINAL_BODY'),
        )
        bridge.setFile(
            `${AGENT}/prompts/p.md`,
            '---\ndescription: Prompt\n---\nTEMPLATE $1 ORIGINAL\n',
        )
        bridge.setFile(`${REPO}/AGENTS.md`, 'ORIGINAL_AGENTS')

        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            tools: [{ name: 'read', description: 'Read' }],
        })

        // Mutate all sources after snapshot.
        bridge.setFile(
            `${AGENT}/skills/s/SKILL.md`,
            skillMd('s', 'S', 'MUTATED_BODY'),
        )
        bridge.setFile(
            `${AGENT}/prompts/p.md`,
            '---\ndescription: Prompt\n---\nTEMPLATE $1 MUTATED\n',
        )
        bridge.setFile(`${REPO}/AGENTS.md`, 'MUTATED_AGENTS')

        expect(snapshot.systemPrompt).toContain('ORIGINAL_AGENTS')
        expect(snapshot.systemPrompt).not.toContain('MUTATED_AGENTS')
        expect(expandSkillCommand('/skill:s args', snapshot.skills)).toBe(
            'ORIGINAL_BODY\n\nUser: args',
        )
        expect(expandPromptTemplate('/p Button', snapshot.prompts)).toBe(
            'TEMPLATE Button ORIGINAL',
        )
        expect(expandSnapshotCommand('/skill:s z', snapshot)).toBe(
            'ORIGINAL_BODY\n\nUser: z',
        )
        expect(expandSnapshotCommand('/p x', snapshot)).toBe('TEMPLATE x ORIGINAL')
    })

    it('loads global-only resources when cwd is undefined or invalid', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setFile(`${AGENT}/AGENTS.md`, 'global agents')
        bridge.setFile(
            `${AGENT}/skills/g/SKILL.md`,
            skillMd('g', 'Global skill', 'G'),
        )
        bridge.setFile(`${AGENT}/prompts/g.md`, 'Global prompt\n')
        bridge.setFile(
            `${REPO}/.cpa/skills/p/SKILL.md`,
            skillMd('p', 'Project skill', 'P'),
        )
        bridge.setFile(`${REPO}/.cpa/prompts/p.md`, 'Project prompt\n')
        bridge.setFile(`${REPO}/AGENTS.md`, 'project agents')

        const snapshot = await loadResourcesFromProviders({
            agentDir: AGENT,
            bridge,
            tools: [{ name: 'read', description: 'Read' }],
        })

        expect(snapshot.skills.map((s) => s.name)).toEqual(['g'])
        expect(snapshot.prompts.map((p) => p.name)).toEqual(['g'])
        expect(snapshot.contextFiles.some((f) => f.path.includes(REPO))).toBe(false)
        expect(snapshot.systemPrompt).not.toContain('Current working directory:')
        expect(snapshot.systemPrompt).toContain('<available_skills>')
    })

    it('keeps single-resource failures non-blocking', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setFile(
            `${AGENT}/skills/ok/SKILL.md`,
            skillMd('ok', 'OK', 'BODY'),
        )
        bridge.setFile(`${AGENT}/skills/bad/SKILL.md`, '---\nfoo: [unterminated\n---\n')
        bridge.setFile(`${AGENT}/prompts/ok.md`, 'OK template\n')
        bridge.setFile(`${AGENT}/prompts/bad.md`, '---\nfoo: [unterminated\n---\n')

        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            tools: [{ name: 'read', description: 'Read' }],
        })

        expect(snapshot.skills.map((s) => s.name)).toEqual(['ok'])
        expect(snapshot.prompts.map((p) => p.name)).toEqual(['ok'])
        expect(snapshot.diagnostics.length).toBeGreaterThan(0)
        expect(snapshot.diagnostics.every((d) => d.resourceType)).toBe(true)
    })

    it('global-only invalid cwd does not scan agentDir ancestors or agentDir/.cpa', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setFile(`${AGENT}/AGENTS.md`, 'global agents')
        bridge.setFile(`${AGENT}/SYSTEM.md`, 'global system')
        bridge.setFile('/config/AGENTS.md', 'ancestor agents')
        bridge.setFile(`${AGENT}/.cpa/SYSTEM.md`, 'cpa system')
        bridge.setFile(`${AGENT}/.cpa/AGENTS.md`, 'cpa agents')
        bridge.setFile(
            `${AGENT}/skills/g/SKILL.md`,
            skillMd('g', 'Global skill', 'G'),
        )

        const touched: string[] = []
        const originalReadDir = bridge.readDir.bind(bridge)
        const originalReadFile = bridge.readFile.bind(bridge)
        vi.spyOn(bridge, 'readDir').mockImplementation(async (path: string) => {
            touched.push(path)
            return originalReadDir(path)
        })
        vi.spyOn(bridge, 'readFile').mockImplementation(async (path: string) => {
            touched.push(path)
            return originalReadFile(path)
        })

        const snapshot = await loadResourcesFromProviders({
            cwd: 'relative-not-absolute',
            agentDir: AGENT,
            bridge,
            tools: [{ name: 'read', description: 'Read' }],
        })

        expect(snapshot.contextFiles.map((f) => f.path)).toEqual([`${AGENT}/AGENTS.md`])
        expect(snapshot.system?.content).toBe('global system')
        expect(snapshot.skills.map((s) => s.name)).toEqual(['g'])
        expect(touched.some((p) => p === '/config' || p.includes('/.cpa'))).toBe(false)
    })

    it('sorts diagnostics with full locale-independent total order including collision fields', async () => {
        const bridge = new FakeNativeBridge()
        // Two skill name collisions + two prompt collisions to force multi-field ties.
        bridge.setFile(
            `${AGENT}/skills/a/SKILL.md`,
            skillMd('shared', 'A', 'A'),
        )
        bridge.setFile(
            `${REPO}/.cpa/skills/b/SKILL.md`,
            skillMd('shared', 'B', 'B'),
        )
        bridge.setFile(
            `${AGENT}/skills/c/SKILL.md`,
            skillMd('other', 'C', 'C'),
        )
        bridge.setFile(
            `${REPO}/.cpa/skills/d/SKILL.md`,
            skillMd('other', 'D', 'D'),
        )
        bridge.setFile(`${AGENT}/prompts/t.md`, '---\ndescription: T\n---\nT\n')
        bridge.setFile(`${REPO}/.cpa/prompts/t.md`, '---\ndescription: T2\n---\nT2\n')
        bridge.setFile(`${AGENT}/prompts/u.md`, '---\ndescription: U\n---\nU\n')
        bridge.setFile(`${REPO}/.cpa/prompts/u.md`, '---\ndescription: U2\n---\nU2\n')

        const original = String.prototype.localeCompare
        // eslint-disable-next-line no-extend-native
        String.prototype.localeCompare = function localeCompareBroken() {
            return 1
        }
        try {
            const snapshot = await loadResourcesFromProviders({
                cwd: REPO,
                agentDir: AGENT,
                bridge,
                tools: [{ name: 'read', description: 'Read' }],
            })
            const collisions = snapshot.diagnostics.filter((d) => d.type === 'collision')
            expect(collisions.length).toBeGreaterThanOrEqual(4)
            // Total order must be stable under broken localeCompare.
            const keys = collisions.map(
                (d) =>
                    [
                        d.type,
                        d.resourceType ?? '',
                        d.path ?? '',
                        d.message,
                        d.collision?.name ?? '',
                        d.collision?.winnerPath ?? '',
                        d.collision?.loserPath ?? '',
                    ].join('|'),
            )
            const sorted = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
            expect(keys).toEqual(sorted)
        } finally {
            // eslint-disable-next-line no-extend-native
            String.prototype.localeCompare = original
        }
    })

    it('passes language into systemPrompt when language is provided', async () => {
        const bridge = new FakeNativeBridge()
        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            tools: [{ name: 'read', description: 'Read' }],
            language: 'zh-CN',
        })
        expect(snapshot.systemPrompt).toContain(
            '- Respond in Simplified Chinese by default unless the user requests otherwise',
        )
    })

    it('passes personality into systemPrompt when personality is provided', async () => {
        const bridge = new FakeNativeBridge()
        bridge.setFile(`${REPO}/AGENTS.md`, 'repo agents')

        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            tools: [{ name: 'read', description: 'Read' }],
            personality: 'humorous',
        })

        expect(snapshot.systemPrompt).toContain(
            '- Maintain a witty, lighthearted, and subtly humorous tone when appropriate, while remaining helpful and accurate.',
        )
    })

    it('loads instructions, skills, and prompts from ~/.coding-professional-agent/ when homeDir is provided', async () => {
        const bridge = new FakeNativeBridge()
        const homeDir = '/home/alice'
        bridge.setFile(`${homeDir}/.coding-professional-agent/AGENTS.md`, 'home agents')
        bridge.setFile(
            `${homeDir}/.coding-professional-agent/skills/home-skill/SKILL.md`,
            skillMd('home-skill', 'Home skill', 'BODY'),
        )
        bridge.setFile(
            `${homeDir}/.coding-professional-agent/prompts/home-prompt.md`,
            '---\ndescription: Home prompt\n---\nHome prompt content\n',
        )
        bridge.setFile(`${REPO}/AGENTS.md`, 'repo agents')

        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            homeDir,
            bridge,
            tools: [{ name: 'read', description: 'Read' }],
        })

        expect(snapshot.contextFiles.map((f) => f.path)).toEqual([
            `${homeDir}/.coding-professional-agent/AGENTS.md`,
            `${REPO}/AGENTS.md`,
        ])
        expect(snapshot.skills.map((s) => s.name)).toEqual(['home-skill'])
        expect(snapshot.prompts.map((p) => p.name)).toEqual(['home-prompt'])
    })

    it('injects read-path memory instructions when memory provider is registered in ExtensionRegistry', async () => {
        const bridge = new FakeNativeBridge()
        const homeDir = '/home/alice'
        const registry = new ExtensionRegistry()
        activateResources(registry)
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
                            content: `## Memory\n\n${text}\n<oai-mem-citation>`,
                            order: 15,
                        },
                    ]
                } catch {
                    return []
                }
            },
        })
        bridge.setFile(
            `${homeDir}/.coding-professional-agent/memories/memory_summary.md`,
            'User prefers dark mode and Jest over Vitest.',
        )

        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            homeDir,
            bridge,
            extensionRegistry: registry,
            tools: [{ name: 'read', description: 'Read' }],
        })

        expect(snapshot.systemPrompt).toContain('## Memory')
        expect(snapshot.systemPrompt).toContain('User prefers dark mode and Jest over Vitest.')
        expect(snapshot.systemPrompt).toContain('<oai-mem-citation>')
    })

    it('omits read-path memory instructions when localMemoryEnabled is false', async () => {
        const bridge = new FakeNativeBridge()
        const homeDir = '/home/alice'
        const registry = new ExtensionRegistry()
        activateResources(registry)
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
                            content: `## Memory\n\n${text}\n<oai-mem-citation>`,
                            order: 15,
                        },
                    ]
                } catch {
                    return []
                }
            },
        })
        bridge.setFile(
            `${homeDir}/.coding-professional-agent/memories/memory_summary.md`,
            'User prefers dark mode.',
        )

        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            homeDir,
            bridge,
            extensionRegistry: registry,
            tools: [{ name: 'read', description: 'Read' }],
            localMemoryEnabled: false,
        })

        expect(snapshot.systemPrompt).not.toContain('## Memory')
        expect(snapshot.systemPrompt).not.toContain('User prefers dark mode.')
    })

    it('combines APPEND_SYSTEM and memory instructions properly', async () => {
        const bridge = new FakeNativeBridge()
        const homeDir = '/home/alice'
        const registry = new ExtensionRegistry()
        activateResources(registry)
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
        bridge.setFile(`${AGENT}/APPEND_SYSTEM.md`, 'CUSTOM APPEND CONTENT')
        bridge.setFile(
            `${homeDir}/.coding-professional-agent/memories/memory_summary.md`,
            'Memory facts.',
        )

        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            homeDir,
            bridge,
            extensionRegistry: registry,
            tools: [{ name: 'read', description: 'Read' }],
        })

        expect(snapshot.systemPrompt).toContain('CUSTOM APPEND CONTENT')
        expect(snapshot.systemPrompt).toContain('## Memory')
        expect(snapshot.systemPrompt).toContain('Memory facts.')
        expect(snapshot.systemPrompt.indexOf('CUSTOM APPEND CONTENT')).toBeLessThan(
            snapshot.systemPrompt.indexOf('## Memory'),
        )
    })

    it('injects main-targeted and shared system prompts from ExtensionRegistry into systemPrompt', async () => {
        const bridge = new FakeNativeBridge()
        const registry = new ExtensionRegistry()
        activateResources(registry)
        registry.registerSystemPrompt({
            id: 'main-guardrail',
            guideline: 'Always verify before code change',
            targetAgent: 'main',
        })
        registry.registerSystemPrompt({
            id: 'shared-guardrail',
            guideline: 'Keep security tokens secret',
            targetAgent: 'all',
        })
        registry.registerSystemPrompt({
            id: 'subagent-only-guardrail',
            guideline: 'Subagents must report final status',
            targetAgent: 'subagent',
        })
        registry.registerSystemPrompt({
            id: 'main-content-block',
            content: '[MAIN-POLICY: Single active run]',
            targetAgent: 'main',
        })

        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge,
            tools: [{ name: 'read', description: 'Read' }],
            extensionRegistry: registry,
        })

        expect(snapshot.systemPrompt).toContain('Always verify before code change')
        expect(snapshot.systemPrompt).toContain('Keep security tokens secret')
        expect(snapshot.systemPrompt).toContain('[MAIN-POLICY: Single active run]')
        expect(snapshot.systemPrompt).not.toContain('Subagents must report final status')
    })

    it('appends worktree mode instructions after project paths', async () => {
        const bridge = new FakeNativeBridge()
        const policy = {
            worktreePath: '/worktrees/repo-session',
            sourceTreePath: '/projects/repo',
        }
        const snapshot = await loadResourcesFromProviders({
            cwd: policy.worktreePath,
            projectPaths: [policy.worktreePath],
            worktreePolicy: policy,
            agentDir: AGENT,
            bridge,
            tools: [{ name: 'read', description: 'Read' }],
        })

        expect(snapshot.systemPrompt).toContain(formatWorktreeModePrompt(policy))
        expect(snapshot.systemPrompt.indexOf('<worktree_mode>')).toBeGreaterThan(
            snapshot.systemPrompt.indexOf('Allowed project paths:'),
        )
    })

    it('does not append worktree mode instructions for local runs', async () => {
        const snapshot = await loadResourcesFromProviders({
            cwd: REPO,
            agentDir: AGENT,
            bridge: new FakeNativeBridge(),
            tools: [{ name: 'read', description: 'Read' }],
        })
        expect(snapshot.systemPrompt).not.toContain('<worktree_mode>')
    })
})

type SkillMut = {
    name: string
    description: string
    filePath: string
    baseDir: string
    disableModelInvocation: boolean
    body: string
}
