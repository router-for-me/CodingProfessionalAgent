import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import * as http from 'node:http'
import { WebSocket, type ClientOptions } from 'ws'
import { WebServerService } from '../src/main/services/webServerService.js'
import { ProfilingService } from '../src/main/services/profilingService.js'

async function login(port: number, password: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${port}`,
    },
    body: JSON.stringify({ password }),
  })
  expect(response.status).toBe(200)
  const setCookie = response.headers.get('set-cookie')
  expect(setCookie).toBeTruthy()
  return setCookie!.split(';')[0]
}

function authenticatedHeaders(cookie: string): Record<string, string> {
  return { Cookie: cookie }
}

function rejectedUpgradeStatus(
  url: string,
  options: ClientOptions = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options)
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error(`WebSocket upgrade rejection timed out for ${url}`))
    }, 3000)

    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer)
      resolve(response.statusCode ?? 0)
      socket.terminate()
    })
    socket.once('open', () => {
      clearTimeout(timer)
      reject(new Error('WebSocket unexpectedly opened'))
    })
    socket.once('error', (err) => {
      // Allow error to be handled if unexpected-response already handled or if connection was reset
    })
  })
}

describe('WebServerService', () => {
  let service: WebServerService
  let tmpDir: string
  const testPort = 19876

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-webserver-test-'))
    await fs.writeFile(path.join(tmpDir, 'index.html'), '<html><body>Hello CPA Web</body></html>')
    await fs.writeFile(path.join(tmpDir, 'test.json'), JSON.stringify({ key: 'value' }))

    service = new WebServerService({ distDir: tmpDir })
  })

  afterEach(async () => {
    service.dispose()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('configures host and port without starting server', () => {
    service.configure({ host: '0.0.0.0', port: 19999 })
    const status = service.getStatus()
    expect(status.running).toBe(false)
    expect(status.host).toBe('0.0.0.0')
    expect(status.port).toBe(19999)
  })

  it('starts and stops web server and reports status', async () => {
    expect(service.getStatus().running).toBe(false)
    expect(service.getStatus().isDebug).toBe(false)

    const debugServer = new WebServerService({ distDir: tmpDir, isDebug: true })
    expect(debugServer.getStatus().isDebug).toBe(true)
    debugServer.dispose()

    const status = await service.start({ host: '127.0.0.1', port: 0 })
    expect(status.running).toBe(true)
    expect(status.host).toBe('127.0.0.1')
    expect(status.port).toBeGreaterThan(0)
    expect(status.url).toBe(`http://127.0.0.1:${status.port}`)

    const stopStatus = await service.stop()
    expect(stopStatus.running).toBe(false)
  })

  it('serves static files and SPA fallback index.html', async () => {
    const status = await service.start({ host: '127.0.0.1', port: 0 })
    const port = status.port

    // Static html
    const htmlRes = await fetch(`http://127.0.0.1:${port}/`)
    expect(htmlRes.status).toBe(200)
    const htmlText = await htmlRes.text()
    expect(htmlText).toContain('Hello CPA Web')

    // Static json
    const jsonRes = await fetch(`http://127.0.0.1:${port}/test.json`)
    expect(jsonRes.status).toBe(200)
    const json = await jsonRes.json()
    expect(json).toEqual({ key: 'value' })

    // SPA fallback route
    const spaRes = await fetch(`http://127.0.0.1:${port}/settings/connections`)
    expect(spaRes.status).toBe(200)
    const spaText = await spaRes.text()
    expect(spaText).toContain('Hello CPA Web')
  })

  it('handles HTTP RPC requests via /api/rpc', async () => {
    service.setRpcDispatcher(async (method, args) => {
      if (method === 'native:echo') {
        return { echoed: args[0] }
      }
      throw new Error(`Unknown method ${method}`)
    })

    const status = await service.start({ host: '127.0.0.1', port: 0 })
    const port = status.port

    const res = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'req_1', method: 'native:echo', args: ['test-data'] }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.id).toBe('req_1')
    expect(data.result).toEqual({ echoed: 'test-data' })

    // Test session:broadcastRunStatus injects default clientId 'http-rpc' through RpcInvocationContext
    let broadcastArgs: unknown[] = []
    let receivedContext: any = undefined
    service.setRpcDispatcher(async (method, args, context) => {
      if (method === 'session:broadcastRunStatus' || method === 'SessionBroadcastRunStatus') {
        broadcastArgs = args
        receivedContext = context
        return { ok: true }
      }
      throw new Error(`Unknown method ${method}`)
    })

    const broadcastRes = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'req_2',
        method: 'session:broadcastRunStatus',
        args: ['sess-1', 'running', 'run-1', 'spoofed-client-id'],
      }),
    })
    expect(broadcastRes.status).toBe(200)
    expect(receivedContext?.clientId).toBe('http-rpc')

    const broadcastResPascal = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'req_3',
        method: 'SessionBroadcastRunStatus',
        args: ['sess-1', 'thinking', 'run-2', 'another-spoofed-id'],
      }),
    })
    expect(broadcastResPascal.status).toBe(200)
    expect(receivedContext?.clientId).toBe('http-rpc')
  })

  it('handles WebSocket RPC and event broadcasting', async () => {
    service.setRpcDispatcher(async (method, args) => {
      if (method === 'native:test') {
        return `result_${args[0]}`
      }
      throw new Error('unknown')
    })

    const status = await service.start({ host: '127.0.0.1', port: 0 })
    const port = status.port

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`)

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    // Test WS RPC
    const rpcPromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString())
        if (parsed.type === 'rpc_result' && parsed.id === 'ws_1') {
          resolve(parsed.result)
        }
      })
    })

    ws.send(JSON.stringify({ type: 'rpc', id: 'ws_1', method: 'native:test', args: ['hello'] }))
    const rpcResult = await rpcPromise
    expect(rpcResult).toBe('result_hello')

    // Test Broadcast event
    const eventPromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString())
        if (parsed.type === 'event') {
          resolve(parsed.event)
        }
      })
    })

    service.broadcastEvent({
      operationId: 'op_test',
      sequence: 1,
      kind: 'pty-stdout',
      data: 'pty test',
    })

    const event = await eventPromise
    expect(event.operationId).toBe('op_test')
    expect(event.kind).toBe('pty-stdout')

    ws.close()
  })

  describe('Password authentication', () => {
    it('serves auth status and rejects every protected HTTP route before login', async () => {
      const status = await service.start({
        host: '127.0.0.1',
        port: 0,
        password: 'secret',
      })
      const baseUrl = `http://127.0.0.1:${status.port}`

      const authStatus = await fetch(`${baseUrl}/api/auth/status`)
      expect(await authStatus.json()).toEqual({
        required: true,
        authenticated: false,
      })

      const routes = [
        { path: '/api', method: 'GET' },
        { path: '/debug', method: 'GET' },
        { path: '/api/unknown', method: 'GET' },
        { path: '/debug/unknown', method: 'GET' },
        { path: '/api/profile/unknown', method: 'GET' },
        { path: '/debug/pprof/unknown', method: 'GET' },
        { path: '/api', method: 'OPTIONS' },
        { path: '/debug', method: 'OPTIONS' },
        { path: '/api/status', method: 'OPTIONS' },
        { path: '/api/health', method: 'OPTIONS' },
        { path: '/api/unknown', method: 'OPTIONS' },
        { path: '/debug/unknown', method: 'OPTIONS' },
        { path: '/api/status', method: 'GET' },
        { path: '/api/health', method: 'GET' },
        { path: '/api/rpc', method: 'POST' },
        { path: '/api/profile/status', method: 'GET' },
        { path: '/debug/pprof/profile', method: 'GET' },
      ]
      for (const route of routes) {
        const response = await fetch(`${baseUrl}${route.path}`, {
          method: route.method,
        })
        expect(response.status, route.path).toBe(401)
        expect(await response.json()).toEqual({ error: 'Unauthorized' })
      }
    })

    it('keeps static files public and allows protected APIs after login', async () => {
      service.setRpcDispatcher(async () => ({ ok: true }))
      const status = await service.start({
        host: '127.0.0.1',
        port: 0,
        password: 'secret',
      })
      const baseUrl = `http://127.0.0.1:${status.port}`

      expect((await fetch(`${baseUrl}/`)).status).toBe(200)
      expect((await fetch(`${baseUrl}/settings/connections`)).status).toBe(200)

      const cookie = await login(status.port, 'secret')
      const authStatus = await fetch(`${baseUrl}/api/auth/status`, {
        headers: authenticatedHeaders(cookie),
      })
      expect(await authStatus.json()).toEqual({
        required: true,
        authenticated: true,
      })
      expect(
        (
          await fetch(`${baseUrl}/api/health`, {
            headers: authenticatedHeaders(cookie),
          })
        ).status,
      ).toBe(200)
    })

    it('rejects invalid login requests without leaking details', async () => {
      const status = await service.start({
        host: '127.0.0.1',
        port: 0,
        password: 'secret',
      })
      const url = `http://127.0.0.1:${status.port}/api/auth/login`
      const cases = [
        {
          name: 'wrong password',
          body: JSON.stringify({ password: 'wrong' }),
          expected: 401,
        },
        { name: 'invalid JSON', body: '{', expected: 400 },
        {
          name: 'non-string password',
          body: JSON.stringify({ password: 123 }),
          expected: 400,
        },
        {
          name: 'oversized body',
          body: JSON.stringify({ password: 'x'.repeat(17 * 1024) }),
          expected: 413,
        },
      ]

      for (const testCase of cases) {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: testCase.body,
        })
        expect(response.status, testCase.name).toBe(testCase.expected)
        expect(JSON.stringify(await response.json())).not.toContain('secret')
      }
    })

    it('rejects cross-origin login and authenticated API requests, unknown subpaths, and protected OPTIONS', async () => {
      const status = await service.start({
        host: '127.0.0.1',
        port: 0,
        password: 'secret',
      })
      const baseUrl = `http://127.0.0.1:${status.port}`
      const crossOriginLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://evil.example.test',
        },
        body: JSON.stringify({ password: 'secret' }),
      })
      expect(crossOriginLogin.status).toBe(403)

      const cookie = await login(status.port, 'secret')
      const crossOriginApi = await fetch(`${baseUrl}/api/health`, {
        headers: {
          ...authenticatedHeaders(cookie),
          Origin: 'http://evil.example.test',
        },
      })
      expect(crossOriginApi.status).toBe(403)

      const crossOriginRoutes = [
        { path: '/api', method: 'GET' },
        { path: '/debug', method: 'GET' },
        { path: '/api/unknown', method: 'GET' },
        { path: '/debug/unknown', method: 'GET' },
        { path: '/api/health', method: 'OPTIONS' },
        { path: '/api', method: 'OPTIONS' },
      ]
      for (const route of crossOriginRoutes) {
        const response = await fetch(`${baseUrl}${route.path}`, {
          method: route.method,
          headers: {
            ...authenticatedHeaders(cookie),
            Origin: 'http://evil.example.test',
          },
        })
        expect(response.status, route.path).toBe(403)
      }
    })

    it('sets CORS headers correctly in auth mode and no-auth mode', async () => {
      const authStatus = await service.start({
        host: '127.0.0.1',
        port: 0,
        password: 'secret',
      })
      const authBaseUrl = `http://127.0.0.1:${authStatus.port}`
      const sameOrigin = `http://127.0.0.1:${authStatus.port}`

      // Same-origin request in auth mode echoes origin and sets Vary
      const sameOriginRes = await fetch(`${authBaseUrl}/api/auth/status`, {
        headers: { Origin: sameOrigin },
      })
      expect(sameOriginRes.headers.get('access-control-allow-origin')).toBe(sameOrigin)
      expect(sameOriginRes.headers.get('vary')).toBe('Origin')
      expect(sameOriginRes.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, DELETE, OPTIONS, HEAD')
      expect(sameOriginRes.headers.get('access-control-allow-headers')).toBe('*')

      // Cross-origin request in auth mode does not echo allow-origin
      const crossOriginRes = await fetch(`${authBaseUrl}/api/auth/status`, {
        headers: { Origin: 'http://evil.example.test' },
      })
      expect(crossOriginRes.headers.get('access-control-allow-origin')).toBeNull()
      expect(crossOriginRes.headers.get('vary')).toBe('Origin')

      // Authenticated OPTIONS in auth mode returns 204 with same-origin header
      const cookie = await login(authStatus.port, 'secret')
      const optionsRes = await fetch(`${authBaseUrl}/api/health`, {
        method: 'OPTIONS',
        headers: {
          ...authenticatedHeaders(cookie),
          Origin: sameOrigin,
        },
      })
      expect(optionsRes.status).toBe(204)
      expect(optionsRes.headers.get('access-control-allow-origin')).toBe(sameOrigin)

      // Restart without password (no-auth mode)
      const noAuthStatus = await service.start({
        host: '127.0.0.1',
        port: 0,
        password: '',
      })
      const noAuthBaseUrl = `http://127.0.0.1:${noAuthStatus.port}`

      const noAuthRes = await fetch(`${noAuthBaseUrl}/api/health`)
      expect(noAuthRes.status).toBe(200)
      expect(noAuthRes.headers.get('access-control-allow-origin')).toBe('*')

      const noAuthOptionsRes = await fetch(`${noAuthBaseUrl}/api/health`, {
        method: 'OPTIONS',
      })
      expect(noAuthOptionsRes.status).toBe(204)
      expect(noAuthOptionsRes.headers.get('access-control-allow-origin')).toBe('*')
    })

    it('protects every supported WebSocket upgrade path', async () => {
      const status = await service.start({
        host: '127.0.0.1',
        port: 0,
        password: 'secret',
      })
      const cookie = await login(status.port, 'secret')

      for (const pathname of ['/api/ws', '/ws', '/']) {
        const url = `ws://127.0.0.1:${status.port}${pathname}`
        await expect(rejectedUpgradeStatus(url)).resolves.toBe(401)

        const socket = new WebSocket(url, {
          headers: {
            Cookie: cookie,
            Origin: `http://127.0.0.1:${status.port}`,
          },
        })
        const hello = await new Promise<Record<string, unknown>>(
          (resolve, reject) => {
            socket.once('message', (data) => resolve(JSON.parse(data.toString())))
            socket.once('error', reject)
          },
        )
        expect(hello.type).toBe('hello')
        socket.close()
      }
    })

    it('closes existing WebSockets with 4401 when authentication becomes required', async () => {
      const status = await service.start({ host: '127.0.0.1', port: 0 })
      const socket = new WebSocket(`ws://127.0.0.1:${status.port}/api/ws`)
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })

      const closed = new Promise<number>((resolve) => {
        socket.once('close', (code) => resolve(code))
      })
      await service.start({
        host: status.host,
        port: status.port,
        password: 'new-secret',
      })

      await expect(closed).resolves.toBe(4401)
      expect((await fetch(`http://127.0.0.1:${status.port}/api/health`)).status).toBe(401)
    })

    it('invalidates the old session on password change and opens access when cleared', async () => {
      const status = await service.start({
        host: '127.0.0.1',
        port: 0,
        password: 'first',
      })
      const baseUrl = `http://127.0.0.1:${status.port}`
      const oldCookie = await login(status.port, 'first')
      const socket = new WebSocket(`ws://127.0.0.1:${status.port}/api/ws`, {
        headers: { Cookie: oldCookie },
      })
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })
      const closed = new Promise<number>((resolve) => {
        socket.once('close', (code) => resolve(code))
      })

      await service.start({
        host: status.host,
        port: status.port,
        password: 'second',
      })
      await expect(closed).resolves.toBe(4401)
      expect(
        (
          await fetch(`${baseUrl}/api/health`, {
            headers: authenticatedHeaders(oldCookie),
          })
        ).status,
      ).toBe(401)

      const newCookie = await login(status.port, 'second')
      const openSocket = new WebSocket(
        `ws://127.0.0.1:${status.port}/api/ws`,
        { headers: { Cookie: newCookie } },
      )
      await new Promise<void>((resolve, reject) => {
        openSocket.once('open', resolve)
        openSocket.once('error', reject)
      })

      await service.start({
        host: status.host,
        port: status.port,
        password: '',
      })
      expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200)
      expect(openSocket.readyState).toBe(WebSocket.OPEN)
      openSocket.close()
    })

    it('rejects WebSocket upgrades from cross-origin clients even with a valid session cookie', async () => {
      const status = await service.start({
        host: '127.0.0.1',
        port: 0,
        password: 'secret',
      })
      const cookie = await login(status.port, 'secret')

      for (const pathname of ['/api/ws', '/ws', '/']) {
        const url = `ws://127.0.0.1:${status.port}${pathname}`
        await expect(
          rejectedUpgradeStatus(url, {
            headers: {
              Cookie: cookie,
              Origin: 'http://evil.example.test',
            },
          }),
        ).resolves.toBe(403)
      }
    })

    it('invalidates sessions on stop() and rejects previous cookies on restart', async () => {
      const status1 = await service.start({
        host: '127.0.0.1',
        port: 0,
        password: 'secret',
      })
      const cookie = await login(status1.port, 'secret')
      const initialRes = await fetch(`http://127.0.0.1:${status1.port}/api/health`, {
        headers: authenticatedHeaders(cookie),
      })
      expect(initialRes.status).toBe(200)

      await service.stop()

      const status2 = await service.start({
        host: '127.0.0.1',
        port: 0,
        password: 'secret',
      })
      const restartedRes = await fetch(`http://127.0.0.1:${status2.port}/api/health`, {
        headers: authenticatedHeaders(cookie),
      })
      expect(restartedRes.status).toBe(401)
      expect(await restartedRes.json()).toEqual({ error: 'Unauthorized' })
    })

    it('closes existing WebSockets with 4401 on stop() when authentication is enabled, but retains normal close when empty password', async () => {
      // 1. Auth enabled: stop() closes WS with 4401
      const authStatus = await service.start({
        host: '127.0.0.1',
        port: 0,
        password: 'pass-secret',
      })
      const cookie = await login(authStatus.port, 'pass-secret')
      const authSocket = new WebSocket(`ws://127.0.0.1:${authStatus.port}/api/ws`, {
        headers: authenticatedHeaders(cookie),
      })
      await new Promise<void>((resolve, reject) => {
        authSocket.once('open', resolve)
        authSocket.once('error', reject)
      })
      const authClosePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        authSocket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
      })

      await service.stop()
      const authClose = await authClosePromise
      expect(authClose.code).toBe(4401)
      expect(authClose.reason).toBe('Web authentication required')

      // 2. Auth disabled (empty password): stop() does NOT use 4401
      const openStatus = await service.start({
        host: '127.0.0.1',
        port: 0,
        password: '',
      })
      const openSocket = new WebSocket(`ws://127.0.0.1:${openStatus.port}/api/ws`)
      await new Promise<void>((resolve, reject) => {
        openSocket.once('open', resolve)
        openSocket.once('error', reject)
      })
      const openClosePromise = new Promise<number>((resolve) => {
        openSocket.once('close', (code) => resolve(code))
      })

      await service.stop()
      const openCloseCode = await openClosePromise
      expect(openCloseCode).not.toBe(4401)
    })

    it('correctly handles chunked multi-byte unicode password split across buffers and issues cookie', async () => {
      const complexPassword = 'pass🔐wordCPA2026'
      const status = await service.start({
        host: '127.0.0.1',
        port: 0,
        password: complexPassword,
      })

      const payload = Buffer.from(JSON.stringify({ password: complexPassword }), 'utf8')
      // Find the index of the emoji '🔐' in UTF-8 bytes and split right in the middle
      const emojiIndex = payload.indexOf(Buffer.from('🔐', 'utf8'))
      expect(emojiIndex).toBeGreaterThan(-1)
      const splitPoint = emojiIndex + 2 // Split 4-byte emoji after 2 bytes

      const chunk1 = payload.subarray(0, splitPoint)
      const chunk2 = payload.subarray(splitPoint)

      const result = await new Promise<{
        statusCode: number
        body: any
        headers: http.IncomingHttpHeaders
      }>((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${status.port}/api/auth/login`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': String(payload.length),
              Origin: `http://127.0.0.1:${status.port}`,
            },
          },
          (res) => {
            let resBody = ''
            res.on('data', (d) => {
              resBody += d.toString('utf8')
            })
            res.on('end', () => {
              try {
                resolve({
                  statusCode: res.statusCode ?? 0,
                  body: JSON.parse(resBody),
                  headers: res.headers,
                })
              } catch (err) {
                reject(err)
              }
            })
          },
        )
        req.on('error', reject)
        req.write(chunk1)
        setTimeout(() => {
          req.end(chunk2)
        }, 10)
      })

      expect(result.statusCode).toBe(200)
      expect(result.body).toEqual({ authenticated: true })
      expect(result.headers['set-cookie']).toBeTruthy()
      expect(result.headers['set-cookie']![0]).toContain('cpa_web_session=')
    })

    it('enforces Cache-Control: no-store on all auth, api, and debug endpoints with contrast to static assets', async () => {
      // Create static js asset in tmpDir
      await fs.writeFile(path.join(tmpDir, 'bundle.js'), 'console.log("js asset")')

      const status = await service.start({
        host: '127.0.0.1',
        port: 0,
        password: 'secure-password',
      })
      const baseUrl = `http://127.0.0.1:${status.port}`

      // 1. GET /api/auth/status (anonymous)
      const authStatusRes = await fetch(`${baseUrl}/api/auth/status`)
      expect(authStatusRes.status).toBe(200)
      expect(authStatusRes.headers.get('cache-control')).toBe('no-store')

      // 2. POST /api/auth/login (401 invalid password)
      const loginFailRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: baseUrl,
        },
        body: JSON.stringify({ password: 'wrong' }),
      })
      expect(loginFailRes.status).toBe(401)
      expect(loginFailRes.headers.get('cache-control')).toBe('no-store')

      // 3. POST /api/auth/login (200 success)
      const loginSuccessRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: baseUrl,
        },
        body: JSON.stringify({ password: 'secure-password' }),
      })
      expect(loginSuccessRes.status).toBe(200)
      expect(loginSuccessRes.headers.get('cache-control')).toBe('no-store')
      const cookie = loginSuccessRes.headers.get('set-cookie')!.split(';')[0]!

      // 4. Protected dynamic endpoints when unauthenticated (401)
      const unauthStatusRes = await fetch(`${baseUrl}/api/status`)
      expect(unauthStatusRes.status).toBe(401)
      expect(unauthStatusRes.headers.get('cache-control')).toBe('no-store')

      const unauthHealthRes = await fetch(`${baseUrl}/api/health`)
      expect(unauthHealthRes.status).toBe(401)
      expect(unauthHealthRes.headers.get('cache-control')).toBe('no-store')

      // 5. Protected dynamic endpoints when authenticated (200)
      const authStatusApiRes = await fetch(`${baseUrl}/api/status`, {
        headers: authenticatedHeaders(cookie),
      })
      expect(authStatusApiRes.status).toBe(200)
      expect(authStatusApiRes.headers.get('cache-control')).toBe('no-store')

      const authHealthRes = await fetch(`${baseUrl}/api/health`, {
        headers: authenticatedHeaders(cookie),
      })
      expect(authHealthRes.status).toBe(200)
      expect(authHealthRes.headers.get('cache-control')).toBe('no-store')

      // 6. Profiling endpoints (disabled: 403)
      const profileStatusRes = await fetch(`${baseUrl}/api/profile/status`, {
        headers: authenticatedHeaders(cookie),
      })
      expect(profileStatusRes.status).toBe(403)
      expect(profileStatusRes.headers.get('cache-control')).toBe('no-store')

      // 7. Contrast: static JS asset
      const staticJsRes = await fetch(`${baseUrl}/bundle.js`)
      expect(staticJsRes.status).toBe(200)
      expect(staticJsRes.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')

      // 8. Contrast: static HTML / SPA fallback
      const staticHtmlRes = await fetch(`${baseUrl}/`)
      expect(staticHtmlRes.status).toBe(200)
      expect(staticHtmlRes.headers.get('cache-control')).toBe('no-cache')
    })
  })

  describe('Profiling endpoints', () => {
    let profiler: ProfilingService | null = null

    afterEach(() => {
      profiler?.dispose()
      profiler = null
    })

    it('returns 403 Forbidden for all /api/profile/* and /debug/pprof/* routes when profiling is disabled', async () => {
      const status = await service.start({ host: '127.0.0.1', port: 0 })
      const port = status.port

      const routes = [
        { path: '/api/profile/start', method: 'POST' },
        { path: '/api/profile/stop', method: 'POST' },
        { path: '/api/profile/status', method: 'GET' },
        { path: '/api/profile/report', method: 'GET' },
        { path: '/debug/pprof/profile', method: 'GET' },
      ]

      for (const route of routes) {
        const res = await fetch(`http://127.0.0.1:${port}${route.path}`, {
          method: route.method,
        })
        expect(res.status).toBe(403)
        const json = await res.json()
        expect(json).toEqual({ error: 'Profiling is disabled' })
      }
    })

    it('returns 403 Forbidden when profilingService is set but disabled', async () => {
      profiler = new ProfilingService({ isDebug: false })
      service.setProfilingService(profiler)

      const status = await service.start({ host: '127.0.0.1', port: 0 })
      const port = status.port

      const res = await fetch(`http://127.0.0.1:${port}/api/profile/status`)
      expect(res.status).toBe(403)
      const json = await res.json()
      expect(json).toEqual({ error: 'Profiling is disabled' })
    })

    it('handles /api/profile/start, /api/profile/status, /api/profile/stop, /api/profile/report', async () => {
      profiler = new ProfilingService({ isDebug: true })
      service.setProfilingService(profiler)

      const status = await service.start({ host: '127.0.0.1', port: 0 })
      const port = status.port

      // 1. Initial status
      const initialStatusRes = await fetch(`http://127.0.0.1:${port}/api/profile/status`)
      expect(initialStatusRes.status).toBe(200)
      const initialStatus = await initialStatusRes.json()
      expect(initialStatus.ok).toBe(true)
      expect(initialStatus.status.running).toBe(false)

      // 2. Start profiling
      const startRes = await fetch(`http://127.0.0.1:${port}/api/profile/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationMs: 10000, target: 'main' }),
      })
      expect(startRes.status).toBe(200)
      const startData = await startRes.json()
      expect(startData.ok).toBe(true)
      expect(startData.session.running).toBe(true)
      expect(startData.session.target).toBe('main')

      // 3. Check status during run
      const runningStatusRes = await fetch(`http://127.0.0.1:${port}/api/profile/status`)
      expect(runningStatusRes.status).toBe(200)
      const runningStatus = await runningStatusRes.json()
      expect(runningStatus.ok).toBe(true)
      expect(runningStatus.status.running).toBe(true)

      // Do some CPU work
      let sum = 0
      for (let i = 0; i < 50000; i++) sum += i
      expect(sum).toBeGreaterThan(0)

      // 4. Stop profiling
      const stopRes = await fetch(`http://127.0.0.1:${port}/api/profile/stop`, {
        method: 'POST',
      })
      expect(stopRes.status).toBe(200)
      const stopData = await stopRes.json()
      expect(stopData.ok).toBe(true)
      expect(stopData.report).toBeDefined()
      expect(stopData.report.summary.target).toBe('main')
      expect(stopData.rawProfile).toBeDefined()

      // 5. Get report
      const reportRes = await fetch(`http://127.0.0.1:${port}/api/profile/report`)
      expect(reportRes.status).toBe(200)
      const reportData = await reportRes.json()
      expect(reportData.ok).toBe(true)
      expect(reportData.report.summary.target).toBe('main')

      // 6. Stop profiling again when not running -> 400
      const stopAgainRes = await fetch(`http://127.0.0.1:${port}/api/profile/stop`, {
        method: 'POST',
      })
      expect(stopAgainRes.status).toBe(400)
      const stopAgainData = await stopAgainRes.json()
      expect(stopAgainData.ok).toBe(false)
      expect(stopAgainData.error).toBeDefined()
    })

    it('returns 409 Conflict when starting profiling concurrently', async () => {
      profiler = new ProfilingService({ isDebug: true })
      service.setProfilingService(profiler)

      const status = await service.start({ host: '127.0.0.1', port: 0 })
      const port = status.port

      const startRes1 = await fetch(`http://127.0.0.1:${port}/api/profile/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationMs: 10000, target: 'main' }),
      })
      expect(startRes1.status).toBe(200)

      const startRes2 = await fetch(`http://127.0.0.1:${port}/api/profile/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationMs: 10000, target: 'main' }),
      })
      expect(startRes2.status).toBe(409)
      const startData2 = await startRes2.json()
      expect(startData2.ok).toBe(false)
      expect(startData2.error).toContain('already active')

      await fetch(`http://127.0.0.1:${port}/api/profile/stop`, { method: 'POST' })
    })

    it('handles /debug/pprof/profile timed capture with json, markdown, and raw formats', async () => {
      profiler = new ProfilingService({ isDebug: true })
      service.setProfilingService(profiler)

      const status = await service.start({ host: '127.0.0.1', port: 0 })
      const port = status.port

      // 1. Format: json (default)
      const jsonRes = await fetch(`http://127.0.0.1:${port}/debug/pprof/profile?seconds=0.05&target=main&format=json`)
      expect(jsonRes.status).toBe(200)
      expect(jsonRes.headers.get('content-type')).toContain('application/json')
      const jsonData = await jsonRes.json()
      expect(jsonData.summary).toBeDefined()
      expect(jsonData.summary.target).toBe('main')

      // 2. Format: markdown
      const mdRes = await fetch(`http://127.0.0.1:${port}/debug/pprof/profile?seconds=0.05&target=main&format=markdown`)
      expect(mdRes.status).toBe(200)
      expect(mdRes.headers.get('content-type')).toContain('text/markdown')
      const mdText = await mdRes.text()
      expect(mdText).toContain('Performance Diagnostic Report')

      // 3. Format: raw
      const rawRes = await fetch(`http://127.0.0.1:${port}/debug/pprof/profile?seconds=0.05&target=main&format=raw`)
      expect(rawRes.status).toBe(200)
      expect(rawRes.headers.get('content-type')).toContain('application/json')
      expect(rawRes.headers.get('content-disposition')).toContain('profile.cpuprofile')
      const rawData = await rawRes.json()
      expect(Array.isArray(rawData.nodes)).toBe(true)
    })

    it('validates request body and parameters for POST /api/profile/start', async () => {
      profiler = new ProfilingService({ isDebug: true })
      service.setProfilingService(profiler)

      const status = await service.start({ host: '127.0.0.1', port: 0 })
      const port = status.port

      // Malformed JSON
      const malformedRes = await fetch(`http://127.0.0.1:${port}/api/profile/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      })
      expect(malformedRes.status).toBe(400)
      const malformedData = await malformedRes.json()
      expect(malformedData).toEqual({ ok: false, error: 'Invalid JSON body' })

      // Non-object bodies: string, null, array, number, boolean
      const nonObjectBodies = ['"foo"', 'null', '[]', '123', 'true']
      for (const body of nonObjectBodies) {
        const res = await fetch(`http://127.0.0.1:${port}/api/profile/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
        expect(res.status).toBe(400)
        const data = await res.json()
        expect(data).toEqual({ ok: false, error: 'Invalid JSON body' })
      }

      // Invalid target
      const invalidTargetRes = await fetch(`http://127.0.0.1:${port}/api/profile/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'invalid' }),
      })
      expect(invalidTargetRes.status).toBe(400)
      const invalidTargetData = await invalidTargetRes.json()
      expect(invalidTargetData.ok).toBe(false)
      expect(invalidTargetData.error).toContain('target')

      // Invalid durationMs (negative, zero, NaN/string)
      const invalidDurations = [-10, 0, 'invalid']
      for (const durationMs of invalidDurations) {
        const res = await fetch(`http://127.0.0.1:${port}/api/profile/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ durationMs }),
        })
        expect(res.status).toBe(400)
        const data = await res.json()
        expect(data.ok).toBe(false)
        expect(data.error).toContain('durationMs')
      }
    })

    it('validates query parameters for GET /debug/pprof/profile', async () => {
      profiler = new ProfilingService({ isDebug: true })
      service.setProfilingService(profiler)

      const status = await service.start({ host: '127.0.0.1', port: 0 })
      const port = status.port

      // Invalid format
      const invalidFormatRes = await fetch(`http://127.0.0.1:${port}/debug/pprof/profile?format=xml`)
      expect(invalidFormatRes.status).toBe(400)
      const invalidFormatData = await invalidFormatRes.json()
      expect(invalidFormatData.ok).toBe(false)
      expect(invalidFormatData.error).toContain('format')

      // Invalid target
      const invalidTargetRes = await fetch(`http://127.0.0.1:${port}/debug/pprof/profile?target=invalid`)
      expect(invalidTargetRes.status).toBe(400)
      const invalidTargetData = await invalidTargetRes.json()
      expect(invalidTargetData.ok).toBe(false)
      expect(invalidTargetData.error).toContain('target')
    })

    it('clamps seconds between 0.05 and 60 for GET /debug/pprof/profile', async () => {
      profiler = new ProfilingService({ isDebug: true })
      service.setProfilingService(profiler)

      const status = await service.start({ host: '127.0.0.1', port: 0 })
      const port = status.port

      const startSpy = vi.spyOn(profiler, 'start')

      // Request with seconds=100 (should clamp to 60, passing durationMs: 65000)
      const controller = new AbortController()
      const fetchPromise = fetch(`http://127.0.0.1:${port}/debug/pprof/profile?seconds=100&target=main`, {
        signal: controller.signal,
      }).catch(() => {})

      // Wait a moment for start to be called
      await new Promise((r) => setTimeout(r, 50))
      expect(startSpy).toHaveBeenCalledWith({
        durationMs: 65000,
        target: 'main',
      })

      // Abort to clean up
      controller.abort()
      await fetchPromise
      await new Promise((r) => setTimeout(r, 50))
    })

    it('releases profiler lock when client aborts /debug/pprof/profile connection', async () => {
      profiler = new ProfilingService({ isDebug: true })
      service.setProfilingService(profiler)

      const status = await service.start({ host: '127.0.0.1', port: 0 })
      const port = status.port

      const controller = new AbortController()
      const fetchPromise = fetch(`http://127.0.0.1:${port}/debug/pprof/profile?seconds=5&target=main`, {
        signal: controller.signal,
      }).catch(() => {})

      // Wait until profiling session is active
      await new Promise((r) => setTimeout(r, 50))
      expect(profiler.getStatus().running).toBe(true)

      // Client disconnects/aborts
      controller.abort()
      await fetchPromise

      // Wait for abort handler and stop() to release lock
      await new Promise((r) => setTimeout(r, 100))
      expect(profiler.getStatus().running).toBe(false)

      // Verify lock is released and a new session can start immediately
      const newStartRes = await fetch(`http://127.0.0.1:${port}/api/profile/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'main' }),
      })
      expect(newStartRes.status).toBe(200)
      const newStartData = await newStartRes.json()
      expect(newStartData.ok).toBe(true)

      await fetch(`http://127.0.0.1:${port}/api/profile/stop`, { method: 'POST' })
    })

    it('returns raw alias in stop response and full status schema', async () => {
      profiler = new ProfilingService({ isDebug: true })
      service.setProfilingService(profiler)

      const status = await service.start({ host: '127.0.0.1', port: 0 })
      const port = status.port

      // 1. Status schema check
      const statusRes = await fetch(`http://127.0.0.1:${port}/api/profile/status`)
      expect(statusRes.status).toBe(200)
      const statusData = await statusRes.json()
      expect(statusData.ok).toBe(true)
      expect(statusData.running).toBe(false)
      expect(statusData.enabled).toBe(true)
      expect(statusData.target).toBeDefined()
      expect(statusData.status).toBeDefined()

      // 2. Start profiling
      await fetch(`http://127.0.0.1:${port}/api/profile/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationMs: 10000, target: 'main' }),
      })

      // 3. Stop profiling & verify raw and rawProfile
      const stopRes = await fetch(`http://127.0.0.1:${port}/api/profile/stop`, {
        method: 'POST',
      })
      expect(stopRes.status).toBe(200)
      const stopData = await stopRes.json()
      expect(stopData.ok).toBe(true)
      expect(stopData.report).toBeDefined()
      expect(stopData.rawProfile).toBeDefined()
      expect(stopData.raw).toBeDefined()
      expect(stopData.raw).toEqual(stopData.rawProfile)

      // 4. Report endpoint check
      const reportRes = await fetch(`http://127.0.0.1:${port}/api/profile/report`)
      expect(reportRes.status).toBe(200)
      const reportData = await reportRes.json()
      expect(reportData.ok).toBe(true)
      expect(reportData.report).toBeDefined()
      expect(reportData.report.summary).toBeDefined()
    })

    it('returns 500 Internal Server Error when start profiling fails for non-conflict reason', async () => {
      profiler = new ProfilingService({ isDebug: true })
      vi.spyOn(profiler, 'start').mockResolvedValue({
        ok: false,
        message: 'Failed to start both renderer and main process profiling',
      })
      service.setProfilingService(profiler)

      const status = await service.start({ host: '127.0.0.1', port: 0 })
      const port = status.port

      const res = await fetch(`http://127.0.0.1:${port}/api/profile/start`, {
        method: 'POST',
      })
      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.ok).toBe(false)
      expect(data.error).toContain('Failed to start')
    })
  })
})
