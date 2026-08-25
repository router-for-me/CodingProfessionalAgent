import { randomUUID } from 'node:crypto'
import {
    type CapabilityDescriptor,
    type CapabilityHandle,
    type CapabilityId,
    type CapabilityInvocationContext,
    PluginCapabilityError,
    assertValidCapabilityPattern,
    matchesCapability,
} from '@cpa/plugin-api'

export interface BoundCapabilityHandle {
    handle: CapabilityHandle
    pluginId: string
    runtime: 'main' | 'renderer' | 'agent'
    generation: number
    senderId: number
    frameUrl: string
    transport: 'electron' | 'web'
    grantedCapabilities: readonly CapabilityId[]
    subscriptions: Set<() => void>
    processId?: number
    routingId?: number
    documentId?: string
    clientId?: string
}

export interface CapabilityGrantTicket {
    ticket: string
    pluginId: string
    runtime: 'renderer' | 'agent'
    generation: number
    grantedCapabilities: readonly CapabilityId[]
    expiresAt: number
    senderId?: number
    frameUrl?: string
    processId?: number
    routingId?: number
    documentId?: string
    transport?: 'electron' | 'web'
    clientId?: string
}

interface EventSubscriptionRecord {
    handle: CapabilityHandle
    pluginId: string
    listener: (payload: unknown) => void
}

/**
 * Capability Broker in Electron Main process.
 * Issues scoped, opaque CapabilityHandles and enforces sender context,
 * permission grants, descriptor schemas, and generation revocation.
 */
export class MainCapabilityBroker {
    private readonly descriptors = new Map<string, CapabilityDescriptor<any, any>>()
    private readonly eventDescriptors = new Map<string, CapabilityId>()
    private readonly handles = new Map<string, BoundCapabilityHandle>()
    // pluginId -> Map<generation, Set<handleToken>>
    private readonly pluginGenerations = new Map<string, Map<number, Set<string>>>()
    // eventName -> Set<EventSubscriptionRecord>
    private readonly eventSubscriptions = new Map<string, Set<EventSubscriptionRecord>>()
    // ticket -> CapabilityGrantTicket
    private readonly grantTickets = new Map<string, CapabilityGrantTicket>()

    /**
     * Register a capability method descriptor.
     * Returns an unregister disposer function.
     */
    register<TArgs extends unknown[] = unknown[], TResult = unknown>(
        descriptor: CapabilityDescriptor<TArgs, TResult>,
    ): () => void {
        if (!descriptor || typeof descriptor.method !== 'string' || !descriptor.method.trim()) {
            throw new Error('Invalid descriptor: method must be a non-empty string')
        }
        if (typeof descriptor.capability !== 'string' || !descriptor.capability.trim()) {
            throw new Error('Invalid descriptor: capability must be a non-empty string')
        }
        if (typeof descriptor.validate !== 'function') {
            throw new Error('Invalid descriptor: validate must be a function')
        }
        if (typeof descriptor.invoke !== 'function') {
            throw new Error('Invalid descriptor: invoke must be a function')
        }

        this.descriptors.set(descriptor.method, descriptor as CapabilityDescriptor<any, any>)

        return () => {
            if (this.descriptors.get(descriptor.method) === descriptor) {
                this.descriptors.delete(descriptor.method)
            }
        }
    }

    /**
     * Register an authoritative capability event descriptor.
     * Returns an unregister disposer function.
     */
    registerEvent(eventName: string, capability: CapabilityId): () => void {
        if (typeof eventName !== 'string' || !eventName.trim()) {
            throw new Error('Invalid event name: must be a non-empty string')
        }
        assertValidCapabilityPattern(capability)
        this.eventDescriptors.set(eventName, capability)

        return () => {
            if (this.eventDescriptors.get(eventName) === capability) {
                this.eventDescriptors.delete(eventName)
            }
        }
    }

    /**
     * Look up a bound capability handle by its opaque token.
     */
    getHandle(handle: CapabilityHandle | string): BoundCapabilityHandle | undefined {
        return this.handles.get(handle as string)
    }

