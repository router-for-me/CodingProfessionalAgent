import { describe, expect, it, vi } from 'vitest'
import {
    PluginCapabilityError,
    PluginValidationError,
    type CapabilityHandle,
    type CapabilityInvokeResponse,
} from '@cpa/plugin-api'
import { RendererCapabilityClient } from './RendererCapabilityClient.js'

describe('RendererCapabilityClient', () => {
    const fakeHandle = 'cap_test_handle_12345' as CapabilityHandle

    it('checks granted capabilities using has()', () => {
        const client = new RendererCapabilityClient({
            handle: fakeHandle,
            manifest: {
                id: 'test-plugin',
                name: 'Test Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                entries: {},
                dependencies: {},
                capabilities: ['filesystem.read', 'sessions.*'],
                contributes: {},
            },
            transport: vi.fn(),
        })

        expect(client.has('filesystem.read')).toBe(true)
        expect(client.has('sessions.create')).toBe(true)
        expect(client.has('sessions.list')).toBe(true)
        expect(client.has('filesystem.write')).toBe(false)
        expect(client.has('system.clipboard')).toBe(false)
    })

    it('manages event subscriptions through subscribe() and cleanup', () => {
        const unsubMock = vi.fn()
        const subscribeTransport = vi.fn().mockReturnValue(unsubMock)
        const client = new RendererCapabilityClient({
            handle: fakeHandle,
            transport: vi.fn(),
            subscribe: subscribeTransport,
        })

        const listener = vi.fn()
        const unsub = client.subscribe('test:event', listener)

        expect(subscribeTransport).toHaveBeenCalledWith(fakeHandle, 'test:event', listener)
        unsub()
        expect(unsubMock).toHaveBeenCalled()
    })

    it('invokes method through transport bridge with handle and arguments', async () => {
        const transport = vi.fn().mockResolvedValue({ ok: true, value: { data: 'hello' } })
        const client = new RendererCapabilityClient({
            handle: fakeHandle,
            transport,
        })

        const result = await client.invoke('filesystem.readFile', ['/tmp/hello.txt'])

        expect(transport).toHaveBeenCalledWith(fakeHandle, 'filesystem.readFile', ['/tmp/hello.txt'])
        expect(result).toEqual({ data: 'hello' })
    })

    it('unwraps raw value when transport returns direct value without wrapper', async () => {
        const transport = vi.fn().mockResolvedValue('direct-result')
        const client = new RendererCapabilityClient({
            handle: fakeHandle,
            transport,
        })

        const result = await client.invoke('test.method', [])
        expect(result).toBe('direct-result')
    })

    it('deserializes PluginCapabilityError DTO and throws typed error', async () => {
        const errorResponse: CapabilityInvokeResponse = {
            ok: false,
            error: {
                name: 'PluginCapabilityError',
                message: 'Plugin reader lacks capability filesystem.write',
                code: 'PLUGIN_CAPABILITY_ERROR',
                pluginId: 'reader',
            },
        }
        const transport = vi.fn().mockResolvedValue(errorResponse)
        const client = new RendererCapabilityClient({
            handle: fakeHandle,
            transport,
        })

        const promise = client.invoke('filesystem.writeFile', ['/tmp/a', 'content'])
        await expect(promise).rejects.toThrow('Plugin reader lacks capability filesystem.write')
        await expect(promise).rejects.toBeInstanceOf(PluginCapabilityError)
    })

    it('deserializes PluginValidationError DTO and retains validationErrors', async () => {
        const errorResponse: CapabilityInvokeResponse = {
            ok: false,
            error: {
                name: 'PluginValidationError',
                message: 'Invalid arguments',
                code: 'PLUGIN_VALIDATION_ERROR',
                pluginId: 'writer',
                validationErrors: ['Argument 0 must be string', 'Argument 1 must be string'],
            },
        }
        const transport = vi.fn().mockResolvedValue(errorResponse)
        const client = new RendererCapabilityClient({
            handle: fakeHandle,
            transport,
        })

        try {
            await client.invoke('filesystem.writeFile', [123, 456])
            expect.unreachable('Should have thrown')
        } catch (err: any) {
            expect(err).toBeInstanceOf(PluginValidationError)
            expect(err.message).toBe('Invalid arguments')
            expect(err.validationErrors).toEqual(['Argument 0 must be string', 'Argument 1 must be string'])
        }
    })

    it('deserializes generic Error DTO', async () => {
        const errorResponse: CapabilityInvokeResponse = {
            ok: false,
            error: {
                name: 'Error',
                message: 'Something went wrong on the host',
            },
        }
        const transport = vi.fn().mockResolvedValue(errorResponse)
        const client = new RendererCapabilityClient({
            handle: fakeHandle,
            transport,
        })

        await expect(client.invoke('fail.method', [])).rejects.toThrow('Something went wrong on the host')
    })

    it('propagates transport rejection directly', async () => {
        const transport = vi.fn().mockRejectedValue(new Error('Network bridge failure'))
        const client = new RendererCapabilityClient({
            handle: fakeHandle,
            transport,
        })

        await expect(client.invoke('some.method', [])).rejects.toThrow('Network bridge failure')
    })

    it('exposes the bound handle via getHandle()', () => {
        const transport = vi.fn()
        const client = new RendererCapabilityClient({
            handle: fakeHandle,
            transport,
        })

        expect(client.getHandle()).toBe(fakeHandle)
    })
})
