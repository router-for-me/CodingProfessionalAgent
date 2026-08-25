import { describe, expect, it } from 'vitest'
import type { ResourceProvider, PluginContext } from '@cpa/plugin-api'
import { resourcesAgentEntry } from './index.js'
import { FakeNativeBridge } from './testUtils.js'

describe('cpa.core.resources agent entry', () => {
    it('activates and registers context, skills, and prompt-templates resource providers', async () => {
        const registered = new Map<string, ResourceProvider<any>>()
        const fakeContext: Partial<PluginContext> = {
            register: ((contrib: any) => {
                if (contrib.kind === 'resource-provider') {
                    registered.set(contrib.id, contrib.value)
                }
            }) as any,
        }

        resourcesAgentEntry.activate(fakeContext as PluginContext)

        expect(registered.has('cpa.core.context')).toBe(true)
        expect(registered.has('cpa.core.skills')).toBe(true)
        expect(registered.has('cpa.core.prompt-templates')).toBe(true)

        // Context provider metadata
        const contextProv = registered.get('cpa.core.context')!
        expect(contextProv.kind).toBe('context')
        expect(contextProv.order).toBe(10)
        expect(contextProv.targetAgent).toBe('all')

        // Skills provider metadata
        const skillsProv = registered.get('cpa.core.skills')!
        expect(skillsProv.kind).toBe('skill')
        expect(skillsProv.order).toBe(20)
        expect(skillsProv.targetAgent).toBe('all')

        // Prompt templates provider metadata
        const promptsProv = registered.get('cpa.core.prompt-templates')!
        expect(promptsProv.kind).toBe('prompt-template')
        expect(promptsProv.order).toBe(30)
        expect(promptsProv.targetAgent).toBe('all')
    })

    it('loads resources through registered provider load functions', async () => {
        const registered = new Map<string, ResourceProvider<any>>()
        const fakeContext: Partial<PluginContext> = {
            register: ((contrib: any) => {
                if (contrib.kind === 'resource-provider') {
                    registered.set(contrib.id, contrib.value)
                }
            }) as any,
        }
        resourcesAgentEntry.activate(fakeContext as PluginContext)

        const bridge = new FakeNativeBridge()
        bridge.setFile('/config/agent/AGENTS.md', 'global instructions')
        bridge.setFile('/workspace/AGENTS.md', 'workspace instructions')
        bridge.setFile(
            '/config/agent/skills/test-skill/SKILL.md',
            '---\nname: test-skill\ndescription: A test skill\n---\nSkill content\n',
        )
        bridge.setFile(
            '/config/agent/prompts/test-prompt.md',
            '---\ndescription: A test prompt\n---\nPrompt content $1\n',
        )

        const providerInput = {
            cwd: '/workspace',
            agentDir: '/config/agent',
            bridge,
            agentTarget: 'main' as const,
        }

        // Test context provider
        const contextRes = await registered.get('cpa.core.context')!.load(providerInput)
        expect(contextRes).toHaveLength(1)
        expect((contextRes[0] as any).files.map((f: any) => f.path)).toContain('/config/agent/AGENTS.md')
        expect((contextRes[0] as any).files.map((f: any) => f.path)).toContain('/workspace/AGENTS.md')

        // Test skills provider
        const skillsRes = await registered.get('cpa.core.skills')!.load(providerInput)
        expect(skillsRes).toHaveLength(1)
        expect((skillsRes[0] as any).skills.map((s: any) => s.name)).toContain('test-skill')

        // Test prompt-templates provider
        const promptsRes = await registered.get('cpa.core.prompt-templates')!.load(providerInput)
        expect(promptsRes).toHaveLength(1)
        expect((promptsRes[0] as any).prompts.map((p: any) => p.name)).toContain('test-prompt')
    })
})
