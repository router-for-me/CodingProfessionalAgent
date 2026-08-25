import { describe, expect, it, vi } from 'vitest'
import type { PluginCapabilityClient, AgentToolContribution, ToolExecutionContext } from '@cpa/plugin-api'
import { createCapabilityNativeAdapter, adaptPluginToolToAgentTool } from './agentAdapter.js'

describe('createCapabilityNativeAdapter', () => {
    it('maps filesystem and OS operations to capabilities.invoke', async () => {
        const calls: Array<{ method: string; args: unknown[] }> = []
        const client: PluginCapabilityClient = {
            has: () => true,
            invoke: async (method: string, args: unknown[] = []) => {
                calls.push({ method, args })
                if (method === 'native:stat') {
                    return { isDir: false, isFile: true, sizeBytes: 42 }
                }
                if (method === 'native:readFile') {
                    // Returns base64 encoded 'hello world'
                    return { dataBase64: Buffer.from('hello world').toString('base64') }
                }
                if (method === 'native:readFileIfExists') {
                    return { dataBase64: Buffer.from('exists').toString('base64') }
                }
                if (method === 'native:readDir') {
                    return [{ name: 'file.txt', isDir: false, isFile: true }]
                }
                if (method === 'native:realPath') {
                    return '/real/path/file.txt'
                }
                if (method === 'native:lookPath') {
                    return '/usr/bin/node'
                }
                if (method === 'native:runtimeInfo') {
                    return { platform: 'darwin', homeDir: '/home/user', userConfigDir: '/cfg', tempDir: '/tmp' }
                }
                return undefined
            },
            subscribe: () => () => {},
        }

        const adapter = createCapabilityNativeAdapter(client)

        const stat = await adapter.stat('/path/file.txt')
        expect(stat.sizeBytes).toBe(42)
        expect(calls[0]).toEqual({ method: 'native:stat', args: ['/path/file.txt'] })

        const fileBytes = await adapter.readFile('/path/file.txt')
        expect(new TextDecoder().decode(fileBytes)).toBe('hello world')
        expect(calls[1]).toEqual({ method: 'native:readFile', args: ['/path/file.txt'] })

        const existsBytes = await adapter.readFileIfExists('/path/file.txt')
        expect(new TextDecoder().decode(existsBytes!)).toBe('exists')

        await adapter.writeFile('/path/out.txt', new TextEncoder().encode('written'))
        expect(calls.some((c) => c.method === 'native:writeFile')).toBe(true)

        await adapter.mkdirAll('/path/dir')
        expect(calls.some((c) => c.method === 'native:mkdirAll')).toBe(true)

        const dir = await adapter.readDir('/path')
        expect(dir[0].name).toBe('file.txt')

        const real = await adapter.realPath('/path/link')
        expect(real).toBe('/real/path/file.txt')

        const look = await adapter.lookPath('node')
        expect(look).toBe('/usr/bin/node')

        const info = await adapter.runtimeInfo()
        expect(info.platform).toBe('darwin')
    })

    it('startProcess uses native:runProcess and synthesizes terminal events', async () => {
        const calls: Array<{ method: string; args: unknown[] }> = []
        const client: PluginCapabilityClient = {
            has: () => true,
            invoke: async (method: string, args: unknown[] = []) => {
                calls.push({ method, args })
                if (method === 'native:runProcess') {
                    return {
                        fullOutputPath: '/tmp/out.log',
                        stdoutBase64: Buffer.from('hello-hook').toString('base64'),
                        stderrBase64: '',
                        exitCode: 0,
                    }
                }
                return undefined
            },
            subscribe: () => {
                throw new Error('subscribe should not be required for startProcess')
            },
        }

        const adapter = createCapabilityNativeAdapter(client)
        const op = await adapter.startProcess!({
            operationId: 'hook_cmd_1',
            executable: 'echo',
            args: ['TEST'],
            cwd: '/tmp',
        })

        expect(calls.some((c) => c.method === 'native:runProcess')).toBe(true)
        expect(calls.some((c) => c.method === 'native:startProcess')).toBe(false)
        expect(op.operationId).toBe('hook_cmd_1')
        expect(op.fullOutputPath).toBe('/tmp/out.log')

        const events: any[] = []
        for await (const event of op.events) {
            events.push(event)
        }

        expect(events.some((e) => e.kind === 'process-stdout')).toBe(true)
        expect(events.some((e) => e.kind === 'done' && e.exitCode === 0)).toBe(true)
    })

    it('startProcess cancels native:runProcess when abort signal fires', async () => {
        const calls: Array<{ method: string; args: unknown[] }> = []
        let resolveRun: ((value: unknown) => void) | null = null
        const controller = new AbortController()

        const client: PluginCapabilityClient = {
            has: () => true,
            invoke: async (method: string, args: unknown[] = []) => {
                calls.push({ method, args })
                if (method === 'native:runProcess') {
                    return await new Promise((resolve) => {
                        resolveRun = resolve
                    })
                }
                return undefined
            },
            subscribe: () => () => {},
        }

        const adapter = createCapabilityNativeAdapter(client)
        const pending = adapter.startProcess!({
            operationId: 'hook_cmd_abort',
            executable: 'sleep',
            args: ['10'],
            cwd: '/tmp',
            signal: controller.signal,
        })

        await new Promise((resolve) => setTimeout(resolve, 10))
        controller.abort()
        expect(calls.some((c) => c.method === 'native:cancelOperation')).toBe(true)

        resolveRun?.({
            fullOutputPath: '/tmp/out.log',
            stdoutBase64: '',
            stderrBase64: '',
            exitCode: 130,
            cancelled: true,
        })

        const op = await pending
        const events: any[] = []
        for await (const event of op.events) {
            events.push(event)
        }
        expect(events.some((e) => e.kind === 'cancelled')).toBe(true)
    })
})

