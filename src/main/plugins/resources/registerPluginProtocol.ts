import { protocol } from 'electron'
import type { PluginResourceService } from './PluginResourceService.js'

let schemesRegistered = false

/**
 * Register the cpa-plugin custom scheme as privileged.
 * Must be called before Electron app is ready.
 */
export function registerPluginSchemesAsPrivileged(): void {
    if (schemesRegistered || !protocol?.registerSchemesAsPrivileged) {
        return
    }
    try {
        protocol.registerSchemesAsPrivileged([
            {
                scheme: 'cpa-plugin',
                privileges: {
                    standard: true,
                    secure: true,
                    allowServiceWorkers: false,
                    supportFetchAPI: true,
                    corsEnabled: true,
                    stream: true,
                },
            },
        ])
        schemesRegistered = true
    } catch {
        // Scheme may have already been registered by bootstrapper
    }
}

/**
 * Register protocol handler for cpa-plugin:// URIs.
 * Translates cpa-plugin://<package-id>/<relative-resource> into guarded local filesystem reads.
 */
export function registerPluginProtocol(resourceService: PluginResourceService): void {
    if (!protocol?.handle) {
        return
    }

    protocol.handle('cpa-plugin', async (request: Request) => {
        try {
            const url = new URL(request.url)
            let packageKey = ''
            let resourcePath = ''

            if (url.hostname && url.hostname.length > 0) {
                packageKey = decodeURIComponent(url.hostname)
                resourcePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
            } else {
                const segments = url.pathname.replace(/^\/+/, '').split('/')
                packageKey = decodeURIComponent(segments[0] || '')
                resourcePath = decodeURIComponent(segments.slice(1).join('/'))
            }

            if (!packageKey || !resourcePath) {
                return new Response('Invalid cpa-plugin URL', {
                    status: 400,
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                })
            }

            const resource = await resourceService.readResource(packageKey, resourcePath)

            return new Response(new Uint8Array(resource.body), {
                status: 200,
                headers: {
                    'Content-Type': resource.contentType,
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                    'Cache-Control': 'no-cache',
                },
            })
        } catch (err: any) {
            const errMsg = err?.message || 'Plugin resource error'
            const isEscape = errMsg.includes('escapes source root')
            const status = isEscape ? 403 : 404

            return new Response(errMsg, {
                status,
                headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Access-Control-Allow-Origin': '*',
                },
            })
        }
    })
}