    /**
     * Creates a cryptographically random, single-use, short-lived grant ticket
     * bound to authoritative manifest grants, runtime, generation, and expected sender/frame context.
     */
    createGrantTicket(options: {
        pluginId: string
        runtime: 'renderer' | 'agent'
        generation: number
        capabilities: readonly CapabilityId[]
        ttlMs?: number
        senderId?: number
        frameUrl?: string
        processId?: number
        routingId?: number
        documentId?: string
        transport?: 'electron' | 'web'
        clientId?: string
    }): string {
        if (!options.pluginId || typeof options.pluginId !== 'string') {
            throw new PluginCapabilityError('Invalid grant ticket options: pluginId is required')
        }
        for (const pattern of options.capabilities) {
            assertValidCapabilityPattern(pattern)
        }

        const ticket = `ticket_${randomUUID().replace(/-/g, '')}`
        const ttlMs = options.ttlMs ?? 60000
        const ticketInfo: CapabilityGrantTicket = {
            ticket,
            pluginId: options.pluginId,
            runtime: options.runtime,
            generation: options.generation,
            grantedCapabilities: [...options.capabilities],
            expiresAt: Date.now() + ttlMs,
            senderId: options.senderId,
            frameUrl: options.frameUrl,
            processId: options.processId,
            routingId: options.routingId,
            documentId: options.documentId,
            transport: options.transport ?? 'electron',
            clientId: options.clientId,
        }

        this.grantTickets.set(ticket, ticketInfo)
        return ticket
    }

    /**
     * Redeems a grant ticket from a verified sender, issuing an authoritative opaque CapabilityHandle.
     * Ticket is strictly single-use and deleted immediately upon redemption.
     */
    redeemGrantTicket(ticket: string, sender: CapabilityInvocationContext): CapabilityHandle {
        const ticketInfo = this.grantTickets.get(ticket)
        if (!ticketInfo) {
            throw new PluginCapabilityError('Invalid, expired, or already redeemed capability grant ticket')
        }

        // Delete immediately to enforce single-use
        this.grantTickets.delete(ticket)

        if (Date.now() > ticketInfo.expiresAt) {
            throw new PluginCapabilityError('Capability grant ticket expired')
        }

        if (sender.runtime && sender.runtime !== ticketInfo.runtime) {
            throw new PluginCapabilityError('Capability grant ticket runtime mismatch')
        }

        const expectedTransport = ticketInfo.transport ?? 'electron'
        if (sender.transport && sender.transport !== expectedTransport) {
            throw new PluginCapabilityError('Capability grant ticket transport mismatch')
        }

        if (sender.pluginId && sender.pluginId !== ticketInfo.pluginId) {
            throw new PluginCapabilityError('Capability grant ticket sender mismatch')
        }

        if (ticketInfo.senderId !== undefined && sender.senderId !== ticketInfo.senderId) {
            throw new PluginCapabilityError('Capability grant ticket sender mismatch')
        }

        if (ticketInfo.frameUrl !== undefined && !this.matchFrameUrl(sender.frameUrl, ticketInfo.frameUrl)) {
            throw new PluginCapabilityError('Capability grant ticket sender mismatch')
        }

        if (ticketInfo.documentId !== undefined && sender.documentId !== undefined && sender.documentId !== ticketInfo.documentId) {
            throw new PluginCapabilityError('Capability grant ticket sender mismatch')
        }

        if (ticketInfo.processId !== undefined && sender.processId !== undefined && sender.processId !== ticketInfo.processId) {
            throw new PluginCapabilityError('Capability grant ticket sender mismatch')
        }

        if (ticketInfo.routingId !== undefined && sender.routingId !== undefined && sender.routingId !== ticketInfo.routingId) {
            throw new PluginCapabilityError('Capability grant ticket sender mismatch')
        }

        if (ticketInfo.clientId !== undefined && sender.clientId !== undefined && sender.clientId !== ticketInfo.clientId) {
            throw new PluginCapabilityError('Capability grant ticket sender mismatch')
        }

        return this.grant(
            {
                pluginId: ticketInfo.pluginId,
                senderId: sender.senderId,
                frameUrl: sender.frameUrl,
                transport: sender.transport ?? expectedTransport,
                runtime: ticketInfo.runtime,
                generation: ticketInfo.generation,
                processId: ticketInfo.processId ?? sender.processId,
                routingId: ticketInfo.routingId ?? sender.routingId,
                documentId: ticketInfo.documentId ?? sender.documentId,
                clientId: ticketInfo.clientId ?? sender.clientId,
            },
            ticketInfo.grantedCapabilities,
            ticketInfo.generation,
        )
    }

