import { describe, expect, it } from 'vitest'
import type { ToolFactoryContribution, PluginContext } from '@cpa/plugin-api'
import { toolsAgentEntry } from './index.js'
import { FakeNativeBridge } from './testUtils.js'

describe('cpa.core.tools agent entry', () => {
    it('activates and registers read, shell, edit, write tool factories', async () => {
        const registered = new Map<string, ToolFactoryContribution>()
        const fakeContext: Partial<PluginContext> = {
            register: ((contrib: any) => {
                if (contrib.kind === 'tool-factory') {
                    registered.set(contrib.id, contrib.value)
                }
            }) as any,
        }

        toolsAgentEntry.activate(fakeContext as PluginContext)

        expect(registered.has('read')).toBe(true)
        expect(registered.has('shell')).toBe(true)
        expect(registered.has('edit')).toBe(true)
        expect(registered.has('write')).toBe(true)

        // Read factory metadata
        const readContrib = registered.get('read')!
        expect(readContrib.order).toBe(10)
        expect(readContrib.riskLevel).toBe('read')
        expect(readContrib.requiresApproval).toBe(false)
        expect(readContrib.approvalCategory).toBe('filesystem-read')

        // Shell factory metadata
        const shellContrib = registered.get('shell')!
        expect(shellContrib.order).toBe(20)
        expect(shellContrib.riskLevel).toBe('process')
        expect(shellContrib.requiresApproval).toBe(true)
        expect(shellContrib.approvalCategory).toBe('shell-execution')
        expect(shellContrib.aliases).toContain('pwsh')
        expect(shellContrib.aliases).toContain('bash')

        // Edit factory metadata
        const editContrib = registered.get('edit')!
        expect(editContrib.order).toBe(30)
        expect(editContrib.riskLevel).toBe('write')
        expect(editContrib.requiresApproval).toBe(true)
        expect(editContrib.approvalCategory).toBe('filesystem-write')

        // Write factory metadata
        const writeContrib = registered.get('write')!
        expect(writeContrib.order).toBe(40)
        expect(writeContrib.riskLevel).toBe('write')
        expect(writeContrib.requiresApproval).toBe(true)
        expect(writeContrib.approvalCategory).toBe('filesystem-write')
    })

    it('creates functional tools from factory contributions', async () => {
        const registered = new Map<string, ToolFactoryContribution>()
        const fakeContext: Partial<PluginContext> = {
            register: ((contrib: any) => {
                if (contrib.kind === 'tool-factory') {
                    registered.set(contrib.id, contrib.value)
                }
            }) as any,
        }
        toolsAgentEntry.activate(fakeContext as PluginContext)

        const bridge = new FakeNativeBridge()
        bridge.setFile('/workspace/hello.txt', 'Hello Universal Tools!')

        const factoryCtx = {
            cwd: '/workspace',
            bridge,
            platform: 'darwin' as const,
            services: {} as any,
        }

        const readTool = await registered.get('read')!.create(factoryCtx)
        expect(readTool.name).toBe('read')
        const readRes = await readTool.execute('r1', { path: 'hello.txt' }, { cwd: '/workspace' })
        expect(readRes.content[0].text).toBe('Hello Universal Tools!')

        const writeTool = await registered.get('write')!.create(factoryCtx)
        expect(writeTool.name).toBe('write')
        await writeTool.execute('w1', { path: 'new.txt', content: 'created by tool' }, { cwd: '/workspace' })
        expect(new TextDecoder().decode(await bridge.readFile('/workspace/new.txt'))).toBe('created by tool')

        const editTool = await registered.get('edit')!.create(factoryCtx)
        expect(editTool.name).toBe('edit')
        await editTool.execute('e1', { path: 'new.txt', edits: [{ oldText: 'created', newText: 'modified' }] }, { cwd: '/workspace' })
        expect(new TextDecoder().decode(await bridge.readFile('/workspace/new.txt'))).toBe('modified by tool')
    })
})
