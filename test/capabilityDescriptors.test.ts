import { describe, it, expect, vi } from 'vitest'
import {
    RENDERER_CAPABILITY_DESCRIPTORS,
    rendererFacingDescriptorNames,
    METHOD_CAPABILITY_MAP,
    getRequiredCapabilityForMethod,
    createHostCapabilityFacade,
    type HostTransportApi,
} from '../src/shared/capabilityDescriptors.js'
import {
    GATEWAY_DISCOVER_CAPABILITY,
    GatewayDiscoveryServiceToken,
    HOST_SERVICE_TOKENS,
    type DiscoveredGateway,
} from '@cpa/plugin-api'

describe('Gateway Discovery Capability and RPC Descriptors', () => {
    it('registers GatewayDiscover in RENDERER_CAPABILITY_DESCRIPTORS', () => {
        const descriptor = RENDERER_CAPABILITY_DESCRIPTORS.find((d) => d.name === 'GatewayDiscover')
        expect(descriptor).toBeDefined()
        expect(descriptor).toEqual({
            name: 'GatewayDiscover',
            method: 'gateway:discover',
            capability: 'gateway.discover',
        })
    })

    it('includes GatewayDiscover in rendererFacingDescriptorNames', () => {
        expect(rendererFacingDescriptorNames).toContain('GatewayDiscover')
    })

    it('maps gateway:discover to gateway.discover in METHOD_CAPABILITY_MAP and helper', () => {
        expect(METHOD_CAPABILITY_MAP.get('gateway:discover')).toBe('gateway.discover')
        expect(getRequiredCapabilityForMethod('gateway:discover')).toBe('gateway.discover')
    })

    it('exposes GATEWAY_DISCOVER_CAPABILITY constant matching the descriptor capability', () => {
        expect(GATEWAY_DISCOVER_CAPABILITY).toBe('gateway.discover')
    })

    it('exposes GatewayDiscoveryServiceToken with expected token id', () => {
        expect(GatewayDiscoveryServiceToken.id).toBe('cpa.service.gateway-discovery')
        expect(HOST_SERVICE_TOKENS.gatewayDiscovery).toBe(GatewayDiscoveryServiceToken)
    })

    it('invokes gateway:discover via createHostCapabilityFacade', async () => {
        const mockGateway: DiscoveredGateway = {
            instanceName: 'Local AI Proxy',
            host: 'ai-proxy.local',
            port: 8317,
            addresses: ['192.168.1.100'],
            primaryAddress: '192.168.1.100',
            baseUrl: 'http://192.168.1.100:8317',
            product: 'cliproxyapi',
            version: '1.2.0',
            authRequired: true,
            authMethods: ['bearer'],
            protocols: ['openai', 'anthropic'],
            features: ['discovery', 'streaming'],
            endpoints: {
                openai: '/v1',
                anthropic: '/v1',
            },
            rawTxt: {
                product: 'cliproxyapi',
                auth_required: 'true',
            },
        }

        const invokeSpy = vi.fn().mockImplementation(async (_handle, method, args) => {
            if (method === 'gateway:discover') {
                expect(args).toEqual([4000])
                return { ok: true, value: [mockGateway] }
            }
            return { ok: true, value: null }
        })

        const mockTransport: HostTransportApi = {
            invoke: invokeSpy,
            subscribeNativeEvents: vi.fn().mockReturnValue(() => {}),
        }

        const facade = createHostCapabilityFacade(mockTransport, 'test-handle')
        const result = await facade.GatewayDiscover(4000)

        expect(invokeSpy).toHaveBeenCalledWith('test-handle', 'gateway:discover', [4000])
        expect(result).toEqual([mockGateway])
    })

    it('handles GatewayDiscover invocation with default/undefined timeout', async () => {
        const invokeSpy = vi.fn().mockResolvedValue({ ok: true, value: [] })

        const mockTransport: HostTransportApi = {
            invoke: invokeSpy,
            subscribeNativeEvents: vi.fn().mockReturnValue(() => {}),
        }

        const facade = createHostCapabilityFacade(mockTransport, 'test-handle')
        const result = await facade.GatewayDiscover()

        expect(invokeSpy).toHaveBeenCalledWith('test-handle', 'gateway:discover', [])
        expect(result).toEqual([])
    })
})
