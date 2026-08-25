import {
    type CapabilityHandle,
    type CapabilityId,
    type CapabilityInvokeResponse,
    type PluginCapabilityClient,
    type PluginManifest,
    deserializeCapabilityError,
    matchesCapability,
} from '@cpa/plugin-api'

export type CapabilityTransport = (
    handle: CapabilityHandle,
    method: string,
    args: unknown[],
) => Promise<CapabilityInvokeResponse | unknown>

export type CapabilitySubscribeTransport = (
    handle: CapabilityHandle,
    eventName: string,
    listener: (payload: unknown) => void,
) => () => void

export interface RendererCapabilityClientOptions {
    handle: CapabilityHandle
    manifest?: PluginManifest
    transport: CapabilityTransport
    subscribe?: CapabilitySubscribeTransport
}

/**
 * Scoped capability client for Renderer and Agent runtime plugins.
 * Sends invocations via the fixed transport bridge and deserializes structured error DTOs.
 */
export class RendererCapabilityClient implements PluginCapabilityClient {
    private readonly handle: CapabilityHandle
    private readonly manifest?: PluginManifest
    private readonly transport: CapabilityTransport
    private readonly subscribeTransport?: CapabilitySubscribeTransport

    constructor(
        optionsOrHandle: RendererCapabilityClientOptions | CapabilityHandle,
        transport?: CapabilityTransport,
    ) {
        if (typeof optionsOrHandle === 'string' && typeof transport === 'function') {
            this.handle = optionsOrHandle as CapabilityHandle
            this.transport = transport
        } else if (
            typeof optionsOrHandle === 'object' &&
            optionsOrHandle !== null &&
            'handle' in optionsOrHandle &&
            typeof optionsOrHandle.transport === 'function'
        ) {
            this.handle = optionsOrHandle.handle
            this.manifest = optionsOrHandle.manifest
            this.transport = optionsOrHandle.transport
            this.subscribeTransport = optionsOrHandle.subscribe
        } else {
            throw new Error('Invalid RendererCapabilityClient options: handle and transport are required')
        }
    }

    /**
     * Returns the opaque capability handle bound to this client.
     */
    getHandle(): CapabilityHandle {
        return this.handle
    }

    /**
     * Checks whether the client holds a declared capability.
     */
    has(capability: CapabilityId): boolean {
        if (!this.manifest?.capabilities) {
            return false
        }
        return this.manifest.capabilities.some((pattern) =>
            matchesCapability(pattern, capability),
        )
    }

    /**
     * Invoke a capability method with arguments.
     */
    async invoke<TResult = unknown>(method: string, args: unknown[] = []): Promise<TResult> {
        const rawResponse = await this.transport(this.handle, method, args)

        if (rawResponse && typeof rawResponse === 'object' && 'ok' in rawResponse) {
            const response = rawResponse as CapabilityInvokeResponse<TResult>
            if (response.ok === true && 'value' in response) {
                return response.value
            }
            if (response.ok === false && 'error' in response) {
                throw deserializeCapabilityError(response.error)
            }
        }

        return rawResponse as TResult
    }

    /**
     * Subscribe to a capability event with handle lifecycle management.
     */
    subscribe<T = unknown>(eventName: string, listener: (payload: T) => void): () => void {
        if (this.subscribeTransport) {
            return this.subscribeTransport(this.handle, eventName, listener as (payload: unknown) => void)
        }
        return () => {}
    }
}
