import { describe, expect, it } from 'vitest'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import type { ToolFactoryContribution } from '@cpa/plugin-api'
import { subagentAgentEntry } from './index.js'

describe('subagentAgentEntry', () => {
    it('defines an authoritative agent entry for cpa.core.subagent', () => {
        expect(subagentAgentEntry.runtime).toBe('agent')
        expect(typeof subagentAgentEntry.activate).toBe('function')
    })

    it('registers tool factories for spawn_agent, send_message, and stop_agent', async () => {
        const harness = createPluginTestHarness(subagentAgentEntry, {
            manifest: {
                id: 'cpa.core.subagent',
                name: 'Subagents',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                entries: {
                    renderer: './renderer/index.tsx',
                    agent: './agent/index.ts',
                },
                dependencies: { 'cpa.core.chat': '>=1.0.0' },
                capabilities: ['agent.subagents', 'sessions.read'],
                contributes: {
                    'tool-factory': ['spawn_agent', 'send_message', 'stop_agent'],
                },
            },
        })

        await harness.activate()

        const toolFactories = harness.getRegistered<ToolFactoryContribution>('tool-factory')
        expect(toolFactories).toHaveLength(3)

        const factoryIds = toolFactories.map((tf) => tf.id).sort()
        expect(factoryIds).toEqual(['send_message', 'spawn_agent', 'stop_agent'])

        const spawnFactory = toolFactories.find((tf) => tf.id === 'spawn_agent')
        expect(spawnFactory?.value.approvalCategory).toBe('subagent-lifecycle')
        expect(spawnFactory?.value.targets).toEqual(['main'])
    })
})