describe('adaptPluginToolToAgentTool', () => {
    it('forwards execution, passes onUpdate, and preserves metadata', async () => {
        let updateReceived: any = null
        const contrib: AgentToolContribution = {
            name: 'custom_tool',
            description: 'A test tool',
            parameters: { type: 'object', properties: { q: { type: 'string' } } },
            execute: async (args: any, ctx: any) => {
                if (ctx.onUpdate) {
                    ctx.onUpdate({ content: [{ type: 'text', text: 'in-progress' }] })
                }
                return `result for ${args.q}`
            },
        }

        const tool = adaptPluginToolToAgentTool(contrib)
        expect(tool.name).toBe('custom_tool')
        expect(tool.description).toBe('A test tool')

        const execCtx: ToolExecutionContext = {
            onUpdate: (partial) => {
                updateReceived = partial
            },
        }

        const result = await tool.execute('call_1', { q: 'test-query' }, execCtx)
        expect(updateReceived).toEqual({ content: [{ type: 'text', text: 'in-progress' }] })
        expect(result.content[0].text).toBe('result for test-query')
        expect(result.isError).toBe(false)
    })

    it('directly throws AbortError when execution is aborted', async () => {
        const controller = new AbortController()
        controller.abort()

        const contrib: AgentToolContribution = {
            name: 'aborted_tool',
            description: 'abort tool',
            parameters: {},
            execute: async (_args: any, ctx: any) => {
                if (ctx.signal?.aborted) {
                    const err = new Error('Operation was aborted')
                    err.name = 'AbortError'
                    throw err
                }
                return 'ok'
            },
        }

        const tool = adaptPluginToolToAgentTool(contrib)
        await expect(
            tool.execute('call_2', {}, { signal: controller.signal }),
        ).rejects.toThrow(/aborted/i)
    })

    it('formats normal errors into ToolResult with isError=true', async () => {
        const contrib: AgentToolContribution = {
            name: 'failing_tool',
            description: 'failing tool',
            parameters: {},
            execute: async () => {
                throw new Error('Normal failure message')
            },
        }

        const tool = adaptPluginToolToAgentTool(contrib)
        const result = await tool.execute('call_3', {}, {})
        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain('Normal failure message')
    })
})
