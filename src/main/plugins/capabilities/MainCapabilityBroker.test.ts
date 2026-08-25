import { describe, expect, it } from 'vitest'
import type { CapabilityDescriptor, CapabilityInvocationContext } from '@cpa/plugin-api'
import { MainCapabilityBroker } from './MainCapabilityBroker.js'

describe('MainCapabilityBroker', () => {
    function createTestContext(overrides?: Partial<CapabilityInvocationContext>): CapabilityInvocationContext {
        return {
            pluginId: 'reader',
            senderId: 1,
            frameUrl: 'cpa-plugin://reader/index.html',
            transport: 'electron',
            ...overrides,
        }
    }

    const readFileDescriptor: CapabilityDescriptor<[path: string], string> = {
        method: 'filesystem.readFile',
        capability: 'filesystem.read',
        validate(args: unknown[]): asserts args is [string] {
            if (typeof args[0] !== 'string') {
                throw new Error('Argument 0 must be a string')
            }
        },
        invoke: async (_ctx, path) => `content of ${path}`,
    }

    const writeFileDescriptor: CapabilityDescriptor<[path: string, content: string], boolean> = {
        method: 'filesystem.writeFile',
        capability: 'filesystem.write',
        validate(args: unknown[]): asserts args is [string, string] {
            if (typeof args[0] !== 'string' || typeof args[1] !== 'string') {
                throw new Error('Arguments must be string and string')
            }
        },
        invoke: async (_ctx, _path, _content) => true,
    }

    const sessionListDescriptor: CapabilityDescriptor<[], string[]> = {
        method: 'sessions.list',
        capability: 'sessions.list',
        validate(_args: unknown[]): asserts _args is [] {},
        invoke: async () => ['session-1', 'session-2'],
    }

    const sessionCreateDescriptor: CapabilityDescriptor<[title: string], { id: string; title: string }> = {
        method: 'sessions.create',
        capability: 'sessions.create',
        validate(args: unknown[]): asserts args is [string] {
            if (typeof args[0] !== 'string') {
                throw new Error('Title must be string')
            }
        },
        invoke: async (_ctx, title) => ({ id: 'new-id', title }),
    }

    it('rejects an expired generation handle', async () => {
        const broker = new MainCapabilityBroker()
        broker.register(readFileDescriptor)
        const context = createTestContext({ pluginId: 'reader' })
        const handle = broker.grant(context, ['filesystem.read'], 3)
        broker.revokeGeneration(context.pluginId, 3)
        await expect(broker.invoke(handle, 'native:readFile', ['/tmp/a'], context))
            .rejects.toThrow('Invalid or expired capability handle')
    })

    it('rejects invocation when runtime identity does not match handle binding', async () => {
        const broker = new MainCapabilityBroker()
        broker.register(readFileDescriptor)
        const context = createTestContext({ pluginId: 'reader', runtime: 'renderer' as any })
        const handle = broker.grant(context, ['filesystem.read'], 1)

        const agentContext = createTestContext({ pluginId: 'reader', runtime: 'agent' as any })
        await expect(broker.invoke(handle, 'filesystem.readFile', ['/tmp/a'], agentContext))
            .rejects.toThrow('Capability sender mismatch')
    })

    it('manages event subscriptions with handle lifecycle and cleans up on revocation', () => {
        const broker = new MainCapabilityBroker()
        broker.registerEvent('session:created', 'sessions.read')
        const context = createTestContext({ pluginId: 'subscriber' })
        const handle = broker.grant(context, ['sessions.*'], 1)

        const received: unknown[] = []
        const unsubscribe = broker.subscribe(handle, 'session:created', (payload) => {
            received.push(payload)
        }, context)

        broker.emit('session:created', { sessionId: 's1' }, 'subscriber')
        expect(received).toEqual([{ sessionId: 's1' }])

        unsubscribe()
        broker.emit('session:created', { sessionId: 's2' }, 'subscriber')
        expect(received).toEqual([{ sessionId: 's1' }])
    })

    it('automatically cleans up all subscriptions when generation is revoked', () => {
        const broker = new MainCapabilityBroker()
        broker.registerEvent('session:created', 'sessions.read')
        const context = createTestContext({ pluginId: 'subscriber' })
        const handle = broker.grant(context, ['sessions.*'], 1)

        const received: unknown[] = []
        broker.subscribe(handle, 'session:created', (payload) => {
            received.push(payload)
        }, context)

        broker.emit('session:created', { sessionId: 's1' }, 'subscriber')
        expect(received).toEqual([{ sessionId: 's1' }])

        broker.revokeGeneration('subscriber', 1)

        broker.emit('session:created', { sessionId: 's2' }, 'subscriber')
        expect(received).toEqual([{ sessionId: 's1' }])
    })

    it('isolates event payloads to targeted plugin subscriptions without cross-plugin leakage', () => {
        const broker = new MainCapabilityBroker()
        broker.registerEvent('custom:event', 'sessions.read')
        const ctx1 = createTestContext({ pluginId: 'plugin-a' })
        const ctx2 = createTestContext({ pluginId: 'plugin-b' })
        const handle1 = broker.grant(ctx1, ['sessions.*'], 1)
        const handle2 = broker.grant(ctx2, ['sessions.*'], 1)

        const eventsA: unknown[] = []
        const eventsB: unknown[] = []

        broker.subscribe(handle1, 'custom:event', (p) => eventsA.push(p), ctx1)
        broker.subscribe(handle2, 'custom:event', (p) => eventsB.push(p), ctx2)

        broker.emit('custom:event', { secret: 'for-a' }, 'plugin-a')
        expect(eventsA).toEqual([{ secret: 'for-a' }])
        expect(eventsB).toEqual([])
    })

    it('ignores client-declared capability grants and relies solely on broker records', async () => {
        const broker = new MainCapabilityBroker()
        broker.register(writeFileDescriptor)
        const context = createTestContext({ pluginId: 'reader' })
        const handle = broker.grant(context, ['filesystem.read'], 1)

        await expect(
            broker.invoke(handle, 'filesystem.writeFile', ['/tmp/evil', 'data'], context),
        ).rejects.toThrow(/lacks capability/i)
    })

    it('rejects a method not covered by the plugin grant', async () => {
        const broker = new MainCapabilityBroker()
        broker.register(readFileDescriptor)
        broker.register(writeFileDescriptor)

        const sender = createTestContext({ pluginId: 'reader' })
        const handle = broker.grant(sender, ['filesystem.read'])

        await expect(
            broker.invoke(handle, 'filesystem.writeFile', ['/tmp/a', 'x'], sender),
        ).rejects.toThrow('Plugin reader lacks capability filesystem.write')
    })

    it('rejects a handle used by a different sender', async () => {
        const broker = new MainCapabilityBroker()
        broker.register(readFileDescriptor)

        const sender = createTestContext({ pluginId: 'reader', senderId: 1 })
        const otherSender = createTestContext({ pluginId: 'reader', senderId: 2 })
        const handle = broker.grant(sender, ['filesystem.read'])

        await expect(
            broker.invoke(handle, 'filesystem.readFile', ['/tmp/a'], otherSender),
        ).rejects.toThrow('Capability sender mismatch')
    })

    it('rejects a handle used with mismatched transport or pluginId or origin', async () => {
        const broker = new MainCapabilityBroker()
        broker.register(readFileDescriptor)

        const sender = createTestContext({ pluginId: 'reader', transport: 'electron' })
        const handle = broker.grant(sender, ['filesystem.read'])

        const wrongTransport = createTestContext({ pluginId: 'reader', transport: 'web' })
        await expect(
            broker.invoke(handle, 'filesystem.readFile', ['/tmp/a'], wrongTransport),
        ).rejects.toThrow('Capability sender mismatch')

        const wrongPluginId = createTestContext({ pluginId: 'attacker' })
        await expect(
            broker.invoke(handle, 'filesystem.readFile', ['/tmp/a'], wrongPluginId),
        ).rejects.toThrow('Capability sender mismatch')

        const wrongFrame = createTestContext({ frameUrl: 'https://evil.com' })
        await expect(
            broker.invoke(handle, 'filesystem.readFile', ['/tmp/a'], wrongFrame),
        ).rejects.toThrow('Capability sender mismatch')
    })

    it('allows invocation of exact capability match and executes method', async () => {
        const broker = new MainCapabilityBroker()
        broker.register(readFileDescriptor)

        const sender = createTestContext()
        const handle = broker.grant(sender, ['filesystem.read'])

        const result = await broker.invoke(handle, 'filesystem.readFile', ['/tmp/hello.txt'], sender)
        expect(result).toBe('content of /tmp/hello.txt')
    })

    it('allows invocation via trailing namespace wildcard grant', async () => {
        const broker = new MainCapabilityBroker()
        broker.register(sessionListDescriptor)
        broker.register(sessionCreateDescriptor)
        broker.register(readFileDescriptor)

        const sender = createTestContext({ pluginId: 'session-plugin' })
        const handle = broker.grant(sender, ['sessions.*'])

        const listResult = await broker.invoke(handle, 'sessions.list', [], sender)
        expect(listResult).toEqual(['session-1', 'session-2'])

        const createResult = await broker.invoke(handle, 'sessions.create', ['Test Session'], sender)
        expect(createResult).toEqual({ id: 'new-id', title: 'Test Session' })

        await expect(
            broker.invoke(handle, 'filesystem.readFile', ['/tmp/test'], sender),
        ).rejects.toThrow('Plugin session-plugin lacks capability filesystem.read')
    })

    it('prohibits bare * and intermediate wildcards in grants', () => {
        const broker = new MainCapabilityBroker()
        const sender = createTestContext()

        expect(() => broker.grant(sender, ['*'])).toThrow(/prohibited|invalid/i)
        expect(() => broker.grant(sender, ['*.read'])).toThrow(/prohibited|invalid/i)
        expect(() => broker.grant(sender, ['sessions.*.read'])).toThrow(/prohibited|invalid/i)
        expect(() => broker.grant(sender, ['sessions**'])).toThrow(/prohibited|invalid/i)
    })

    it('rejects an unregistered capability method', async () => {
        const broker = new MainCapabilityBroker()
        const sender = createTestContext()
        const handle = broker.grant(sender, ['filesystem.read'])

        await expect(
            broker.invoke(handle, 'filesystem.nonExistent', [], sender),
        ).rejects.toThrow('Unknown capability method: filesystem.nonExistent')
    })

    it('rejects an invalid or non-existent handle', async () => {
        const broker = new MainCapabilityBroker()
        broker.register(readFileDescriptor)
        const sender = createTestContext()

        await expect(
            broker.invoke('invalid-handle' as any, 'filesystem.readFile', ['/tmp/a'], sender),
        ).rejects.toThrow(/invalid|expired|not found/i)
    })

    it('revokes handles when generation is revoked', async () => {
        const broker = new MainCapabilityBroker()
        broker.register(readFileDescriptor)

        const sender = createTestContext({ pluginId: 'my-plugin' })
        const gen1Handle = broker.grant(sender, ['filesystem.read'], 1)
        const gen2Handle = broker.grant(sender, ['filesystem.read'], 2)

        expect(await broker.invoke(gen1Handle, 'filesystem.readFile', ['/tmp/1'], sender)).toBe('content of /tmp/1')
        expect(await broker.invoke(gen2Handle, 'filesystem.readFile', ['/tmp/2'], sender)).toBe('content of /tmp/2')

        broker.revokeGeneration('my-plugin', 1)

        await expect(
            broker.invoke(gen1Handle, 'filesystem.readFile', ['/tmp/1'], sender),
        ).rejects.toThrow(/invalid|revoked|expired/i)

        expect(await broker.invoke(gen2Handle, 'filesystem.readFile', ['/tmp/2'], sender)).toBe('content of /tmp/2')
    })

    it('validates arguments schema and rejects invalid arguments', async () => {
        const broker = new MainCapabilityBroker()
        broker.register(readFileDescriptor)

        const sender = createTestContext()
        const handle = broker.grant(sender, ['filesystem.read'])

        await expect(
            broker.invoke(handle, 'filesystem.readFile', [12345], sender),
        ).rejects.toThrow('Argument 0 must be a string')
    })

    it('supports descriptor unregistration', async () => {
        const broker = new MainCapabilityBroker()
        const unregister = broker.register(readFileDescriptor)

        const sender = createTestContext()
        const handle = broker.grant(sender, ['filesystem.read'])

        expect(await broker.invoke(handle, 'filesystem.readFile', ['/tmp/a'], sender)).toBe('content of /tmp/a')

        unregister()

        await expect(
            broker.invoke(handle, 'filesystem.readFile', ['/tmp/a'], sender),
        ).rejects.toThrow('Unknown capability method: filesystem.readFile')
    })

    describe('Grant Tickets & Security Constraints', () => {
        it('creates a single-use grant ticket and redeems it for an opaque handle', async () => {
            const broker = new MainCapabilityBroker()
            broker.register(readFileDescriptor)

            const ticket = broker.createGrantTicket({
                pluginId: 'reader',
                runtime: 'renderer',
                generation: 1,
                capabilities: ['filesystem.read'],
            })
            expect(ticket).toMatch(/^ticket_/)

            const sender = createTestContext({ pluginId: 'reader', runtime: 'renderer' as any, senderId: 2 })
            const handle = broker.redeemGrantTicket(ticket, sender)
            expect(handle).toBeDefined()
            expect(typeof handle).toBe('string')

            // Can invoke with redeemed handle
            const result = await broker.invoke(handle, 'filesystem.readFile', ['/tmp/test.txt'], sender)
            expect(result).toBe('content of /tmp/test.txt')

            // Ticket is single-use; second redemption fails
            expect(() => broker.redeemGrantTicket(ticket, sender)).toThrow(
                'Invalid, expired, or already redeemed capability grant ticket',
            )
        })

        it('rejects an expired grant ticket', () => {
            const broker = new MainCapabilityBroker()
            const ticket = broker.createGrantTicket({
                pluginId: 'reader',
                runtime: 'renderer',
                generation: 1,
                capabilities: ['filesystem.read'],
                ttlMs: -100, // already expired
            })

            const sender = createTestContext({ pluginId: 'reader', runtime: 'renderer' as any })
            expect(() => broker.redeemGrantTicket(ticket, sender)).toThrow('Capability grant ticket expired')
        })

        it('rejects ticket redemption when runtime mismatches ticket specification', () => {
            const broker = new MainCapabilityBroker()
            const ticket = broker.createGrantTicket({
                pluginId: 'reader',
                runtime: 'renderer',
                generation: 1,
                capabilities: ['filesystem.read'],
            })

            const agentSender = createTestContext({ pluginId: 'reader', runtime: 'agent' as any })
            expect(() => broker.redeemGrantTicket(ticket, agentSender)).toThrow(
                'Capability grant ticket runtime mismatch',
            )
        })

        it('rejects ticket redemption when transport mismatches', () => {
            const broker = new MainCapabilityBroker()
            const ticket = broker.createGrantTicket({
                pluginId: 'reader',
                runtime: 'renderer',
                generation: 1,
                capabilities: ['filesystem.read'],
            })

            const webSender = createTestContext({ pluginId: 'reader', runtime: 'renderer' as any, transport: 'web' as any })
            expect(() => broker.redeemGrantTicket(ticket, webSender)).toThrow(
                'Capability grant ticket transport mismatch',
            )
        })

        it('redeems web transport tickets for matching web senders and binds clientId', async () => {
            const broker = new MainCapabilityBroker()
            broker.register(readFileDescriptor)

            const ticket = broker.createGrantTicket({
                pluginId: 'reader',
                runtime: 'renderer',
                generation: 1,
                capabilities: ['filesystem.read'],
                transport: 'web',
                clientId: 'client_ws_1',
                documentId: 'web:client_ws_1',
                senderId: 0,
            })

            const webSender = createTestContext({
                pluginId: '',
                runtime: 'renderer' as any,
                transport: 'web' as any,
                senderId: 0,
                clientId: 'client_ws_1',
                documentId: 'web:client_ws_1',
                frameUrl: '',
            })

            const handle = broker.redeemGrantTicket(ticket, webSender)
            expect(handle).toBeDefined()

            const result = await broker.invoke(handle, 'filesystem.readFile', ['/tmp/a'], webSender)
            expect(result).toBe('content of /tmp/a')

            const otherClient = createTestContext({
                pluginId: '',
                runtime: 'renderer' as any,
                transport: 'web' as any,
                senderId: 0,
                clientId: 'client_ws_other',
                documentId: 'web:client_ws_other',
                frameUrl: '',
            })
            await expect(
                broker.invoke(handle, 'filesystem.readFile', ['/tmp/a'], otherClient),
            ).rejects.toThrow('Capability sender mismatch')
        })

        it('rejects electron senders redeeming web tickets', () => {
            const broker = new MainCapabilityBroker()
            const ticket = broker.createGrantTicket({
                pluginId: 'reader',
                runtime: 'renderer',
                generation: 1,
                capabilities: ['filesystem.read'],
                transport: 'web',
                clientId: 'client_ws_1',
            })

            const electronSender = createTestContext({
                pluginId: 'reader',
                runtime: 'renderer' as any,
                transport: 'electron',
            })
            expect(() => broker.redeemGrantTicket(ticket, electronSender)).toThrow(
                'Capability grant ticket transport mismatch',
            )
        })

        it('revokes web client tickets and handles', () => {
            const broker = new MainCapabilityBroker()
            const pendingTicket = broker.createGrantTicket({
                pluginId: 'reader',
                runtime: 'renderer',
                generation: 1,
                capabilities: ['filesystem.read'],
                transport: 'web',
                clientId: 'client_ws_1',
            })
            const redeemTicket = broker.createGrantTicket({
                pluginId: 'reader',
                runtime: 'renderer',
                generation: 1,
                capabilities: ['filesystem.read'],
                transport: 'web',
                clientId: 'client_ws_1',
                documentId: 'web:client_ws_1',
                senderId: 0,
            })

            const webSender = createTestContext({
                pluginId: '',
                runtime: 'renderer' as any,
                transport: 'web' as any,
                senderId: 0,
                clientId: 'client_ws_1',
                documentId: 'web:client_ws_1',
                frameUrl: '',
            })
            const handle = broker.redeemGrantTicket(redeemTicket, webSender)

            broker.revokeClient('client_ws_1')

            expect(broker.getHandle(handle)).toBeUndefined()
            expect(() => broker.redeemGrantTicket(pendingTicket, webSender)).toThrow(
                /Invalid, expired, or already redeemed/i,
            )
        })

        it('binds senderId, frameUrl, processId, routingId, documentId on ticket creation and validates on redemption', async () => {
            const broker = new MainCapabilityBroker()
            broker.register(readFileDescriptor)

            const ticket = broker.createGrantTicket({
                pluginId: 'reader',
                runtime: 'renderer',
                generation: 1,
                capabilities: ['filesystem.read'],
                senderId: 2,
                frameUrl: 'cpa-plugin://reader/index.html',
                processId: 101,
                routingId: 5,
                documentId: '2:101:5',
            })

            const matchingSender = createTestContext({
                pluginId: 'reader',
                runtime: 'renderer' as any,
                senderId: 2,
                frameUrl: 'cpa-plugin://reader/index.html',
                processId: 101,
                routingId: 5,
                documentId: '2:101:5',
            })

            const handle = broker.redeemGrantTicket(ticket, matchingSender)
            expect(handle).toBeDefined()

            const res = await broker.invoke(handle, 'filesystem.readFile', ['/file.txt'], matchingSender)
            expect(res).toBe('content of /file.txt')
        })

        it('rejects redemption when senderId mismatches expected ticket senderId', () => {
            const broker = new MainCapabilityBroker()
            const ticket = broker.createGrantTicket({
                pluginId: 'reader',
                runtime: 'renderer',
                generation: 1,
                capabilities: ['filesystem.read'],
                senderId: 2,
            })

            const wrongSender = createTestContext({
                pluginId: 'reader',
                runtime: 'renderer' as any,
                senderId: 99,
            })

            expect(() => broker.redeemGrantTicket(ticket, wrongSender)).toThrow(
                /sender mismatch/i,
            )
        })

        it('rejects redemption when frameUrl mismatches expected ticket frameUrl', () => {
            const broker = new MainCapabilityBroker()
            const ticket = broker.createGrantTicket({
                pluginId: 'reader',
                runtime: 'renderer',
                generation: 1,
                capabilities: ['filesystem.read'],
                frameUrl: 'https://allowed.origin/index.html',
            })

            const wrongSender = createTestContext({
                pluginId: 'reader',
                runtime: 'renderer' as any,
                frameUrl: 'https://attacker.origin/index.html',
            })

            expect(() => broker.redeemGrantTicket(ticket, wrongSender)).toThrow(
                /sender mismatch/i,
            )
        })

        it('rejects redemption when documentId mismatches expected ticket documentId', () => {
            const broker = new MainCapabilityBroker()
            const ticket = broker.createGrantTicket({
                pluginId: 'reader',
                runtime: 'renderer',
                generation: 1,
                capabilities: ['filesystem.read'],
                documentId: 'doc-original',
            })

            const wrongSender = createTestContext({
                pluginId: 'reader',
                runtime: 'renderer' as any,
                documentId: 'doc-malicious',
            })

            expect(() => broker.redeemGrantTicket(ticket, wrongSender)).toThrow(
                /sender mismatch/i,
            )
        })

        it('rejects redemption when processId or routingId mismatches expected ticket', () => {
            const broker = new MainCapabilityBroker()
            const ticket1 = broker.createGrantTicket({
                pluginId: 'reader',
                runtime: 'renderer',
                generation: 1,
                capabilities: ['filesystem.read'],
                processId: 101,
                routingId: 5,
            })

            const wrongProcessSender = createTestContext({
                pluginId: 'reader',
                runtime: 'renderer' as any,
                processId: 999,
                routingId: 5,
            })

            expect(() => broker.redeemGrantTicket(ticket1, wrongProcessSender)).toThrow(
                /sender mismatch/i,
            )

            const ticket2 = broker.createGrantTicket({
                pluginId: 'reader',
                runtime: 'renderer',
                generation: 1,
                capabilities: ['filesystem.read'],
                processId: 101,
                routingId: 5,
            })

            const wrongRoutingSender = createTestContext({
                pluginId: 'reader',
                runtime: 'renderer' as any,
                processId: 101,
                routingId: 999,
            })

            expect(() => broker.redeemGrantTicket(ticket2, wrongRoutingSender)).toThrow(
                /sender mismatch/i,
            )
        })

        it('rejects invocation when documentId or routingId mismatches handle binding', async () => {
            const broker = new MainCapabilityBroker()
            broker.register(readFileDescriptor)

            const matchingSender = createTestContext({
                pluginId: 'reader',
                runtime: 'renderer' as any,
                senderId: 1,
                processId: 101,
                routingId: 5,
                documentId: '1:101:5',
            })

            const handle = broker.grant(matchingSender, ['filesystem.read'], 1)

            const mismatchedDocSender = createTestContext({
                pluginId: 'reader',
                runtime: 'renderer' as any,
                senderId: 1,
                processId: 101,
                routingId: 5,
                documentId: '1:101:6',
            })

            await expect(broker.invoke(handle, 'filesystem.readFile', ['/a.txt'], mismatchedDocSender)).rejects.toThrow(
                'Capability sender mismatch',
            )
        })

        it('revokes unredeemed tickets when generation is revoked', () => {
            const broker = new MainCapabilityBroker()
            const ticket = broker.createGrantTicket({
                pluginId: 'reader',
                runtime: 'renderer',
                generation: 2,
                capabilities: ['filesystem.read'],
            })

            broker.revokeTicketsForGeneration(2)
            const sender = createTestContext({ pluginId: 'reader', runtime: 'renderer' as any })
            expect(() => broker.redeemGrantTicket(ticket, sender)).toThrow(
                'Invalid, expired, or already redeemed capability grant ticket',
            )
        })

        it('revokes all handles and subscriptions across all plugins on revokeGenerationAll', async () => {
            const broker = new MainCapabilityBroker()
            broker.register(readFileDescriptor)
            broker.registerEvent('session:created', 'sessions.read')

            const senderA = createTestContext({ pluginId: 'plugin-a' })
            const senderB = createTestContext({ pluginId: 'plugin-b' })
            const handleA = broker.grant(senderA, ['filesystem.read'], 2)
            const handleB = broker.grant(senderB, ['sessions.*'], 2)

            let eventReceived = false
            broker.subscribe(handleB, 'session:created', () => {
                eventReceived = true
            }, senderB)

            expect(await broker.invoke(handleA, 'filesystem.readFile', ['/tmp/a'], senderA)).toBe('content of /tmp/a')

            broker.revokeGenerationAll(2)

            await expect(broker.invoke(handleA, 'filesystem.readFile', ['/tmp/a'], senderA)).rejects.toThrow(
                'Invalid or expired capability handle',
            )
            broker.emit('session:created', { id: 1 }, 'plugin-b')
            expect(eventReceived).toBe(false)
        })

        it('preserves desktop-main host platform handles across revokeGenerationAll', async () => {
            const broker = new MainCapabilityBroker()
            broker.register(readFileDescriptor)

            const hostSender = createTestContext({ pluginId: 'desktop-main' })
            const pluginSender = createTestContext({ pluginId: 'some-plugin' })

            // generation 0 is the bootstrap generation; also cover a legacy gen-1 host handle
            const hostHandle = broker.grant(hostSender, ['filesystem.read'], 0)
            const legacyHostHandle = broker.grant(hostSender, ['filesystem.read'], 1)
            const pluginHandle = broker.grant(pluginSender, ['filesystem.read'], 1)

            expect(await broker.invoke(hostHandle, 'filesystem.readFile', ['/tmp/host'], hostSender)).toBe('content of /tmp/host')
            expect(await broker.invoke(legacyHostHandle, 'filesystem.readFile', ['/tmp/legacy'], hostSender)).toBe('content of /tmp/legacy')
            expect(await broker.invoke(pluginHandle, 'filesystem.readFile', ['/tmp/plugin'], pluginSender)).toBe('content of /tmp/plugin')

            // Revoke generation 1 (plugin generation commit)
            broker.revokeGenerationAll(1)

            // Plugin handle is revoked
            await expect(broker.invoke(pluginHandle, 'filesystem.readFile', ['/tmp/plugin'], pluginSender)).rejects.toThrow(
                'Invalid or expired capability handle',
            )

            // Host platform handles remain active even when sharing the revoked generation number
            expect(await broker.invoke(hostHandle, 'filesystem.readFile', ['/tmp/host'], hostSender)).toBe('content of /tmp/host')
            expect(await broker.invoke(legacyHostHandle, 'filesystem.readFile', ['/tmp/legacy'], hostSender)).toBe(
                'content of /tmp/legacy',
            )
        })

        it('enforces event capability allowlist and rejects unknown or unauthorized events', () => {
            const broker = new MainCapabilityBroker()
            broker.registerEvent('session:created', 'sessions.read')

            const sender = createTestContext({ pluginId: 'limited-plugin' })
            const handle = broker.grant(sender, ['filesystem.read'], 1) // no sessions capability

            // 1. Unknown event rejected
            expect(() =>
                broker.subscribe(handle, 'unknown:event', () => {}, sender),
            ).toThrow('Unknown capability event: unknown:event')

            // 2. Known event but lacks required capability rejected
            expect(() =>
                broker.subscribe(handle, 'session:created', () => {}, sender),
            ).toThrow('Plugin limited-plugin lacks capability sessions.read for event session:created')

            // 3. Authorized plugin succeeds
            const authorizedSender = createTestContext({ pluginId: 'auth-plugin' })
            const authHandle = broker.grant(authorizedSender, ['sessions.read'], 1)
            const unsub = broker.subscribe(authHandle, 'session:created', () => {}, authorizedSender)
            expect(typeof unsub).toBe('function')
            unsub()
        })
    })
})
