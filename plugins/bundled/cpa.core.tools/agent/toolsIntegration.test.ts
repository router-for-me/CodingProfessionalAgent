import { describe, expect, it } from 'vitest'
import { ContributionRegistry } from '@cpa/plugin-kernel'
import { toolsAgentEntry } from './index.js'
import { FakeNativeBridge } from './testUtils.js'
import type { ToolFactoryContribution } from '@cpa/plugin-api'

describe('cpa.core.tools integration', () => {
    it('registers contributions in ContributionRegistry', async () => {
        const registry = new ContributionRegistry()
        const tx = registry.beginActivation({ id: 'cpa.core.tools', name: 'Built-in Tools', version: '1.0.0' })
        const pluginContext = {
            register: (contrib: any) => {
                tx.register(contrib.kind, contrib.id, contrib.value, {
                    target: contrib.target,
                    priority: contrib.priority,
                })
            },
            getService: () => undefined,
        }

        toolsAgentEntry.activate(pluginContext as any)
        tx.commit()

        const factories = registry.list<ToolFactoryContribution>('tool-factory')
        expect(factories.map((f) => f.id).sort()).toEqual(['edit', 'read', 'shell', 'write'])
    })

    it('executes read -> edit -> write lifecycle through registered contributions', async () => {
        const registry = new ContributionRegistry()
        const tx = registry.beginActivation({ id: 'cpa.core.tools', name: 'Built-in Tools', version: '1.0.0' })
        const pluginContext = {
            register: (contrib: any) => {
                tx.register(contrib.kind, contrib.id, contrib.value, {
                    target: contrib.target,
                    priority: contrib.priority,
                })
            },
            getService: () => undefined,
        }

        toolsAgentEntry.activate(pluginContext as any)
        tx.commit()

        const bridge = new FakeNativeBridge()
        const factoryCtx = {
            cwd: '/workspace',
            bridge,
            platform: 'darwin' as const,
            services: {} as any,
        }

        const factories = registry.list<ToolFactoryContribution>('tool-factory')
        const writeFactory = factories.find((f) => f.id === 'write')!
        const readFactory = factories.find((f) => f.id === 'read')!
        const editFactory = factories.find((f) => f.id === 'edit')!

        const writeTool = await writeFactory.value.create(factoryCtx)
        const readTool = await readFactory.value.create(factoryCtx)
        const editTool = await editFactory.value.create(factoryCtx)

        // 1. Write initial file
        await writeTool.execute('call-1', { path: 'doc.md', content: '# Initial Header\nInitial Body\n' }, { cwd: '/workspace' })

        // 2. Read file
        const readRes1 = await readTool.execute('call-2', { path: 'doc.md' }, { cwd: '/workspace' })
        expect(readRes1.content[0].text).toContain('# Initial Header')

        // 3. Edit file
        await editTool.execute(
            'call-3',
            { path: 'doc.md', edits: [{ oldText: 'Initial Body', newText: 'Updated Content' }] },
            { cwd: '/workspace' },
        )

        // 4. Read updated file
        const readRes2 = await readTool.execute('call-4', { path: 'doc.md' }, { cwd: '/workspace' })
        expect(readRes2.content[0].text).toContain('Updated Content')
    })
})
