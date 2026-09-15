import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as http from 'node:http'
import { HttpService } from '../src/main/services/httpService.js'
import { getUserAgent } from '../src/main/utils/version.js'

describe('HttpService', () => {
  let service: HttpService
  let server: http.Server
  let port: number

  beforeEach(async () => {
    service = new HttpService()
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        res.setHeader('X-Custom-Header', 'custom-value')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }))
      })
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        port = typeof addr === 'object' && addr ? addr.port : 0
        resolve()
      })
    })
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('sends HTTP GET requests', async () => {
    const res = await service.request({
      urlString: `http://127.0.0.1:${port}/api/test`,
      method: 'GET',
      headers: { 'X-Test': '123' },
      body: '',
      timeoutMs: 3000,
    })

    expect(res.status).toBe(200)
    const json = JSON.parse(res.body)
    expect(json.method).toBe('GET')
    expect(json.url).toBe('/api/test')
    expect(json.headers['user-agent']).toBe(getUserAgent())
    expect(json.headers['user-agent']).not.toContain('(Electron)')
    expect(res.headers['x-custom-header']).toContain('custom-value')
  })

  it.each(['headers', 'body'])('reports a timeout, not user cancellation, while waiting for %s', async (phase) => {
    server.removeAllListeners('request')
    server.on('request', (_req, res) => {
      if (phase === 'body') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.write('{')
      }
      // Intentionally do not finish the response.
    })
    const pending = service.request({
      urlString: `http://127.0.0.1:${port}/slow`, method: 'GET', headers: {}, body: '', timeoutMs: 100,
    })
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError', message: 'HTTP request timed out after 100ms' })
  })

  it('sends HTTP POST requests with body', async () => {
    const res = await service.request({
      urlString: `http://127.0.0.1:${port}/api/post`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
      timeoutMs: 3000,
    })

    expect(res.status).toBe(200)
    const json = JSON.parse(res.body)
    expect(json.method).toBe('POST')
    expect(JSON.parse(json.body)).toEqual({ message: 'hello' })
  })
})