    /**
     * Revoke unredeemed grant tickets for a specific sender ID.
     */
    revokeTicketsForSender(senderId: number): void {
        for (const [ticket, info] of Array.from(this.grantTickets.entries())) {
            if (info.senderId === senderId) {
                this.grantTickets.delete(ticket)
            }
        }
    }

    /**
     * Revoke all handles and tickets for a destroyed sender ID.
     */
    revokeSender(senderId: number): void {
        this.revokeTicketsForSender(senderId)

        for (const [handle, bound] of Array.from(this.handles.entries())) {
            if (bound.senderId === senderId) {
                this.revokeHandle(handle as CapabilityHandle)
            }
        }
    }

    /**
     * Revoke unredeemed tickets and bound handles for a web client identity.
     */
    revokeClient(clientId: string): void {
        if (!clientId || typeof clientId !== 'string') {
            return
        }

        for (const [ticket, info] of Array.from(this.grantTickets.entries())) {
            if (info.clientId === clientId) {
                this.grantTickets.delete(ticket)
            }
        }

        for (const [handle, bound] of Array.from(this.handles.entries())) {
            if (bound.clientId === clientId) {
                this.revokeHandle(handle as CapabilityHandle)
            }
        }
    }

    /**
     * Revoke unredeemed grant tickets for a generation.
     */
    revokeTicketsForGeneration(generation: number, pluginId?: string): void {
        for (const [ticket, info] of Array.from(this.grantTickets.entries())) {
            if (info.generation === generation && (!pluginId || info.pluginId === pluginId)) {
                this.grantTickets.delete(ticket)
            }
        }
    }

    /**
     * Grant a set of capabilities to a plugin invocation context and return an opaque handle.
     */
    grant(
        context: CapabilityInvocationContext & { generation?: number; runtime?: 'main' | 'renderer' | 'agent' },
        capabilities: readonly CapabilityId[],
        generationOverride?: number,
        handleOverride?: CapabilityHandle,
    ): CapabilityHandle {
        if (!context || typeof context.pluginId !== 'string' || !context.pluginId.trim()) {
            throw new PluginCapabilityError('Invalid invocation context: pluginId is required')
        }

        // Validate each capability pattern
        for (const pattern of capabilities) {
            assertValidCapabilityPattern(pattern)
        }

        const generation = generationOverride ?? context.generation ?? 1
        const runtime = context.runtime ?? (context.senderId === 0 ? 'main' : 'renderer')
        const handleToken = handleOverride ?? (`cap_${randomUUID().replace(/-/g, '')}` as CapabilityHandle)

        const bound: BoundCapabilityHandle = {
            handle: handleToken,
            pluginId: context.pluginId,
            runtime,
            generation,
            senderId: context.senderId,
            frameUrl: context.frameUrl,
            transport: context.transport,
            grantedCapabilities: [...capabilities],
            subscriptions: new Set(),
            processId: context.processId,
            routingId: context.routingId,
            documentId: context.documentId,
            clientId: context.clientId,
        }

        this.handles.set(handleToken as string, bound)

        let genMap = this.pluginGenerations.get(context.pluginId)
        if (!genMap) {
            genMap = new Map()
            this.pluginGenerations.set(context.pluginId, genMap)
        }
        let handleSet = genMap.get(generation)
        if (!handleSet) {
            handleSet = new Set()
            genMap.set(generation, handleSet)
        }
        handleSet.add(handleToken as string)

        return handleToken
    }

