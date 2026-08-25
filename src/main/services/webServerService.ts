import * as http from 'node:http'
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import type { NativeEvent, WebServerSettings, WebServerStatus } from '../../shared/types.js'
import { WebServerAuthService, type WebAuthPasswordChange } from './webServerAuthService.js'
import { ProfilingService } from './profilingService.js'
import { ProfilingAnalyzer } from './profilingAnalyzer.js'
import type { PluginResourceService } from '../plugins/resources/PluginResourceService.js'
import type {
    WebRouteContribution,
    WebRouteRequest,
    WebRouteResponse,
    WebRouteContext,
} from '@cpa/plugin-api'
import { WebRouteRegistry } from './web/routeRegistry.js'
import { WebRpcTransport, type RpcDispatcher } from './web/rpcTransport.js'
import { WebIdentityAdapter } from './web/identityAdapter.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.wasm': 'application/wasm',
    '.map': 'application/json',
    '.txt': 'text/plain; charset=utf-8',
}

export type { RpcDispatcher }

export interface WebServerServiceOptions {
    distDir?: string
    isDebug?: boolean
    profilingService?: ProfilingService
    pluginResourceService?: PluginResourceService
    routeRegistry?: WebRouteRegistry
    rpcTransport?: WebRpcTransport
    identityAdapter?: WebIdentityAdapter
}

/**
 * WebServerService manages HTTP server and WebSocket server lifecycles,
 * active client connection tracking, and delegates route matching and RPC dispatching
 * to WebRouteRegistry, WebRpcTransport, and WebIdentityAdapter.
 */
export class WebServerService {
    private server: http.Server | null = null
    private wss: WebSocketServer | null = null
    private clients: Set<WebSocket> = new Set()
    private clientIds: Map<WebSocket, string> = new Map()
    private running = false
    private currentHost = '127.0.0.1'
    private currentPort = 18080
    private lastError?: string
    private customDistDir?: string
    private isDebug = false
    private onClientDisconnectCallback?: (clientId: string) => void
    private readonly auth = new WebServerAuthService()
    private profilingService: ProfilingService | null = null
    private pluginResourceService: PluginResourceService | null = null
    private readonly identityAdapter: WebIdentityAdapter
    private readonly rpcTransport: WebRpcTransport
    private readonly routeRegistry: WebRouteRegistry

    constructor(options?: WebServerServiceOptions) {
        this.customDistDir = options?.distDir
        this.isDebug = options?.isDebug ?? false
        if (options?.profilingService) {
            this.profilingService = options.profilingService
        }
        if (options?.pluginResourceService) {
            this.pluginResourceService = options.pluginResourceService
        }

        this.identityAdapter = options?.identityAdapter ?? new WebIdentityAdapter()
        this.rpcTransport = options?.rpcTransport ?? new WebRpcTransport(null, this.identityAdapter)
        this.routeRegistry = options?.routeRegistry ?? new WebRouteRegistry()

        this.registerCoreRoutes()
    }

    private applyPasswordConfig(config?: Partial<WebServerSettings>): WebAuthPasswordChange {
        if (typeof config?.password !== 'string') return 'unchanged'
        const change = this.auth.setPassword(config.password)
        if ((change === 'enabled' || change === 'changed') && this.running) {
            for (const client of this.clients) {
                try {
                    client.close(4401, 'Web authentication required')
                } catch {
                    // Ignore close errors for stale clients
                }
            }
        }
        return change
    }

