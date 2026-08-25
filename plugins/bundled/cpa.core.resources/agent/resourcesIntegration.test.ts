import { describe, expect, it } from 'vitest'
import { ContributionRegistry } from '@cpa/plugin-kernel'
import { resourcesAgentEntry } from './index.js'
import { FakeNativeBridge } from './testUtils.js'
import type { ResourceProvider } from '@cpa/plugin-api'

describe('cpa.core.resources integration', () => {
    it('registers contributions in ContributionRegistry', async () => {
        const registry = new ContributionRegistry()
        const tx = registry.beginActivation({ id: 'cpa.core.resources', name: 'Resource Provider', version: '1.0.0' })
        const pluginContext = {
            register: (contrib: any) => {
                tx.register(contrib.kind, contrib.id, contrib.value, {
                    target: contrib.target,
                    priority: contrib.priority,
                })
            },
            getService: () => undefined,
        }

        resourcesAgentEntry.activate(pluginContext as any)
        tx.commit()

        const providers = registry.list<ResourceProvider<any>>('resource-provider')
        expect(providers.map((p) => p.id).sort()).toEqual([
            'cpa.core.context',
            'cpa.core.prompt-templates',
            'cpa.core.skills',
        ])
    })

    it('loads and orders resources through ContributionRegistry', async () => {
        const registry = new ContributionRegistry()
        const tx = registry.beginActivation({ id: 'cpa.core.resources', name: 'Resource Provider', version: '1.0.0' })
        const pluginContext = {
            register: (contrib: any) => {
                tx.register(contrib.kind, contrib.id, contrib.value, {
                    target: contrib.target,
                    priority: contrib.priority,
                })
            },
            getService: () => undefined,
        }

        resourcesAgentEntry.activate(pluginContext as any)
        tx.commit()

        const bridge = new FakeNativeBridge()
        bridge.setFile('/config/agent/AGENTS.md', 'global instructions')
        bridge.setFile('/workspace/AGENTS.md', 'workspace instructions')

        const providerInput = {
            cwd: '/workspace',
            agentDir: '/config/agent',
            bridge,
            agentTarget: 'main' as const,
        }

        const providers = registry.list<ResourceProvider<any>>('resource-provider')
        const sorted = [...providers].sort((a, b) => a.value.order - b.value.order)

        expect(sorted.map((p) => p.value.id)).toEqual([
            'cpa.core.context',
            'cpa.core.skills',
            'cpa.core.prompt-templates',
        ])

        const contextProv = sorted[0].value
        const contextOutput = await contextProv.load(providerInput)
        expect(contextOutput[0].files.length).toBe(2)
    })
})