    /**
     * Invoke a capability method with the given handle and arguments, verifying permissions and sender context.
     */
    async invoke(
        handle: CapabilityHandle,
        method: string,
        args: unknown[],
        sender: CapabilityInvocationContext,
    ): Promise<unknown> {
        const bound = this.handles.get(handle as string)
        if (!bound) {
            throw new PluginCapabilityError('Invalid or expired capability handle')
        }

        // Sender verification: pluginId, senderId, transport, frameUrl, runtime, document/process/routing/client
        if (
            (sender.pluginId && sender.pluginId !== bound.pluginId) ||
            sender.senderId !== bound.senderId ||
            sender.transport !== bound.transport ||
            (sender.runtime && sender.runtime !== bound.runtime) ||
            !this.matchFrameUrl(sender.frameUrl, bound.frameUrl) ||
            (bound.documentId !== undefined && sender.documentId !== undefined && bound.documentId !== sender.documentId) ||
            (bound.processId !== undefined && sender.processId !== undefined && bound.processId !== sender.processId) ||
            (bound.routingId !== undefined && sender.routingId !== undefined && bound.routingId !== sender.routingId) ||
            (bound.clientId !== undefined && sender.clientId !== undefined && bound.clientId !== sender.clientId)
        ) {
            throw new PluginCapabilityError('Capability sender mismatch')
        }

        const descriptor = this.descriptors.get(method)
        if (!descriptor) {
            throw new PluginCapabilityError(`Unknown capability method: ${method}`)
        }

        // Capability authorization check
        const authorized = bound.grantedCapabilities.some((pattern) =>
            matchesCapability(pattern, descriptor.capability),
        )
        if (!authorized) {
            throw new PluginCapabilityError(
                `Plugin ${bound.pluginId} lacks capability ${descriptor.capability}`,
                { pluginId: bound.pluginId },
            )
        }

        // Arguments schema validation
        const validateArgs: (args: unknown[]) => void = (a) => descriptor.validate(a)
        validateArgs(args)

        // Invoke descriptor with authoritative context
        const invocationContext: CapabilityInvocationContext = {
            ...sender,
            pluginId: bound.pluginId,
            runtime: bound.runtime,
        }

        return await descriptor.invoke(invocationContext, ...(args as any))
    }

    /**
     * Subscribe to capability events scoped to a handle and generation.
     */
    subscribe(
        handle: CapabilityHandle,
        eventName: string,
        listener: (payload: unknown) => void,
        sender: CapabilityInvocationContext,
    ): () => void {
        const bound = this.handles.get(handle as string)
        if (!bound) {
            throw new PluginCapabilityError('Invalid or expired capability handle')
        }

        if (
            (sender.pluginId && sender.pluginId !== bound.pluginId) ||
            sender.senderId !== bound.senderId ||
            sender.transport !== bound.transport ||
            (sender.runtime && sender.runtime !== bound.runtime) ||
            !this.matchFrameUrl(sender.frameUrl, bound.frameUrl) ||
            (bound.documentId !== undefined && sender.documentId !== undefined && bound.documentId !== sender.documentId) ||
            (bound.processId !== undefined && sender.processId !== undefined && bound.processId !== sender.processId) ||
            (bound.routingId !== undefined && sender.routingId !== undefined && bound.routingId !== sender.routingId) ||
            (bound.clientId !== undefined && sender.clientId !== undefined && bound.clientId !== sender.clientId)
        ) {
            throw new PluginCapabilityError('Capability sender mismatch')
        }

        // Event capability allowlist check
        const requiredCapability = this.eventDescriptors.get(eventName)
        if (!requiredCapability) {
            throw new PluginCapabilityError(`Unknown capability event: ${eventName}`)
        }

        const authorized = bound.grantedCapabilities.some((pattern) =>
            matchesCapability(pattern, requiredCapability),
        )
        if (!authorized) {
            throw new PluginCapabilityError(
                `Plugin ${bound.pluginId} lacks capability ${requiredCapability} for event ${eventName}`,
                { pluginId: bound.pluginId },
            )
        }

        let eventSet = this.eventSubscriptions.get(eventName)
        if (!eventSet) {
            eventSet = new Set()
            this.eventSubscriptions.set(eventName, eventSet)
        }

        const record: EventSubscriptionRecord = {
            handle,
            pluginId: bound.pluginId,
            listener,
        }
        eventSet.add(record)

        const cleanup = () => {
            const currentSet = this.eventSubscriptions.get(eventName)
            if (currentSet) {
                currentSet.delete(record)
                if (currentSet.size === 0) {
                    this.eventSubscriptions.delete(eventName)
                }
            }
            bound.subscriptions.delete(cleanup)
        }

        bound.subscriptions.add(cleanup)
        return cleanup
    }

