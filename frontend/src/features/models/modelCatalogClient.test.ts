import { describe, expect, it, vi } from 'vitest'
import type { HttpRequest, HttpResponse } from './types'
import { fetchModelCatalog } from './modelCatalogClient'

const successResponse = (body: string): HttpResponse => ({
    status: 200,
    headers: { 'Content-Type': ['application/json'] },
    body,
})

describe('model catalog client', () => {
    it('requests the CPA catalog with frontend-owned auth and timeout', async () => {
        const request = vi.fn(async (input: HttpRequest): Promise<HttpResponse> => {
            expect(input).toBeDefined()
            return successResponse(JSON.stringify({ data: [{ id: 'model-1' }] }))
        })

        await fetchModelCatalog(
            { baseUrl: 'http://127.0.0.1:8317', apiKey: 'secret' },
            { request },
        )

        expect(request).toHaveBeenCalledWith({
            url: 'http://127.0.0.1:8317/v1/models?client_version=cpa',
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: 'Bearer secret',
            },
            body: '',
            timeoutMs: 60_000,
        })
    })

    it('rejects empty configuration without calling the transport', async () => {
        const request = vi.fn()

        await expect(fetchModelCatalog({ baseUrl: '', apiKey: 'secret' }, { request })).rejects.toThrow(
            /configuration/i,
        )
        await expect(fetchModelCatalog({ baseUrl: 'http://localhost', apiKey: '  ' }, { request })).rejects.toThrow(
            /configuration/i,
        )
        expect(request).not.toHaveBeenCalled()
    })

    it('rejects non-success responses without exposing response content or the API key', async () => {
        const request = vi.fn(async () => ({
            status: 503,
            headers: {},
            body: 'secret response body',
        }))

        const error = await fetchModelCatalog(
            { baseUrl: 'http://localhost', apiKey: 'secret-key' },
            { request },
        ).catch((value: unknown) => value as Error) as Error

        expect(error).toBeInstanceOf(Error)
        expect(error.message).toContain('503')
        expect(error.message).not.toContain('secret')
        expect(error.message).not.toContain('response body')
    })

    it('rejects invalid JSON and invalid response shapes without exposing the body', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce(successResponse('{invalid-json'))
            .mockResolvedValueOnce(successResponse(JSON.stringify({ unexpected: true })))

        await expect(fetchModelCatalog({ baseUrl: 'http://localhost', apiKey: 'secret' }, { request })).rejects.toThrow(
            /json/i,
        )
        await expect(fetchModelCatalog({ baseUrl: 'http://localhost', apiKey: 'secret' }, { request })).rejects.toThrow(
            /format|shape|invalid/i,
        )
    })

    it('wraps transport errors without leaking their message or the API key', async () => {
        const request = vi.fn().mockRejectedValue(new Error('secret-key leaked by transport'))

        const error = await fetchModelCatalog(
            { baseUrl: 'http://localhost', apiKey: 'secret-key' },
            { request },
        ).catch((value: unknown) => value as Error) as Error

        expect(error.message).toMatch(/request/i)
        expect(error.message).not.toContain('secret')
    })

    it('rejects an empty valid catalog', async () => {
        const request = vi.fn().mockResolvedValue(successResponse(JSON.stringify({ data: [] })))

        await expect(fetchModelCatalog({ baseUrl: 'http://localhost', apiKey: 'secret' }, { request })).rejects.toThrow(
            /available models/i,
        )
    })

    it('delegates to registered model catalog provider and passes activeTransport', async () => {
        const { rendererRegistry } = await import('@/plugins/platform/rendererRegistry')
        const mockProvider = {
            id: 'test-provider',
            protocolProviderId: 'test-proto',
            fetchCatalog: vi.fn().mockResolvedValue([{ id: 'mock-from-provider', label: 'Mock Model' }]),
            getModelCapabilities: vi.fn(),
        }

        const unregister = rendererRegistry.registerModelCatalogProvider(mockProvider as any)
        try {
            const customTransport = {
                request: vi.fn().mockResolvedValue(successResponse(JSON.stringify({ data: [{ id: 'from-custom' }] }))),
            }

            const models = await fetchModelCatalog(
                { baseUrl: 'http://localhost:8317', apiKey: 'secret' },
                customTransport as any,
                'test-provider',
            )

            expect(mockProvider.fetchCatalog).toHaveBeenCalledWith(
                { baseUrl: 'http://localhost:8317', apiKey: 'secret' },
                customTransport,
            )
            expect(models[0].id).toBe('mock-from-provider')
        } finally {
            unregister()
        }
    })
})