    private writeJson(
        res: http.ServerResponse,
        status: number,
        body: unknown,
        headers: Record<string, string> = {},
    ): void {
        res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...headers,
        })
        res.end(JSON.stringify(body))
    }

    private readRequestBody(req: http.IncomingMessage, limit = 16 * 1024 * 1024): Promise<Uint8Array | undefined> {
        if (req.method === 'GET' || req.method === 'HEAD') {
            return Promise.resolve(undefined)
        }
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = []
            let size = 0
            let tooLarge = false
            req.on('data', (chunk: Buffer | string) => {
                const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
                size += buf.length
                if (size > limit) {
                    tooLarge = true
                    return
                }
                chunks.push(buf)
            })
            req.on('end', () => {
                if (tooLarge) {
                    reject(new RangeError('Request body too large'))
                    return
                }
                if (chunks.length === 0) {
                    resolve(undefined)
                } else {
                    resolve(Buffer.concat(chunks))
                }
            })
            req.on('error', reject)
        })
    }

    private registerCoreRoutes(): void {
        // 1. Auth route (public status and login)
        this.routeRegistry.register({
            id: 'auth',
            method: '*',
            path: '/api/auth/*',
            order: 100,
            authenticate: false,
            handle: async (ctx: WebRouteContext): Promise<WebRouteResponse> => {
                const parsedUrl = new URL(ctx.request.url || '/', 'http://localhost')
                const pathname = parsedUrl.pathname
                const rawReq =
                    ((ctx as any).rawRequest as http.IncomingMessage | undefined) ??
                    ({ headers: ctx.request.headers, socket: {} } as http.IncomingMessage)

                // Public auth status endpoint
                if (pathname === '/api/auth/status' && ctx.request.method === 'GET') {
                    return {
                        status: 200,
                        headers: {
                            'Content-Type': 'application/json',
                            'Cache-Control': 'no-store',
                        },
                        body: JSON.stringify(this.auth.getStatus(rawReq)),
                    }
                }

                // Public login endpoint
                if (pathname === '/api/auth/login' && ctx.request.method === 'POST') {
                    if (this.auth.isRequired() && !this.auth.isSameOrigin(rawReq)) {
                        return {
                            status: 403,
                            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                            body: JSON.stringify({ error: 'Forbidden' }),
                        }
                    }

                    if (ctx.request.body && ctx.request.body.length > 16 * 1024) {
                        return {
                            status: 413,
                            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                            body: JSON.stringify({ error: 'Request body too large' }),
                        }
                    }

                    let body: any
                    try {
                        const bodyStr = ctx.request.body ? Buffer.from(ctx.request.body).toString('utf8') : ''
                        body = JSON.parse(bodyStr)
                    } catch {
                        return {
                            status: 400,
                            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                            body: JSON.stringify({ error: 'Invalid request' }),
                        }
                    }

                    if (typeof body !== 'object' || body === null || typeof body.password !== 'string') {
                        return {
                            status: 400,
                            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                            body: JSON.stringify({ error: 'Invalid request' }),
                        }
                    }

                    if (!this.auth.isRequired()) {
                        return {
                            status: 200,
                            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                            body: JSON.stringify({ authenticated: true }),
                        }
                    }

                    const token = this.auth.createSession(body.password)
                    if (!token) {
                        return {
                            status: 401,
                            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                            body: JSON.stringify({ error: 'Unauthorized' }),
                        }
                    }

                    return {
                        status: 200,
                        headers: {
                            'Content-Type': 'application/json',
                            'Cache-Control': 'no-store',
                            'Set-Cookie': this.auth.createSessionCookie(token, rawReq),
                        },
                        body: JSON.stringify({ authenticated: true }),
                    }
                }

                return {
                    status: 404,
                    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                    body: JSON.stringify({ error: 'Not Found' }),
                }
            },
        })

        // 2. Status & Health routes
        this.routeRegistry.register({
            id: 'status',
            method: 'GET',
            path: '/api/status,/api/health',
            order: 200,
            authenticate: true,
            handle: async (ctx: WebRouteContext): Promise<WebRouteResponse> => {
                const parsedUrl = new URL(ctx.request.url || '/', 'http://localhost')
                const pathname = parsedUrl.pathname

                if (pathname === '/api/status') {
                    return {
                        status: 200,
                        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                        body: JSON.stringify(this.getStatus()),
                    }
                }

                if (pathname === '/api/health') {
                    return {
                        status: 200,
                        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                        body: JSON.stringify({ ok: true }),
                    }
                }

                return {
                    status: 404,
                    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                    body: JSON.stringify({ error: 'Not Found' }),
                }
            },
        })

        // 3. HTTP RPC endpoint
        this.routeRegistry.register({
            id: 'rpc',
            method: 'POST',
            path: '/api/rpc',
            order: 300,
            authenticate: true,
            handle: async (ctx: WebRouteContext): Promise<WebRouteResponse> => {
                let parsed: any
                try {
                    const bodyStr = ctx.request.body ? Buffer.from(ctx.request.body).toString('utf8') : ''
                    parsed = JSON.parse(bodyStr)
                } catch (err: unknown) {
                    const message = (err as Error)?.message || String(err)
                    return {
                        status: 200,
                        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                        body: JSON.stringify({ error: message }),
                    }
                }

                const result = await this.rpcTransport.handleHttpRequest(parsed, ctx.rpcContext)
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                    body: JSON.stringify(result),
                }
            },
        })

        // 4. Profiling endpoints
        this.routeRegistry.register({
            id: 'profiling',
            method: '*',
            path: '/api/profile/*,/debug/pprof/*,/api/profile,/debug/pprof',
            order: 400,
            authenticate: true,
            handle: async (ctx: WebRouteContext): Promise<WebRouteResponse> => {
                if (!this.profilingService || !this.profilingService.isEnabled()) {
                    return {
                        status: 403,
                        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                        body: JSON.stringify({ error: 'Profiling is disabled' }),
                    }
                }

                const parsedUrl = new URL(ctx.request.url || '/', 'http://localhost')
                const pathname = parsedUrl.pathname
                const rawReq = (ctx as any).rawRequest as http.IncomingMessage | undefined

                if (pathname === '/api/profile/start' && ctx.request.method === 'POST') {
                    let parsed: Record<string, unknown> = {}
                    const bodyStr = ctx.request.body ? Buffer.from(ctx.request.body).toString('utf8').trim() : ''
                    if (bodyStr.length > 0) {
                        try {
                            parsed = JSON.parse(bodyStr)
                        } catch {
                            return {
                                status: 400,
                                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                                body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }),
                            }
                        }
                        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                            return {
                                status: 400,
                                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                                body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }),
                            }
                        }
                    }

                    let target: 'main' | 'renderer' | 'all' | undefined
                    if (parsed.target !== undefined) {
                        if (parsed.target !== 'main' && parsed.target !== 'renderer' && parsed.target !== 'all') {
                            return {
                                status: 400,
                                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                                body: JSON.stringify({ ok: false, error: 'Invalid target parameter: must be main, renderer, or all' }),
                            }
                        }
                        target = parsed.target
                    }

                    let durationMs: number | undefined
                    if (parsed.durationMs !== undefined) {
                        if (typeof parsed.durationMs !== 'number' || !Number.isFinite(parsed.durationMs) || parsed.durationMs <= 0) {
                            return {
                                status: 400,
                                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                                body: JSON.stringify({ ok: false, error: 'Invalid durationMs parameter: must be a positive finite number' }),
                            }
                        }
                        durationMs = parsed.durationMs
                    }

                    try {
                        const result = await this.profilingService.start({ durationMs, target })
                        if (!result.ok) {
                            const isConflict = Boolean(result.message?.toLowerCase().includes('already active'))
                            const statusCode = isConflict ? 409 : 500
                            return {
                                status: statusCode,
                                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                                body: JSON.stringify({ ok: false, error: result.message }),
                            }
                        }
                        return {
                            status: 200,
                            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                            body: JSON.stringify({ ok: true, session: this.profilingService.getStatus() }),
                        }
                    } catch (err: unknown) {
                        const message = (err as Error)?.message || String(err)
                        return {
                            status: 500,
                            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                            body: JSON.stringify({ ok: false, error: message }),
                        }
                    }
                }

                if (pathname === '/api/profile/stop' && ctx.request.method === 'POST') {
                    try {
                        const result = await this.profilingService.stop()
                        if (!result.ok) {
                            return {
                                status: 400,
                                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                                body: JSON.stringify({ ok: false, error: result.error }),
                            }
                        }
                        return {
                            status: 200,
                            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                            body: JSON.stringify({
                                ok: true,
                                report: result.report,
                                raw: result.rawProfile,
                                rawProfile: result.rawProfile,
                            }),
                        }
                    } catch (err: unknown) {
                        const message = (err as Error)?.message || String(err)
                        return {
                            status: 500,
                            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                            body: JSON.stringify({ ok: false, error: message }),
                        }
                    }
                }

                if (pathname === '/api/profile/status' && ctx.request.method === 'GET') {
                    const status = this.profilingService.getStatus()
                    return {
                        status: 200,
                        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                        body: JSON.stringify({
                            ok: true,
                            running: status.running,
                            enabled: status.enabled,
                            durationMs: status.durationMs,
                            target: status.target,
                            startedAt: status.startedAt,
                            status,
                        }),
                    }
                }

                if (pathname === '/api/profile/report' && ctx.request.method === 'GET') {
                    const report = this.profilingService.getLastReport()
                    return {
                        status: 200,
                        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                        body: JSON.stringify({ ok: true, report: report ?? null }),
                    }
                }

                if (pathname === '/debug/pprof/profile' && ctx.request.method === 'GET') {
                    const rawFormat = parsedUrl.searchParams.get('format')
                    let format = 'json'
                    if (rawFormat !== null && rawFormat !== '') {
                        const fmt = rawFormat.toLowerCase()
                        if (fmt !== 'json' && fmt !== 'markdown' && fmt !== 'raw') {
                            return {
                                status: 400,
                                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                                body: JSON.stringify({ ok: false, error: 'Invalid format parameter: must be json, markdown, or raw' }),
                            }
                        }
                        format = fmt
                    }

                    const rawTarget = parsedUrl.searchParams.get('target')
                    let target: 'main' | 'renderer' | 'all' = 'all'
                    if (rawTarget !== null && rawTarget !== '') {
                        if (rawTarget !== 'main' && rawTarget !== 'renderer' && rawTarget !== 'all') {
                            return {
                                status: 400,
                                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                                body: JSON.stringify({ ok: false, error: 'Invalid target parameter: must be main, renderer, or all' }),
                            }
                        }
                        target = rawTarget
                    }

                    const rawSecParam = parsedUrl.searchParams.get('seconds')
                    const rawSec = rawSecParam !== null ? parseFloat(rawSecParam) : 5
                    const parsedSec = isNaN(rawSec) || rawSec <= 0 ? 5 : rawSec
                    const seconds = Math.min(Math.max(parsedSec, 0.05), 60)

                    let aborted = false
                    let sleepTimer: NodeJS.Timeout | null = null
                    let sleepResolve: (() => void) | null = null
                    let profilingStarted = false

                    const handleAbort = () => {
                        if (aborted) return
                        aborted = true
                        if (sleepTimer) {
                            clearTimeout(sleepTimer)
                            sleepTimer = null
                        }
                        if (sleepResolve) {
                            sleepResolve()
                            sleepResolve = null
                        }
                        if (profilingStarted) {
                            profilingStarted = false
                            this.profilingService?.stop().catch(() => {})
                        }
                    }

                    if (rawReq) {
                        rawReq.on('close', handleAbort)
                    }

                    try {
                        const startResult = await this.profilingService.start({
                            durationMs: Math.round((seconds + 5) * 1000),
                            target,
                        })

                        if (aborted) {
                            if (startResult.ok) {
                                await this.profilingService.stop().catch(() => {})
                            }
                            return { status: 499 }
                        }

                        if (!startResult.ok) {
                            const isConflict = Boolean(startResult.message?.toLowerCase().includes('already active'))
                            const statusCode = isConflict ? 409 : 500
                            return {
                                status: statusCode,
                                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                                body: JSON.stringify({ ok: false, error: startResult.message }),
                            }
                        }

                        profilingStarted = true

                        await new Promise<void>((resolve) => {
                            sleepResolve = resolve
                            sleepTimer = setTimeout(() => {
                                sleepTimer = null
                                sleepResolve = null
                                resolve()
                            }, Math.round(seconds * 1000))
                        })

                        if (aborted) {
                            return { status: 499 }
                        }

                        profilingStarted = false
                        let stopResult = await this.profilingService.stop()
                        if (!stopResult.ok && this.profilingService.getLastReport()) {
                            stopResult = {
                                ok: true,
                                report: this.profilingService.getLastReport(),
                                rawProfile: this.profilingService.getLastProfile(),
                            }
                        }

                        if (aborted) {
                            return { status: 499 }
                        }

                        if (!stopResult.ok) {
                            return {
                                status: 500,
                                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                                body: JSON.stringify({ ok: false, error: stopResult.error }),
                            }
                        }

                        if (format === 'raw') {
                            return {
                                status: 200,
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Cache-Control': 'no-store',
                                    'Content-Disposition': 'attachment; filename="profile.cpuprofile"',
                                },
                                body: JSON.stringify(stopResult.rawProfile || {}),
                            }
                        }

                        if (format === 'markdown') {
                            return {
                                status: 200,
                                headers: {
                                    'Content-Type': 'text/markdown; charset=utf-8',
                                    'Cache-Control': 'no-store',
                                },
                                body: stopResult.report ? ProfilingAnalyzer.formatMarkdown(stopResult.report) : '',
                            }
                        }

                        return {
                            status: 200,
                            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                            body: JSON.stringify(stopResult.report || { ok: true, rawProfile: stopResult.rawProfile }),
                        }
                    } catch (err: unknown) {
                        if (aborted) return { status: 499 }
                        const message = (err as Error)?.message || String(err)
                        return {
                            status: 500,
                            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                            body: JSON.stringify({ ok: false, error: message }),
                        }
                    } finally {
                        if (rawReq) {
                            rawReq.removeListener('close', handleAbort)
                        }
                    }
                }

                return {
                    status: 404,
                    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                    body: JSON.stringify({ error: 'Not Found' }),
                }
            },
        })

        // 5. Plugin resources endpoint
        this.routeRegistry.register({
            id: 'plugin-resources',
            method: 'GET',
            path: '/api/plugins/resources/*',
            order: 500,
            authenticate: true,
            handle: async (ctx: WebRouteContext): Promise<WebRouteResponse> => {
                const parsedUrl = new URL(ctx.request.url || '/', 'http://localhost')
                const subpath = parsedUrl.pathname.slice('/api/plugins/resources/'.length)
                return this.handlePluginResourceRequest(ctx, subpath)
            },
        })

        // 5b. Plugin resources endpoint (/v0/resource/plugins/*)
        this.routeRegistry.register({
            id: 'plugin-resources-v0',
            method: 'GET',
            path: '/v0/resource/plugins/*',
            order: 501,
            authenticate: true,
            handle: async (ctx: WebRouteContext): Promise<WebRouteResponse> => {
                const parsedUrl = new URL(ctx.request.url || '/', 'http://localhost')
                const subpath = parsedUrl.pathname.slice('/v0/resource/plugins/'.length)
                return this.handlePluginResourceRequest(ctx, subpath)
            },
        })

        // 6. Static files and SPA fallback
        this.routeRegistry.register({
            id: 'static',
            method: '*',
            path: '*',
            order: 600,
            authenticate: false,
            handle: async (ctx: WebRouteContext): Promise<WebRouteResponse> => {
                const distDir = this.resolveDistDir()
                if (!distDir) {
                    return {
                        status: 200,
                        headers: { 'Content-Type': 'text/html; charset=utf-8' },
                        body: `<!DOCTYPE html>
<html>
<head><title>Coding Professional Agent</title></head>
<body style="font-family: sans-serif; background: #06070f; color: #fff; padding: 40px; text-align: center;">
  <h2>Coding Professional Agent Web Server</h2>
  <p>Frontend assets are not yet built in <code>frontend/dist</code>.</p>
  <p>Run <code>pnpm --dir frontend build</code> to build the web frontend.</p>
</body>
</html>`,
                    }
                }

                const parsedUrl = new URL(ctx.request.url || '/', 'http://localhost')
                const pathname = parsedUrl.pathname
                let sanitizedPath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '')
                if (sanitizedPath.startsWith('/')) {
                    sanitizedPath = sanitizedPath.slice(1)
                }

                let filePath = path.join(distDir, sanitizedPath)

                try {
                    let stats: fsSync.Stats | null = null
                    if (fsSync.existsSync(filePath)) {
                        stats = await fs.stat(filePath)
                    }

                    // Directory index or SPA fallback
                    if (!stats || stats.isDirectory()) {
                        const indexHtmlPath = path.join(distDir, 'index.html')
                        if (fsSync.existsSync(indexHtmlPath)) {
                            filePath = indexHtmlPath
                            stats = await fs.stat(indexHtmlPath)
                        } else {
                            return {
                                status: 404,
                                headers: { 'Content-Type': 'text/plain' },
                                body: 'Not Found',
                            }
                        }
                    }

                    const ext = path.extname(filePath).toLowerCase()
                    const contentType = MIME_TYPES[ext] || 'application/octet-stream'
                    const fileData = await fs.readFile(filePath)

                    return {
                        status: 200,
                        headers: {
                            'Content-Type': contentType,
                            'Content-Length': String(fileData.length),
                            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
                        },
                        body: fileData,
                    }
                } catch (err) {
                    return {
                        status: 500,
                        headers: { 'Content-Type': 'text/plain' },
                        body: `Internal Server Error: ${(err as Error)?.message || err}`,
                    }
                }
            },
        })
    }

    setProfilingService(service: ProfilingService): void {
        this.profilingService = service
    }

    setPluginResourceService(service: PluginResourceService): void {
        this.pluginResourceService = service
    }

    private async handlePluginResourceRequest(
        ctx: WebRouteContext,
        subpath: string,
    ): Promise<WebRouteResponse> {
        if (!this.pluginResourceService) {
            return {
                status: 404,
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                body: JSON.stringify({ error: 'Plugin resource service not available' }),
            }
        }

        const slashIndex = subpath.indexOf('/')
        let packageKey = ''
        let resourcePath = ''

        if (slashIndex === -1) {
            packageKey = decodeURIComponent(subpath)
            resourcePath = ''
        } else {
            packageKey = decodeURIComponent(subpath.slice(0, slashIndex))
            resourcePath = decodeURIComponent(subpath.slice(slashIndex + 1))
        }

        if (!packageKey || !resourcePath) {
            return {
                status: 400,
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                body: JSON.stringify({ error: 'Invalid plugin resource path' }),
            }
        }

        const parsedUrl = new URL(ctx.request.url || '/', 'http://localhost')
        const rev = parsedUrl.searchParams.get('rev') || parsedUrl.searchParams.get('revision') || undefined

        try {
            const resource = await this.pluginResourceService.readResource(packageKey, resourcePath, rev)
            return {
                status: 200,
                headers: {
                    'Content-Type': resource.contentType,
                    'Content-Length': String(resource.body.length),
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': rev ? 'public, max-age=31536000, immutable' : 'no-cache',
                },
                body: resource.body,
            }
        } catch (err: any) {
            const errMsg = err?.message || 'Resource error'
            const isEscape = errMsg.includes('escapes source root')
            const isRevisionMismatch = errMsg.includes('revision mismatch')
            const status = isEscape ? 403 : isRevisionMismatch ? 409 : 404
            return {
                status,
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                body: JSON.stringify({ error: errMsg }),
            }
        }
    }

    setOnClientDisconnect(callback: (clientId: string) => void): void {
        this.onClientDisconnectCallback = callback
    }

    setRpcDispatcher(dispatcher: RpcDispatcher): void {
        this.rpcTransport.setDispatcher(dispatcher)
    }

    getRouteRegistry(): WebRouteRegistry {
        return this.routeRegistry
    }

    getRpcTransport(): WebRpcTransport {
        return this.rpcTransport
    }

    getIdentityAdapter(): WebIdentityAdapter {
        return this.identityAdapter
    }

    registerRoute(route: WebRouteContribution): () => void {
        return this.routeRegistry.register(route)
    }

    configure(config?: Partial<WebServerSettings>): void {
        if (config?.host && typeof config.host === 'string' && config.host.trim()) {
            this.currentHost = config.host.trim()
        }
        if (typeof config?.port === 'number' && Number.isFinite(config.port) && config.port >= 1 && config.port <= 65535) {
            this.currentPort = Math.floor(config.port)
        }
        this.applyPasswordConfig(config)
    }

    getStatus(): WebServerStatus {
        return {
            running: this.running,
            host: this.currentHost,
            port: this.currentPort,
            url: this.running ? `http://${this.currentHost}:${this.currentPort}` : '',
            error: this.lastError,
            isDebug: this.isDebug,
        }
    }

    broadcastEvent(event: NativeEvent, excludeClientId?: string): void {
        if (!this.running || this.clients.size === 0) {
            return
        }
        const payload = JSON.stringify({ type: 'event', event })
        for (const client of this.clients) {
            if (excludeClientId && this.clientIds.get(client) === excludeClientId) {
                continue
            }
            if (client.readyState === 1) { // WebSocket.OPEN
                try {
                    client.send(payload)
                } catch {
                    // Ignore send errors for closing clients
                }
            }
        }
    }

    private resolveDistDir(): string | null {
        if (this.customDistDir && fsSync.existsSync(this.customDistDir)) {
            return this.customDistDir
        }

        const candidates = [
            path.resolve(__dirname, '../../../../frontend/dist'),
            path.resolve(__dirname, '../../../frontend/dist'),
            path.resolve(__dirname, '../../frontend/dist'),
            path.resolve(process.cwd(), 'frontend/dist'),
            path.resolve(__dirname, '../renderer'),
            path.resolve(process.cwd(), 'dist'),
        ]

        for (const candidate of candidates) {
            if (fsSync.existsSync(candidate)) {
                return candidate
            }
        }

        return null
    }

    async start(config?: Partial<WebServerSettings>): Promise<WebServerStatus> {
        const host = (config?.host || this.currentHost || '127.0.0.1').trim()
        const port = typeof config?.port === 'number' && Number.isFinite(config.port) && config.port >= 0
            ? Math.floor(config.port)
            : this.currentPort || 18080

        this.applyPasswordConfig(config)

        // If already running on identical host and port, return current status
        if (this.running && this.server && this.currentHost === host && this.currentPort === port) {
            return this.getStatus()
        }

        // If running on different config, stop previous instance first
        if (this.running) {
            await this.stop()
        }

        this.currentHost = host
        this.currentPort = port
        this.lastError = undefined

        return new Promise<WebServerStatus>((resolve) => {
            const server = http.createServer(async (req, res) => {
                // Apply authentication mode CORS headers
                if (!this.auth.isRequired()) {
                    res.setHeader('Access-Control-Allow-Origin', '*')
                    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD')
                    res.setHeader('Access-Control-Allow-Headers', '*')
                } else {
                    const origin = req.headers.origin
                    if (origin && this.auth.isSameOrigin(req)) {
                        res.setHeader('Access-Control-Allow-Origin', Array.isArray(origin) ? origin[0] : origin)
                    }
                    res.setHeader('Vary', 'Origin')
                    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD')
                    res.setHeader('Access-Control-Allow-Headers', '*')
                }

                const reqUrl = req.url || '/'
                const parsedUrl = new URL(reqUrl, `http://${req.headers.host || 'localhost'}`)
                const pathname = parsedUrl.pathname

                // Dynamic route detection for protection and cache headers
                const isDynamicRoute =
                    pathname === '/api' ||
                    pathname === '/debug' ||
                    pathname.startsWith('/api/') ||
                    pathname.startsWith('/debug/')

                if (isDynamicRoute) {
                    res.setHeader('Cache-Control', 'no-store')
                }

                const method = req.method || 'GET'
                const route = this.routeRegistry.match(method, pathname)

                // Protected API and debug routes
                const isProtected = route !== undefined ? route.authenticate : isDynamicRoute
                if (isProtected && this.auth.isRequired()) {
                    if (!this.auth.isSameOrigin(req)) {
                        this.writeJson(res, 403, { error: 'Forbidden' })
                        return
                    }
                    if (!this.auth.isAuthenticated(req)) {
                        this.writeJson(res, 401, { error: 'Unauthorized' })
                        return
                    }
                }

                if (method === 'OPTIONS') {
                    res.writeHead(204)
                    res.end()
                    return
                }

                if (!route) {
                    this.writeJson(res, 404, { error: 'Not Found' })
                    return
                }

                let bodyBuffer: Uint8Array | undefined
                try {
                    bodyBuffer = await this.readRequestBody(req)
                } catch (err) {
                    const isTooLarge = err instanceof RangeError
                    const status = isTooLarge ? 413 : 400
                    this.writeJson(res, status, {
                        error: isTooLarge ? 'Request body too large' : 'Invalid request body',
                    })
                    return
                }

                const webReq: WebRouteRequest = {
                    method,
                    url: reqUrl,
                    headers: req.headers,
                    body: bodyBuffer,
                }

                const routeContext = this.identityAdapter.createRouteContext(webReq)
                ;(routeContext as any).rawRequest = req

                try {
                    const response = await route.handle(routeContext)
                    if (res.writableEnded || res.destroyed) return

                    if (response) {
                        res.writeHead(response.status, response.headers as any)
                        if (response.body !== undefined) {
                            res.end(response.body)
                        } else {
                            res.end()
                        }
                    }
                } catch (err: unknown) {
                    if (res.writableEnded || res.destroyed) return
                    const message = (err as Error)?.message || String(err)
                    this.writeJson(res, 500, { ok: false, error: message })
                }
            })

            // WebSocket server setup
            const wss = new WebSocketServer({ noServer: true })

            server.on('upgrade', (request, socket, head) => {
                const parsedUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
                const pathname = parsedUrl.pathname
                // Handle WebSocket upgrade on /api/ws, /ws, or /
                if (pathname === '/api/ws' || pathname === '/ws' || pathname === '/') {
                    if (this.auth.isRequired()) {
                        const sameOrigin = this.auth.isSameOrigin(request)
                        const authenticated = this.auth.isAuthenticated(request)
                        if (!sameOrigin || !authenticated) {
                            const status = sameOrigin ? 401 : 403
                            const reason = sameOrigin ? 'Unauthorized' : 'Forbidden'
                            const body = JSON.stringify({ error: reason })
                            const response =
                                `HTTP/1.1 ${status} ${reason}\r\n` +
                                'Connection: close\r\n' +
                                'Content-Type: application/json\r\n' +
                                'Cache-Control: no-store\r\n' +
                                `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                                '\r\n' +
                                body
                            socket.end(response)
                            return
                        }
                    }
                    wss.handleUpgrade(request, socket, head, (ws) => {
                        wss.emit('connection', ws, request)
                    })
                } else {
                    const body = JSON.stringify({ error: 'Not Found' })
                    const response =
                        'HTTP/1.1 404 Not Found\r\n' +
                        'Connection: close\r\n' +
                        'Content-Type: application/json\r\n' +
                        'Cache-Control: no-store\r\n' +
                        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                        '\r\n' +
                        body
                    socket.end(response)
                }
            })

            wss.on('connection', (ws) => {
                const clientId = this.identityAdapter.generateWsClientId()
                this.clients.add(ws)
                this.clientIds.set(ws, clientId)

                // Send hello immediately on connection
                try {
                    ws.send(JSON.stringify({ type: 'hello', clientId }))
                } catch {
                    // Ignore send error for closing connection
                }

                let disconnected = false
                const handleDisconnect = () => {
                    if (disconnected) return
                    disconnected = true
                    this.clients.delete(ws)
                    this.clientIds.delete(ws)
                    this.onClientDisconnectCallback?.(clientId)
                }

                ws.on('message', async (data) => {
                    try {
                        const rawMsg = data.toString()
                        const res = await this.rpcTransport.handleWsMessage(rawMsg, { clientId })
                        if (res.response && ws.readyState === 1) { // WebSocket.OPEN
                            ws.send(JSON.stringify(res.response))
                        }
                    } catch (err) {
                        console.error('Error handling WebSocket message:', err)
                    }
                })

                ws.on('close', () => {
                    handleDisconnect()
                })

                ws.on('error', () => {
                    handleDisconnect()
                })
            })

            server.once('error', (err: NodeJS.ErrnoException) => {
                this.running = false
                this.server = null
                this.wss = null
                this.lastError = err.code === 'EADDRINUSE'
                    ? `Port ${port} is already in use`
                    : err.message || 'Failed to start Web Server'
                resolve(this.getStatus())
            })

            server.listen(port, host, () => {
                this.running = true
                this.server = server
                this.wss = wss
                const addr = server.address()
                if (typeof addr === 'object' && addr && addr.port) {
                    this.currentPort = addr.port
                }
                this.lastError = undefined
                resolve(this.getStatus())
            })
        })
    }

    async stop(): Promise<WebServerStatus> {
        if (!this.running && !this.server) {
            this.auth.clearSessions()
            return this.getStatus()
        }

        const authRequired = this.auth.isRequired()

        // Close all active client WebSockets
        for (const client of this.clients) {
            try {
                if (authRequired) {
                    client.close(4401, 'Web authentication required')
                } else {
                    client.close()
                }
            } catch {
                // Ignore close errors
            }
        }
        this.clients.clear()
        this.clientIds.clear()

        if (this.wss) {
            try {
                this.wss.close()
            } catch {
                // Ignore close errors
            }
            this.wss = null
        }

        if (this.server) {
            await new Promise<void>((resolve) => {
                this.server?.close(() => {
                    resolve()
                })
            })
            this.server = null
        }

        this.running = false
        this.lastError = undefined
        this.auth.clearSessions()
        return this.getStatus()
    }

    dispose(): void {
        void this.stop()
    }
}
