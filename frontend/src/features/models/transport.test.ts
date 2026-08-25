import { beforeEach, describe, expect, it, vi } from 'vitest'
import { electronHttpTransport } from './transport'
import * as hostTransport from '@/application/services/hostTransport'

describe('electronHttpTransport', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    it('delegates to bridge.HttpRequest when available', async () => {
        const mockHttpRequest = vi.fn().mockResolvedValue({
            status: 200,
            headers: { 'content-type': ['application/json'] },
            body: '{"data":[]}',
        })

        vi.spyOn(hostTransport, 'getHostBridge').mockReturnValue({
            HttpRequest: mockHttpRequest,
        } as any)

        const result = await electronHttpTransport.request({
            url: 'http://127.0.0.1:8317/v1/models',
            method: 'GET',
            headers: { Authorization: 'Bearer test' },
            body: '',
            timeoutMs: 30_000,
        })

        expect(mockHttpRequest).toHaveBeenCalledWith({
            urlString: 'http://127.0.0.1:8317/v1/models',
            method: 'GET',
            headers: { Authorization: 'Bearer test' },
            body: '',
            timeoutMs: 30_000,
        })
        expect(result.status).toBe(200)
        expect(result.body).toBe('{"data":[]}')
    })

    it('falls back to global fetch when bridge.HttpRequest throws', async () => {
        vi.spyOn(hostTransport, 'getHostBridge').mockReturnValue({
            HttpRequest: vi.fn().mockRejectedValue(new Error('Bridge failure')),
        } as any)

        const mockFetch = vi.fn().mockResolvedValue({
            status: 200,
            text: async () => '{"data":[]}',
            headers: new Map([['content-type', 'application/json']]),
        })
        vi.stubGlobal('fetch', mockFetch)

        const result = await electronHttpTransport.request({
            url: 'http://127.0.0.1:8317/v1/models',
            method: 'GET',
            headers: {},
            body: '',
            timeoutMs: 30_000,
        })

        expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:8317/v1/models', {
            method: 'GET',
            headers: {},
            body: undefined,
        })
        expect(result.status).toBe(200)
        expect(result.body).toBe('{"data":[]}')
    })
})