    /**
     * Emit an event to active subscribers, isolating payloads to the targeted plugin if specified.
     */
    emit(eventName: string, payload: unknown, targetPluginId?: string): void {
        const eventSet = this.eventSubscriptions.get(eventName)
        if (!eventSet) return

        for (const record of Array.from(eventSet)) {
            if (targetPluginId && record.pluginId !== targetPluginId) {
                continue
            }
            try {
                record.listener(payload)
            } catch (err) {
                console.error(`Error in event listener for "${eventName}":`, err)
            }
        }
    }

    /**
     * Revoke all handles granted to a specific plugin generation.
     */
    revokeGeneration(pluginId: string, generation: number): void {
        this.revokeTicketsForGeneration(generation, pluginId)

        const genMap = this.pluginGenerations.get(pluginId)
        if (!genMap) return

        const handleSet = genMap.get(generation)
        if (handleSet) {
            for (const handle of handleSet) {
                const bound = this.handles.get(handle)
                if (bound) {
                    for (const cleanup of Array.from(bound.subscriptions)) {
                        try {
                            cleanup()
                        } catch (err) {
                            console.warn(`Error during subscription cleanup for handle ${handle}:`, err)
                        }
                    }
                    bound.subscriptions.clear()
                    this.handles.delete(handle)
                }
            }
            genMap.delete(generation)
        }
        if (genMap.size === 0) {
            this.pluginGenerations.delete(pluginId)
        }
    }

    /**
     * Revoke all handles, subscriptions, and tickets across all plugins for a generation.
     * The renderer host platform identity (`desktop-main`) is preserved — its handle is
     * owned by the app shell bootstrap, not by plugin generation commits/rollbacks.
     */
    revokeGenerationAll(generation: number): void {
        this.revokeTicketsForGeneration(generation)

        for (const pluginId of Array.from(this.pluginGenerations.keys())) {
            if (pluginId === 'desktop-main') continue
            this.revokeGeneration(pluginId, generation)
        }
    }

    /**
     * Revoke all handles for a plugin across all generations.
     */
    revokePlugin(pluginId: string): void {
        const genMap = this.pluginGenerations.get(pluginId)
        if (!genMap) return

        for (const handleSet of genMap.values()) {
            for (const handle of handleSet) {
                const bound = this.handles.get(handle)
                if (bound) {
                    for (const cleanup of Array.from(bound.subscriptions)) {
                        try {
                            cleanup()
                        } catch (err) {
                            console.warn(`Error during subscription cleanup for handle ${handle}:`, err)
                        }
                    }
                    bound.subscriptions.clear()
                    this.handles.delete(handle)
                }
            }
        }
        this.pluginGenerations.delete(pluginId)
    }

    /**
     * Revoke a single capability handle and clean up its subscriptions.
     */
    revokeHandle(handle: CapabilityHandle): void {
        const bound = this.handles.get(handle as string)
        if (!bound) return

        for (const cleanup of Array.from(bound.subscriptions)) {
            try {
                cleanup()
            } catch (err) {
                console.warn(`Error during subscription cleanup for handle ${handle}:`, err)
            }
        }
        bound.subscriptions.clear()
        this.handles.delete(handle as string)

        const genMap = this.pluginGenerations.get(bound.pluginId)
        if (genMap) {
            const handleSet = genMap.get(bound.generation)
            if (handleSet) {
                handleSet.delete(handle as string)
                if (handleSet.size === 0) {
                    genMap.delete(bound.generation)
                }
            }
            if (genMap.size === 0) {
                this.pluginGenerations.delete(bound.pluginId)
            }
        }
    }

    /**
     * Helper to match frame URLs or origins.
     */
    private matchFrameUrl(senderUrl: string, boundUrl: string): boolean {
        if (!senderUrl && !boundUrl) return true
        if (senderUrl === boundUrl) return true
        try {
            const u1 = new URL(senderUrl)
            const u2 = new URL(boundUrl)
            return u1.protocol === u2.protocol && u1.host === u2.host
        } catch {
            return senderUrl === boundUrl
        }
    }
}
