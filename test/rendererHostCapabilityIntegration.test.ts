import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'

const ipcHandlers = new Map<string, (...args: any[]) => any>()

vi.mock('electron', () => ({
    ipcMain: {
        handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
            ipcHandlers.set(channel, handler)
        }),
        removeHandler: vi.fn((channel: string) => {
            ipcHandlers.delete(channel)
        }),
    },
}))

import { MainCapabilityBroker } from '../src/main/plugins/capabilities/MainCapabilityBroker.js'
import { registerCapabilityTransport, isControlledAppUrl } from '../src/main/ipc/registerCapabilityTransport.js'
import { createHostCapabilityFacade } from '../src/shared/capabilityDescriptors.js'
import type { HostTransportApi, NativeEvent } from '../src/shared/types.js'
import { getHostTransport, isNativeRuntime, isDevMode } from '../frontend/src/application/services/hostTransport.js'

describe('Renderer Host Capability and Transport Integration', () => {
    let broker: MainCapabilityBroker
    let unregisterTransport: () => void
    let mockServices: any
    let mockMainWindow: any
    let mockWebContents: any
    let navigationListeners: Array<(evt: any) => void>

    beforeEach(() => {
        ipcHandlers.clear()
        navigationListeners = []
        broker = new MainCapabilityBroker()
        mockServices = {
            handleMethod: vi.fn().mockImplementation(async (method: string, args: unknown[]) => {
                if (method === 'native:readFile') {
                    return { dataBase64: 'dGVzdC1kYXRh' }
                }
                if (method === 'kv:get') {
                    return { key: args[0], value: 'mock_val' }
                }
                if (method === 'profiling:getStatus') {
                    return { running: false, enabled: true, target: 'all' }
                }
                return { ok: true, method, args }
            }),
        }

        mockWebContents = {
            id: 101,
            isDestroyed: () => false,
            getURL: () => 'file:///app/index.html',
            send: vi.fn(),
            on: vi.fn((event: string, listener: any) => {
                if (event === 'did-start-navigation') {
                    navigationListeners.push(listener)
                }
            }),
            once: vi.fn(),
            removeListener: vi.fn((event: string, listener: any) => {
                if (event === 'did-start-navigation') {
                    const idx = navigationListeners.indexOf(listener)
                    if (idx !== -1) {
                        navigationListeners.splice(idx, 1)
                    }
                }
            }),
        }

        mockMainWindow = {
            isDestroyed: () => false,
            webContents: mockWebContents,
        }

        unregisterTransport = registerCapabilityTransport({
            broker,
            services: mockServices,
            getMainWindow: () => mockMainWindow,
            trustedFilePaths: ['/app/index.html'],
        })
    })

    afterEach(() => {
        if (unregisterTransport) {
            unregisterTransport()
        }
    })

    it('rejects direct invoke with legacy static handle "desktop-main"', async () => {
        const invokeHandler = ipcHandlers.get('cpa:capability:invoke')
        expect(invokeHandler).toBeDefined()

        const mockEvent = {
            sender: mockWebContents,
            senderFrame: {
                parent: null,
                url: 'file:///app/index.html',
                routingId: 1,
                processId: 1001,
            },
        }

        // Direct call using static 'desktop-main' handle must fail
        const res = await invokeHandler(mockEvent, {
            handle: 'desktop-main',
            method: 'native:readFile',
            args: ['/path/file.txt'],
        })

        expect(res.ok).toBe(false)
        expect(res.error?.message).toMatch(/Invalid or expired capability handle/)
    })

    it('supports one-time bootstrap claim issuing random opaque cap_* handle', async () => {
        const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')
        expect(bootstrapHandler, 'cpa:capability:bootstrap channel must be registered').toBeDefined()

        const mockEvent = {
            sender: mockWebContents,
            senderFrame: {
                parent: null,
                url: 'file:///app/index.html',
                routingId: 1,
                processId: 1001,
            },
        }

        const bootstrapRes = await bootstrapHandler(mockEvent)
        expect(bootstrapRes.ok).toBe(true)
        expect(bootstrapRes.value).toBeDefined()
        expect(typeof bootstrapRes.value).toBe('string')
        expect(bootstrapRes.value).toMatch(/^cap_[a-f0-9]+$/i)
        expect(bootstrapRes.value).not.toBe('desktop-main')

        const opaqueHandle = bootstrapRes.value

        // Invocations with the issued opaque handle succeed
        const invokeHandler = ipcHandlers.get('cpa:capability:invoke')
        const invokeRes = await invokeHandler(mockEvent, {
            handle: opaqueHandle,
            method: 'native:readFile',
            args: ['/path/file.txt'],
        })

        expect(invokeRes.ok).toBe(true)
        expect(invokeRes.value).toEqual({ dataBase64: 'dGVzdC1kYXRh' })
    })

    it('returns the same valid host handle on duplicate bootstrap claim', async () => {
        const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')
        expect(bootstrapHandler).toBeDefined()

        const mockEvent = {
            sender: mockWebContents,
            senderFrame: {
                parent: null,
                url: 'file:///app/index.html',
                routingId: 1,
                processId: 1001,
            },
        }

        const firstClaim = await bootstrapHandler(mockEvent)
        expect(firstClaim.ok).toBe(true)

        const duplicateClaim = await bootstrapHandler(mockEvent)
        expect(duplicateClaim.ok).toBe(true)
        expect(duplicateClaim.value).toBe(firstClaim.value)
    })

    it('re-grants a fresh host handle after the previous one was revoked', async () => {
        const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')
        const invokeHandler = ipcHandlers.get('cpa:capability:invoke')
        expect(bootstrapHandler).toBeDefined()

        const mockEvent = {
            sender: mockWebContents,
            senderFrame: {
                parent: null,
                url: 'file:///app/index.html',
                routingId: 1,
                processId: 1001,
            },
        }

        const firstClaim = await bootstrapHandler(mockEvent)
        expect(firstClaim.ok).toBe(true)
        const firstHandle = firstClaim.value as string

        broker.revokeHandle(firstHandle as any)

        const expired = await invokeHandler(mockEvent, {
            handle: firstHandle,
            method: 'native:readFile',
            args: ['/path/file.txt'],
        })
        expect(expired.ok).toBe(false)
        expect(expired.error?.message).toMatch(/Invalid or expired capability handle/)

        const reclaimed = await bootstrapHandler(mockEvent)
        expect(reclaimed.ok).toBe(true)
        expect(reclaimed.value).toBeTruthy()
        expect(reclaimed.value).not.toBe(firstHandle)

        const invokeRes = await invokeHandler(mockEvent, {
            handle: reclaimed.value,
            method: 'native:readFile',
            args: ['/path/file.txt'],
        })
        expect(invokeRes.ok).toBe(true)
    })

    it('rejects bootstrap claim from child frame (iframe) or wrong window', async () => {
        const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')
        expect(bootstrapHandler).toBeDefined()

        // 1. Child frame with parent !== null
        const childFrameEvent = {
            sender: mockWebContents,
            senderFrame: {
                parent: { routingId: 1 },
                url: 'file:///app/iframe.html',
                routingId: 2,
                processId: 1001,
            },
        }
        const childRes = await bootstrapHandler(childFrameEvent)
        expect(childRes.ok).toBe(false)
        expect(childRes.error?.message).toMatch(/top-level frame/i)

        // 2. Wrong window / webContents
        const otherWebContents = {
            id: 999,
            isDestroyed: () => false,
            getURL: () => 'file:///other.html',
            send: vi.fn(),
            on: vi.fn(),
            once: vi.fn(),
        }
        const otherWindowEvent = {
            sender: otherWebContents,
            senderFrame: {
                parent: null,
                url: 'file:///other.html',
                routingId: 1,
                processId: 9999,
            },
        }
        const wrongWindowRes = await bootstrapHandler(otherWindowEvent)
        expect(wrongWindowRes.ok).toBe(false)
        expect(wrongWindowRes.error?.message).toMatch(/main window/i)
    })

    it('rejects bootstrap claim from untrusted external URL', async () => {
        const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')
        expect(bootstrapHandler).toBeDefined()

        const untrustedUrlEvent = {
            sender: mockWebContents,
            senderFrame: {
                parent: null,
                url: 'https://evil-attacker.example.com/phish',
                routingId: 1,
                processId: 1001,
            },
        }

        const res = await bootstrapHandler(untrustedUrlEvent)
        expect(res.ok).toBe(false)
        expect(res.error?.message).toMatch(/untrusted frame url/i)
    })

    describe('Strict host bootstrap origin validation', () => {
        it('rejects empty, whitespace, and undefined frame URLs', async () => {
            const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')
            expect(bootstrapHandler).toBeDefined()

            for (const badUrl of ['', '   ', undefined as any]) {
                const event = {
                    sender: mockWebContents,
                    senderFrame: {
                        parent: null,
                        url: badUrl,
                        routingId: 1,
                        processId: 1001,
                    },
                }
                const res = await bootstrapHandler(event)
                expect(res.ok).toBe(false)
                expect(res.error?.message).toMatch(/untrusted frame url/i)
            }
        })

        it('rejects cpa-plugin: URLs even from mainWindow top frame', async () => {
            const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')
            expect(bootstrapHandler).toBeDefined()

            const pluginEvent = {
                sender: mockWebContents,
                senderFrame: {
                    parent: null,
                    url: 'cpa-plugin://cpa.core.chat/index.html',
                    routingId: 1,
                    processId: 1001,
                },
            }

            const res = await bootstrapHandler(pluginEvent)
            expect(res.ok).toBe(false)
            expect(res.error?.message).toMatch(/untrusted frame url/i)
        })

        it('rejects unauthorized file URLs (attacker paths, prefix confusion, sibling files)', async () => {
            const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')
            expect(bootstrapHandler).toBeDefined()

            const badFileUrls = [
                'file:///tmp/attacker/index.html',
                'file:///evil/payload.html',
                'file:///app/index.html.attacker.js',
                'file:///app/index.html/nested.html',
                'file:///app/sibling.html',
                'file:///app/dist/../../tmp/attacker/index.html',
            ]

            for (const badUrl of badFileUrls) {
                const event = {
                    sender: mockWebContents,
                    senderFrame: {
                        parent: null,
                        url: badUrl,
                        routingId: 1,
                        processId: 1001,
                    },
                }
                const res = await bootstrapHandler(event)
                expect(res.ok, `Expected ${badUrl} to be rejected`).toBe(false)
                expect(res.error?.message).toMatch(/untrusted frame url/i)
            }
        })

        it('rejects localhost with wrong port/origin and malformed same-origin URLs', async () => {
            if (unregisterTransport) unregisterTransport()
            unregisterTransport = registerCapabilityTransport({
                broker,
                services: mockServices,
                getMainWindow: () => mockMainWindow,
                trustedUrls: ['http://localhost:5173/'],
            })
            const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')

            // SPA routes on the trusted origin must be accepted
            for (const goodUrl of [
                'http://localhost:5173/chat/session-123',
                'http://localhost:5173/scheduled',
                'http://localhost:5173/attacker',
            ]) {
                const event = {
                    sender: mockWebContents,
                    senderFrame: {
                        parent: null,
                        url: goodUrl,
                        routingId: 1,
                        processId: 1001,
                    },
                }
                const res = await bootstrapHandler(event)
                expect(res.ok, `Expected ${goodUrl} to be accepted`).toBe(true)
            }

            // Malformed payloads and wrong origins/ports remain rejected
            const badUrls = [
                'http://localhost:5173/%2e%2e/index.html',
                'http://localhost:5173//evil',
                'http://localhost:5173/%00index.html',
                'http://localhost:5173/index%2fhtml',
                'http://localhost:5173/index%5chtml',
                'http://localhost:5173\\evil',
                '//localhost:5173/',
                'http://admin:pass@localhost:5173/',
                'http://localhost:9999/attacker',
                'http://localhost:3000/',
                'http://127.0.0.1:9999/',
                'http://localhost.attacker.com:5173/',
                'https://evil.example.com/',
            ]

            for (const badUrl of badUrls) {
                const event = {
                    sender: mockWebContents,
                    senderFrame: {
                        parent: null,
                        url: badUrl,
                        routingId: 1,
                        processId: 1001,
                    },
                }
                const res = await bootstrapHandler(event)
                expect(res.ok, `Expected ${badUrl} to be rejected`).toBe(false)
                expect(res.error?.message).toMatch(/untrusted frame url/i)
            }
        })

        it('does NOT trust dynamic webContents.getURL() when mainWindow navigates to an attacker page', async () => {
            // Simulate mainWindow navigated to evil.com
            mockWebContents.getURL = () => 'https://evil.attacker.com/malicious'

            const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')
            const event = {
                sender: mockWebContents,
                senderFrame: {
                    parent: null,
                    url: 'https://evil.attacker.com/malicious',
                    routingId: 1,
                    processId: 1001,
                },
            }

            const res = await bootstrapHandler(event)
            expect(res.ok).toBe(false)
            expect(res.error?.message).toMatch(/untrusted frame url/i)
        })

        it('rejects arbitrary cpa: URLs unless exact shell URL is explicitly configured', async () => {
            const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')

            const arbitraryCpaEvent = {
                sender: mockWebContents,
                senderFrame: {
                    parent: null,
                    url: 'cpa://attacker/steal',
                    routingId: 1,
                    processId: 1001,
                },
            }
            const res1 = await bootstrapHandler(arbitraryCpaEvent)
            expect(res1.ok).toBe(false)
            expect(res1.error?.message).toMatch(/untrusted frame url/i)

            // When exact shell URL is configured
            if (unregisterTransport) unregisterTransport()
            unregisterTransport = registerCapabilityTransport({
                broker,
                services: mockServices,
                getMainWindow: () => mockMainWindow,
                trustedUrls: ['cpa://app/index.html'],
            })
            const freshBootstrap = ipcHandlers.get('cpa:capability:bootstrap')

            // Configured exact shell URL works (with hash/query)
            const goodCpaEvent = {
                sender: mockWebContents,
                senderFrame: {
                    parent: null,
                    url: 'cpa://app/index.html#/chat?theme=dark',
                    routingId: 1,
                    processId: 1001,
                },
            }
            const res2 = await freshBootstrap(goodCpaEvent)
            expect(res2.ok).toBe(true)

            // Sibling or attacker cpa: URL is still rejected
            const siblingCpaEvent = {
                sender: mockWebContents,
                senderFrame: {
                    parent: null,
                    url: 'cpa://app/other.html',
                    routingId: 2,
                    processId: 1001,
                },
            }
            const res3 = await freshBootstrap(siblingCpaEvent)
            expect(res3.ok).toBe(false)
        })

        it('accepts official production frontend/dist/index.html with valid hash/query and handles percent encoding', async () => {
            const canonicalDistHtml = path.resolve(__dirname, '../frontend/dist/index.html')
            if (unregisterTransport) unregisterTransport()
            unregisterTransport = registerCapabilityTransport({
                broker,
                services: mockServices,
                getMainWindow: () => mockMainWindow,
                trustedFilePaths: [canonicalDistHtml],
            })
            const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')

            // Valid canonical file URL formats with queries and hashes
            const validUrls = [
                `file://${canonicalDistHtml}`,
                `file://${canonicalDistHtml}#/sessions/current`,
                `file://${canonicalDistHtml}?env=production#/settings`,
                `file://${canonicalDistHtml}?token=abc&theme=dark#/subagent`,
            ]

            let routing = 100
            for (const validUrl of validUrls) {
                const event = {
                    sender: mockWebContents,
                    senderFrame: {
                        parent: null,
                        url: validUrl,
                        routingId: ++routing,
                        processId: 1001,
                    },
                }
                const res = await bootstrapHandler(event)
                expect(res.ok, `Expected ${validUrl} to be accepted`).toBe(true)
            }
        })

        it('accepts explicitly configured webserver origin including SPA routes and rejects wrong ports/malformed URLs', async () => {
            if (unregisterTransport) unregisterTransport()
            unregisterTransport = registerCapabilityTransport({
                broker,
                services: mockServices,
                getMainWindow: () => mockMainWindow,
                trustedUrls: ['http://127.0.0.1:18080/'],
            })
            const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')

            // Allowed webserver origin paths (SPA routes, query, and hash)
            const allowedUrls = [
                'http://127.0.0.1:18080/',
                'http://127.0.0.1:18080/#/chat',
                'http://127.0.0.1:18080/?theme=dark#/sessions',
                'http://127.0.0.1:18080/chat/session-1',
                'http://127.0.0.1:18080/attacker',
            ]

            let routing = 500
            for (const allowedUrl of allowedUrls) {
                const event = {
                    sender: mockWebContents,
                    senderFrame: {
                        parent: null,
                        url: allowedUrl,
                        routingId: ++routing,
                        processId: 1001,
                    },
                }
                const res = await bootstrapHandler(event)
                expect(res.ok, `Expected ${allowedUrl} to be accepted`).toBe(true)
            }

            // Malformed same-origin URLs and wrong ports remain rejected
            const disallowedUrls = [
                'http://127.0.0.1:18080/%2e%2e/index.html',
                'http://127.0.0.1:18080//evil',
                'http://127.0.0.1:18081/#/chat',
            ]

            for (const badUrl of disallowedUrls) {
                const event = {
                    sender: mockWebContents,
                    senderFrame: {
                        parent: null,
                        url: badUrl,
                        routingId: ++routing,
                        processId: 1001,
                    },
                }
                const res = await bootstrapHandler(event)
                expect(res.ok, `Expected ${badUrl} to be rejected`).toBe(false)
            }
        })

        it('accepts any path on a configured http(s) origin (pathname in trustedUrls is ignored)', async () => {
            if (unregisterTransport) unregisterTransport()
            unregisterTransport = registerCapabilityTransport({
                broker,
                services: mockServices,
                getMainWindow: () => mockMainWindow,
                trustedUrls: ['http://localhost:5173/index.html'],
            })
            const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')

            // Origin trust: both /index.html and SPA routes are accepted
            const goodUrls = [
                'http://localhost:5173/index.html?token=123#/sessions',
                'http://localhost:5173/',
                'http://localhost:5173/chat/session-1',
                'http://localhost:5173/attacker',
            ]

            let routing = 600
            for (const goodUrl of goodUrls) {
                const event = {
                    sender: mockWebContents,
                    senderFrame: {
                        parent: null,
                        url: goodUrl,
                        routingId: ++routing,
                        processId: 1001,
                    },
                }
                const res = await bootstrapHandler(event)
                expect(res.ok, `Expected ${goodUrl} to be accepted`).toBe(true)
            }

            // Malformed URLs remain rejected
            const badUrls = [
                'http://localhost:5173/%2e%2e/index.html',
                'http://localhost:5173//evil',
            ]

            for (const badUrl of badUrls) {
                const event = {
                    sender: mockWebContents,
                    senderFrame: {
                        parent: null,
                        url: badUrl,
                        routingId: ++routing,
                        processId: 1001,
                    },
                }
                const res = await bootstrapHandler(event)
                expect(res.ok, `Expected ${badUrl} to be rejected`).toBe(false)
            }
        })

        it('falls back to environment variable origin matching including SPA routes', async () => {
            const originalDevUrl = process.env.VITE_DEV_SERVER_URL
            try {
                process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173/'
                if (unregisterTransport) unregisterTransport()
                unregisterTransport = registerCapabilityTransport({
                    broker,
                    services: mockServices,
                    getMainWindow: () => mockMainWindow,
                    // No explicit trustedUrls -> should fallback to env
                })
                const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')

                // Allowed dev root and SPA client route via env fallback
                const resAllowed = await bootstrapHandler({
                    sender: mockWebContents,
                    senderFrame: {
                        parent: null,
                        url: 'http://localhost:5173/#/chat',
                        routingId: 701,
                        processId: 1001,
                    },
                })
                expect(resAllowed.ok).toBe(true)

                const resSpa = await bootstrapHandler({
                    sender: mockWebContents,
                    senderFrame: {
                        parent: null,
                        url: 'http://localhost:5173/chat/session-abc',
                        routingId: 702,
                        processId: 1001,
                    },
                })
                expect(resSpa.ok).toBe(true)

                // Wrong origin still rejected
                const resBad = await bootstrapHandler({
                    sender: mockWebContents,
                    senderFrame: {
                        parent: null,
                        url: 'http://localhost:9999/',
                        routingId: 703,
                        processId: 1001,
                    },
                })
                expect(resBad.ok).toBe(false)
            } finally {
                if (originalDevUrl !== undefined) {
                    process.env.VITE_DEV_SERVER_URL = originalDevUrl
                } else {
                    delete process.env.VITE_DEV_SERVER_URL
                }
            }
        })

        it('isControlledAppUrl unit test: strictly verifies canonical normalization, realpaths, and protocol guards', () => {
            const canonicalPath = path.resolve('/usr/local/cpa/frontend/dist/index.html')
            const options = {
                trustedFilePaths: [canonicalPath],
                trustedUrls: ['http://localhost:5173/', 'http://127.0.0.1:18080/', 'cpa://app/index.html'],
            }

            // File URLs
            expect(isControlledAppUrl(`file://${canonicalPath}`, options)).toBe(true)
            expect(isControlledAppUrl(`file://${canonicalPath}#/chat`, options)).toBe(true)
            expect(isControlledAppUrl(`file://${canonicalPath}?debug=1#/chat`, options)).toBe(true)
            expect(isControlledAppUrl(`file:///usr/local/cpa/frontend/dist/../dist/index.html`, options)).toBe(true)
            expect(isControlledAppUrl(`file:///usr/local/cpa/frontend/dist/index.html.attacker.js`, options)).toBe(false)
            expect(isControlledAppUrl(`file:///usr/local/cpa/frontend/dist/index.html/nested`, options)).toBe(false)
            expect(isControlledAppUrl(`file:///usr/local/cpa/frontend/dist/other.html`, options)).toBe(false)
            expect(isControlledAppUrl(`file:///tmp/attacker/index.html`, options)).toBe(false)

            // HTTP / HTTPS - Origin Matching (SPA client routes stay trusted)
            expect(isControlledAppUrl('http://localhost:5173', options)).toBe(true)
            expect(isControlledAppUrl('http://localhost:5173/', options)).toBe(true)
            expect(isControlledAppUrl('http://localhost:5173/#/settings', options)).toBe(true)
            expect(isControlledAppUrl('http://localhost:5173/?debug=true#/settings', options)).toBe(true)
            expect(isControlledAppUrl('http://localhost:5173/chat/session-123', options)).toBe(true)
            expect(isControlledAppUrl('http://localhost:5173/scheduled', options)).toBe(true)
            expect(isControlledAppUrl('http://127.0.0.1:18080', options)).toBe(true)
            expect(isControlledAppUrl('http://127.0.0.1:18080/', options)).toBe(true)
            expect(isControlledAppUrl('http://127.0.0.1:18080/#/chat', options)).toBe(true)
            expect(isControlledAppUrl('http://127.0.0.1:18080/chat/abc', options)).toBe(true)

            // Same-origin paths are trusted for http(s); malformed / dangerous forms still rejected
            expect(isControlledAppUrl('http://localhost:5173/attacker', options)).toBe(true)
            expect(isControlledAppUrl('http://localhost:5173/index.html.evil', options)).toBe(true)
            expect(isControlledAppUrl('http://localhost:5173/api/plugins/resources/x/entry.js', options)).toBe(true)
            expect(isControlledAppUrl('http://localhost:5173/%2e%2e/index.html', options)).toBe(false)
            expect(isControlledAppUrl('http://localhost:5173//evil', options)).toBe(false)
            expect(isControlledAppUrl('http://localhost:5173/%00index.html', options)).toBe(false)
            expect(isControlledAppUrl('http://localhost:5173/index%2fhtml', options)).toBe(false)
            expect(isControlledAppUrl('http://localhost:5173/index%5chtml', options)).toBe(false)
            expect(isControlledAppUrl('http://localhost:5173\\evil', options)).toBe(false)
            expect(isControlledAppUrl('//localhost:5173/', options)).toBe(false)
            expect(isControlledAppUrl('http://admin:pass@localhost:5173/', options)).toBe(false)

            // Other Hosts / Ports
            expect(isControlledAppUrl('http://localhost:5174/', options)).toBe(false)
            expect(isControlledAppUrl('http://127.0.0.1:18081/', options)).toBe(false)
            expect(isControlledAppUrl('http://localhost:3000/', options)).toBe(false)
            expect(isControlledAppUrl('https://evil.com/', options)).toBe(false)
            expect(isControlledAppUrl('http://localhost.attacker.com:5173/', options)).toBe(false)

            // Protocols
            expect(isControlledAppUrl('cpa-plugin://cpa.core.chat/index.html', options)).toBe(false)
            expect(isControlledAppUrl('javascript:alert(1)', options)).toBe(false)
            expect(isControlledAppUrl('data:text/html,evil', options)).toBe(false)
            expect(isControlledAppUrl('blob:http://localhost:5173/abc', options)).toBe(false)
            expect(isControlledAppUrl('cpa://app/index.html', options)).toBe(true)
            expect(isControlledAppUrl('cpa://app/index.html#/route', options)).toBe(true)
            expect(isControlledAppUrl('cpa://attacker/index.html', options)).toBe(false)
            expect(isControlledAppUrl('cpa://app/other.html', options)).toBe(false)

            // Empty / invalid
            expect(isControlledAppUrl('', options)).toBe(false)
            expect(isControlledAppUrl('   ', options)).toBe(false)
            expect(isControlledAppUrl(null, options)).toBe(false)
            expect(isControlledAppUrl(undefined, options)).toBe(false)
            expect(isControlledAppUrl('not-a-valid-url', options)).toBe(false)
        })
    })

    it('revokes old handle on page navigation / reload and issues a fresh opaque handle for the new document', async () => {
        const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')
        const invokeHandler = ipcHandlers.get('cpa:capability:invoke')

        const doc1Event = {
            sender: mockWebContents,
            senderFrame: {
                parent: null,
                url: 'file:///app/index.html',
                routingId: 1,
                processId: 1001,
            },
        }

        // 1. First document claims handle
        const claim1 = await bootstrapHandler(doc1Event)
        expect(claim1.ok).toBe(true)
        const handle1 = claim1.value

        // Handle1 works
        const res1 = await invokeHandler(doc1Event, {
            handle: handle1,
            method: 'native:readFile',
            args: ['/file1.txt'],
        })
        expect(res1.ok).toBe(true)

        // 2. Trigger navigation / reload
        for (const navListener of navigationListeners) {
            navListener({ isMainFrame: true })
        }

        // 3. Old handle is now REVOKED and invalid
        const resOld = await invokeHandler(doc1Event, {
            handle: handle1,
            method: 'native:readFile',
            args: ['/file1.txt'],
        })
        expect(resOld.ok).toBe(false)
        expect(resOld.error?.message).toMatch(/Invalid or expired capability handle/)

        // 4. New document claims fresh handle
        const doc2Event = {
            sender: mockWebContents,
            senderFrame: {
                parent: null,
                url: 'file:///app/index.html',
                routingId: 2,
                processId: 1001,
            },
        }
        const claim2 = await bootstrapHandler(doc2Event)
        expect(claim2.ok).toBe(true)
        const handle2 = claim2.value
        expect(handle2).not.toBe(handle1)

        // New handle works
        const res2 = await invokeHandler(doc2Event, {
            handle: handle2,
            method: 'native:readFile',
            args: ['/file2.txt'],
        })
        expect(res2.ok).toBe(true)
    })

    it('does not leak did-start-navigation listeners across multiple page reloads / bootstraps', async () => {
        const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')
        const invokeHandler = ipcHandlers.get('cpa:capability:invoke')

        let currentHandle: string | null = null

        // Simulate 15 consecutive page reloads (exceeding default EventEmitter 10 listener limit)
        for (let i = 1; i <= 15; i++) {
            const docEvent = {
                sender: mockWebContents,
                senderFrame: {
                    parent: null,
                    url: 'file:///app/index.html',
                    routingId: i,
                    processId: 1001,
                },
            }

            // Claim handle for the document
            const claim = await bootstrapHandler(docEvent)
            expect(claim.ok).toBe(true)
            expect(claim.value).toBeDefined()
            currentHandle = claim.value

            // Ensure exactly 1 did-start-navigation listener exists on WebContents
            expect(navigationListeners.length).toBe(1)

            // Verify current handle is valid and functional
            const testInvoke = await invokeHandler(docEvent, {
                handle: currentHandle,
                method: 'native:readFile',
                args: ['/file.txt'],
            })
            expect(testInvoke.ok).toBe(true)

            // Trigger navigation / reload for the next iteration (unless last)
            if (i < 15) {
                for (const navListener of [...navigationListeners]) {
                    navListener({ isMainFrame: true })
                }

                // Verify the handle was revoked upon navigation
                const revokedInvoke = await invokeHandler(docEvent, {
                    handle: currentHandle,
                    method: 'native:readFile',
                    args: ['/file.txt'],
                })
                expect(revokedInvoke.ok).toBe(false)
                expect(revokedInvoke.error?.message).toMatch(/Invalid or expired capability handle/)
            }
        }

        // Final verification: exactly 1 listener attached after 15 reloads
        expect(navigationListeners.length).toBe(1)
    })

    it('cleans up WebContents navigation bindings and listeners when unregistered', async () => {
        const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')

        const docEvent = {
            sender: mockWebContents,
            senderFrame: {
                parent: null,
                url: 'file:///app/index.html',
                routingId: 1,
                processId: 1001,
            },
        }

        const claim = await bootstrapHandler(docEvent)
        expect(claim.ok).toBe(true)
        expect(navigationListeners.length).toBe(1)

        // Simulate transport unregister
        unregisterTransport()
        expect(navigationListeners.length).toBe(0)
    })

    it('end-to-end: operates Host capability facade with async opaque handle provider without static handle leaks', async () => {
        const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')
        const invokeHandler = ipcHandlers.get('cpa:capability:invoke')

        const mockEvent = {
            sender: mockWebContents,
            senderFrame: {
                parent: null,
                url: 'file:///app/index.html',
                routingId: 1,
                processId: 1001,
            },
        }

        // Create realistic Host transport simulating Preload (main bootstrap is idempotent)
        const simulatedTransport: HostTransportApi = {
            claimPlatformHandle: async () => bootstrapHandler(mockEvent),
            invoke: async (handle: string, method: string, args?: unknown[]) => {
                return invokeHandler(mockEvent, { handle, method, args })
            },
            subscribeNativeEvents: vi.fn().mockReturnValue(() => {}),
        }

        // Async handle provider
        let hostHandle: string | null = null
        const handleProvider = async () => {
            if (!hostHandle) {
                const res = await simulatedTransport.claimPlatformHandle!()
                if (!res.ok || !res.value) throw new Error('Bootstrap failed')
                hostHandle = res.value
            }
            return hostHandle
        }

        const facade = createHostCapabilityFacade(simulatedTransport, handleProvider)

        // Call facade methods
        const readResult = await facade.ReadFile('/path/to/doc.txt')
        expect(readResult).toEqual({ dataBase64: 'dGVzdC1kYXRh' })

        const profilingResult = await (facade as any).ProfilingGetStatus()
        expect(profilingResult).toEqual({ running: false, enabled: true, target: 'all' })

        // Verify that handleProvider issued a valid opaque handle and not 'desktop-main'
        expect(hostHandle).toMatch(/^cap_[a-f0-9]+$/i)
        expect(hostHandle).not.toBe('desktop-main')
    })

    it('recovers facade invokes after an expired host handle by re-claiming once', async () => {
        const bootstrapHandler = ipcHandlers.get('cpa:capability:bootstrap')
        const invokeHandler = ipcHandlers.get('cpa:capability:invoke')

        const mockEvent = {
            sender: mockWebContents,
            senderFrame: {
                parent: null,
                url: 'file:///app/index.html',
                routingId: 1,
                processId: 1001,
            },
        }

        let cachedHandle: string | null = null
        const simulatedTransport: HostTransportApi = {
            claimPlatformHandle: async () => bootstrapHandler(mockEvent),
            invoke: async (handle: string, method: string, args?: unknown[]) => {
                return invokeHandler(mockEvent, { handle, method, args })
            },
            subscribeNativeEvents: vi.fn().mockReturnValue(() => {}),
        }

        const handleProvider = async () => {
            if (!cachedHandle) {
                const res = await simulatedTransport.claimPlatformHandle!()
                if (!res.ok || !res.value) throw new Error('Bootstrap failed')
                cachedHandle = res.value
            }
            return cachedHandle
        }

        const facade = createHostCapabilityFacade(simulatedTransport, handleProvider, {
            onExpiredHandle: () => {
                cachedHandle = null
            },
        })

        expect(await facade.ReadFile('/before.txt')).toEqual({ dataBase64: 'dGVzdC1kYXRh' })
        const staleHandle = cachedHandle
        expect(staleHandle).toBeTruthy()

        broker.revokeHandle(staleHandle as any)

        // Facade should clear cache, re-claim, and succeed without surfacing the expired error
        expect(await facade.ReadFile('/after.txt')).toEqual({ dataBase64: 'dGVzdC1kYXRh' })
        expect(cachedHandle).toBeTruthy()
        expect(cachedHandle).not.toBe(staleHandle)
    })

    it('verifies AST static contract of preload script: strictly 5 fixed channels and no arbitrary invoke channels', () => {
        const preloadPath = path.resolve(__dirname, '../src/preload/index.cts')
        const sourceCode = fs.readFileSync(preloadPath, 'utf8')
        const sourceFile = ts.createSourceFile(preloadPath, sourceCode, ts.ScriptTarget.Latest, true)

        const invokedChannels = new Set<string>()
        const listenedChannels = new Set<string>()

        function visit(node: ts.Node) {
            if (ts.isCallExpression(node)) {
                const expr = node.expression
                if (ts.isPropertyAccessExpression(expr)) {
                    const objText = expr.expression.getText(sourceFile)
                    const propText = expr.name.text
                    if (objText === 'localIpc') {
                        if (propText === 'invoke' && node.arguments.length > 0) {
                            const arg0 = node.arguments[0]
                            if (ts.isStringLiteral(arg0)) {
                                invokedChannels.add(arg0.text)
                            }
                        }
                        if (propText === 'on' && node.arguments.length > 0) {
                            const arg0 = node.arguments[0]
                            if (ts.isStringLiteral(arg0)) {
                                listenedChannels.add(arg0.text)
                            }
                        }
                    }
                }
            }
            ts.forEachChild(node, visit)
        }

        visit(sourceFile)

        const EXPECTED_INVOKE_CHANNELS = new Set([
            'cpa:capability:bootstrap',
            'cpa:capability:grant',
            'cpa:capability:invoke',
            'cpa:capability:subscribe',
            'cpa:capability:unsubscribe',
        ])

        expect(invokedChannels).toEqual(EXPECTED_INVOKE_CHANNELS)
        expect(listenedChannels).toContain('cpa:native')
    })

    it('verifies browser fallback in test environment defaults to safe noopTransport', () => {
        const transport = getHostTransport()
        expect(transport).toBeDefined()
        expect(typeof transport.invoke).toBe('function')
        expect(typeof transport.subscribeNativeEvents).toBe('function')
    })
})
