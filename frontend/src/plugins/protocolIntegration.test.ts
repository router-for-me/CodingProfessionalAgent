import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ModelCatalogEntry } from '@/features/models/types'
import type {
    AgentRunEvent,
    AssistantStreamEvent,
} from '@/features/agent-runtime/agent/types'
import type {
    AssistantEntry,
    UserEntry,
} from '@/features/agent-runtime/session/types'
import { FakeNativeBridge } from '@/features/agent-runtime/native/fakeNativeBridge'
import { CLIProxyAPIAgentService } from '@/features/agent-runtime/CLIProxyAPIAgentService'
import {
    RendererRegistry,
    rendererRegistry,
} from '@/plugins/platform/rendererRegistry'
import { PluginEventBus } from '@cpa/plugin-kernel'
import { RendererPluginRuntimeHost } from '@/plugins/platform/RendererPluginRuntimeHost'
import type {
    PluginEntryDefinition,
    PluginManifest,
    ProtocolMiddleware,
    ProtocolProvider,
    ProtocolStreamInput,
    ProtocolStreamOptions,
} from '@cpa/plugin-api'
import { definePluginEntry } from '@cpa/plugin-sdk'

// ---------------------------------------------------------------------------
// Test Fixtures & Helpers
// ---------------------------------------------------------------------------

const MOCK_MODEL: ModelCatalogEntry = {
    id: 'mock-model-v1',
    label: 'Mock Model v1',
    description: 'A mock model for protocol tests',
    supportsFast: true,
    reasoningLevels: [],
    input: ['text'],
    contextWindow: 128000,
    maxTokens: 4096,
}

function userEntry(text: string, id = 'user-1'): UserEntry {
    return {
        id,
        sessionId: 'session-protocol-1',
        kind: 'user',
        content: [{ type: 'text', text }],
        createdAt: Date.now(),
    }
}

function assistantEntry(
    text: string,
    id = 'asst-1',
    status: AssistantEntry['status'] = 'running' as any
): AssistantEntry {
    return {
        id,
        sessionId: 'session-protocol-1',
        kind: 'assistant',
        status,
        stopReason: 'stop',
        content: text ? [{ type: 'text', text }] : [],
        createdAt: Date.now(),
    }
}

function doneAssistant(
    seed: AssistantEntry,
    patch?: Partial<AssistantEntry>
): AssistantEntry {
    return {
        ...seed,
        status: 'done',
        ...patch,
    }
}

interface TestPluginFixture {
    manifest: PluginManifest
    entry: PluginEntryDefinition
}

// ---------------------------------------------------------------------------
// Plugin Definitions for Integration Testing
// ---------------------------------------------------------------------------

const createCustomProtocolPlugin = (
    id = 'my-custom-protocol-plugin',
    providerId = 'custom-mock-protocol',
    providerName = 'Custom Mock Protocol Provider',
    responseText = 'Hello from custom protocol client!',
    onStreamCall?: (
        input: ProtocolStreamInput,
        options?: ProtocolStreamOptions
    ) => void
): TestPluginFixture => ({
    manifest: {
        id,
        name: providerName,
        version: '1.0.0',
        apiVersion: '1.0.0',
        engines: { cpa: '>=1.0.0' },
        entries: { renderer: './index.ts' },
        dependencies: {},
        capabilities: [],
        contributes: {
            protocol: [providerId],
        },
    },
    entry: definePluginEntry({
        runtime: 'renderer',
        activate: (ctx: any) => {
            const provider: ProtocolProvider = {
                id: providerId,
                name: providerName,
                isDefault: true,
                createClient: (_opts: any) => ({
                    stream: async function* (input: any, options: any) {
                        onStreamCall?.(input, options)
                        const seed = input?.seed ?? assistantEntry('', 'asst-1')
                        yield {
                            type: 'text-delta',
                            contentIndex: 0,
                            delta: responseText,
                            partial: seed,
                        }
                        const finalMsg = doneAssistant(seed, {
                            content: [
                                {
                                    type: 'text',
                                    text: responseText,
                                },
                            ],
                            stopReason: 'stop',
                        })
                        yield {
                            type: 'done',
                            reason: 'stop',
                            message: finalMsg,
                        }
                        return finalMsg
                    },
                }),
            }
            ctx.registerProtocolProvider(provider)
        },
    }),
})

const createGuardrailMiddlewarePlugin = (options?: {
    order?: number
    keywordToRedact?: string
    redactedReplacement?: string
    onContextReceived?: (context: { sessionId: string; model: string }) => void
    onComplete?: (stats: { elapsedMs: number; error?: Error }) => void
    onStreamEventCalled?: (event: AssistantStreamEvent) => void
}): TestPluginFixture => ({
    manifest: {
        id: 'my-guardrail-middleware-plugin',
        name: 'Guardrail Middleware Plugin',
        version: '1.0.0',
        apiVersion: '1.0.0',
        engines: { cpa: '>=1.0.0' },
        entries: { renderer: './index.ts' },
        dependencies: {},
        capabilities: [],
        contributes: {
            'protocol-middleware': ['guardrail-middleware'],
        },
    },
    entry: definePluginEntry({
        runtime: 'renderer',
        activate: (ctx: any) => {
            const keyword = options?.keywordToRedact ?? 'UNSAFE_KEYWORD'
            const replacement = options?.redactedReplacement ?? '[REDACTED_SECURITY]'
            const middleware: ProtocolMiddleware = {
                id: 'guardrail-middleware',
                order: options?.order ?? 10,
                onRequest: (input) => ({
                    ...input,
                    systemPrompt: `${input.systemPrompt}\n[GUARDRAIL: Enforce safety standards]`,
                }),
                onStreamEvent: (event, context) => {
                    options?.onContextReceived?.(context)
                    options?.onStreamEventCalled?.(event)
                    if (
                        event.type === 'text-delta' &&
                        typeof event.delta === 'string' &&
                        event.delta.includes(keyword)
                    ) {
                        return {
                            ...event,
                            delta: event.delta.split(keyword).join(replacement),
                        }
                    }
                    if (event.type === 'done' && event.message?.content) {
                        const sanitizedContent = event.message.content.map((block) => {
                            if (block.type === 'text' && block.text.includes(keyword)) {
                                return {
                                    ...block,
                                    text: block.text.split(keyword).join(replacement),
                                }
                            }
                            return block
                        })
                        return {
                            ...event,
                            message: {
                                ...event.message,
                                content: sanitizedContent,
                            },
                        }
                    }
                    return event
                },
                onStreamComplete: (stats) => {
                    options?.onComplete?.(stats)
                },
            }
            ctx.registerProtocolMiddleware(middleware)
        },
    }),
})

const createMetricsMiddlewarePlugin = (options?: {
    order?: number
    onEvent?: (event: AssistantStreamEvent) => void
}): TestPluginFixture => ({
    manifest: {
        id: 'my-metrics-middleware-plugin',
        name: 'Metrics Middleware Plugin',
        version: '1.0.0',
        apiVersion: '1.0.0',
        engines: { cpa: '>=1.0.0' },
        entries: { renderer: './index.ts' },
        dependencies: {},
        capabilities: [],
        contributes: {
            'protocol-middleware': ['metrics-middleware'],
        },
    },
    entry: definePluginEntry({
        runtime: 'renderer',
        activate: (ctx: any) => {
            const middleware: ProtocolMiddleware = {
                id: 'metrics-middleware',
                order: options?.order ?? 20,
                onRequest: (input) => ({
                    ...input,
                    systemPrompt: `${input.systemPrompt}\n[METRICS: Telemetry enabled]`,
                }),
                onStreamEvent: (event) => {
                    options?.onEvent?.(event)
                    return event
                },
            }
            ctx.registerProtocolMiddleware(middleware)
        },
    }),
})

const createFaultyMiddlewarePlugin = (hooks?: {
    onBeforeRequestThrow?: () => void
    onBeforeStreamEventThrow?: () => void
}): TestPluginFixture => ({
    manifest: {
        id: 'my-faulty-middleware-plugin',
        name: 'Faulty Middleware Plugin',
        version: '1.0.0',
        apiVersion: '1.0.0',
        engines: { cpa: '>=1.0.0' },
        entries: { renderer: './index.ts' },
        dependencies: {},
        capabilities: [],
        contributes: {
            'protocol-middleware': ['faulty-middleware'],
        },
    },
    entry: definePluginEntry({
        runtime: 'renderer',
        activate: (ctx: any) => {
            const middleware: ProtocolMiddleware = {
                id: 'faulty-middleware',
                order: 5,
                onRequest: (input) => {
                    hooks?.onBeforeRequestThrow?.()
                    return input
                },
                onStreamEvent: (event) => {
                    hooks?.onBeforeStreamEventThrow?.()
                    return event
                },
            }
            ctx.registerProtocolMiddleware(middleware)
        },
    }),
})

// ---------------------------------------------------------------------------
// Integration Tests Suite
// ---------------------------------------------------------------------------

describe('Universal Plugin Platform: Protocol SPI & Middleware Integration', () => {
    let bridge: FakeNativeBridge
    let customRegistry: RendererRegistry
    let pluginManager: RendererPluginRuntimeHost

    beforeEach(() => {
        rendererRegistry.clear()
        bridge = new FakeNativeBridge()
        customRegistry = new RendererRegistry()
        pluginManager = new RendererPluginRuntimeHost({
            registry: customRegistry,
            bundledPackages: [],
            eventBus: new PluginEventBus(),
        })
    })

    afterEach(async () => {
        rendererRegistry.clear()
        customRegistry.clear()
        await pluginManager.reset()
    })

    describe('1. Custom Protocol Provider Plugin End-to-End', () => {
        it('registers and uses a custom protocol provider for agent chat streaming', async () => {
            const expectedResponse = 'Hello from the dynamically loaded custom protocol!'
            let streamCalled = false

            const customPlugin = createCustomProtocolPlugin(
                'my-custom-provider-plugin',
                'custom-test-protocol',
                'My Custom Protocol',
                expectedResponse,
                () => {
                    streamCalled = true
                }
            )

            await pluginManager.registerPlugin(customPlugin.manifest, customPlugin.entry)
            await pluginManager.activatePlugin(customPlugin.manifest.id)

            // Verify registration in registry
            const provider = customRegistry.getProtocolProvider(
                'custom-test-protocol'
            )
            expect(provider).toBeDefined()
            expect(provider?.id).toBe('custom-test-protocol')

            // Initialize CLIProxyAPIAgentService with the custom registry
            const agentService = new CLIProxyAPIAgentService({
                bridge,
                extensionRegistry: customRegistry,
            })

            const prepared = await agentService.prepare({
                baseUrl: 'https://custom-proxy.example.com/v1',
                apiKey: 'test-key-xyz',
                modelId: MOCK_MODEL.id,
                models: [MOCK_MODEL],
                reasoningLevel: 'none',
                speed: 'standard',
                requestApproval: false,
                protocolProviderId: 'custom-test-protocol',
            })

            const initialUser = userEntry('Hello CPA!')
            const stream = agentService.streamChat({
                prepared,
                sessionId: 'session-protocol-1',
                runId: 'run-protocol-1',
                entries: [initialUser],
                userEntry: initialUser,
            })

            const events: AgentRunEvent[] = []
            for await (const event of stream) {
                events.push(event)
            }

            expect(streamCalled).toBe(true)

            // Verify outgoing events contains text-delta and assistant-end with expectedResponse
            const deltas = events.filter(
                (e) => e.type === 'assistant-update' && e.streamEvent?.type === 'text-delta'
            )
            expect(deltas.length).toBeGreaterThanOrEqual(1)
            expect(
                deltas.some(
                    (d) =>
                        d.type === 'assistant-update' &&
                        (d.streamEvent as any)?.delta?.includes(expectedResponse)
                )
            ).toBe(true)

            const assistantEnd = events.find((e) => e.type === 'assistant-end')
            expect(assistantEnd).toBeDefined()
            const endEvent = assistantEnd as Extract<
                AgentRunEvent,
                { type: 'assistant-end' }
            >
            expect(endEvent.entry.content[0]).toEqual({
                type: 'text',
                text: expectedResponse,
            })
            expect(endEvent.entry.status).toBe('done')
        })
    })

    describe('2. Custom Protocol Middleware Plugin End-to-End', () => {
        it('augments system prompt via onRequest and rewrites output via onStreamEvent', async () => {
            const completedStats: { elapsedMs: number; error?: Error }[] = []
            const receivedContexts: { sessionId: string; model: string }[] = []
            let streamReceivedInput: ProtocolStreamInput | undefined

            // Custom client returning text with an unsafe keyword
            const customProtocolWithUnsafeText: TestPluginFixture = {
                manifest: {
                    id: 'my-unsafe-custom-protocol',
                    name: 'Unsafe Custom Protocol',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { renderer: './index.ts' },
                    dependencies: {},
                    capabilities: [],
                    contributes: {
                        protocol: ['unsafe-custom-protocol'],
                    },
                },
                entry: definePluginEntry({
                    runtime: 'renderer',
                    activate: (ctx: any) => {
                        const provider: ProtocolProvider = {
                            id: 'unsafe-custom-protocol',
                            name: 'Unsafe Custom Protocol',
                            isDefault: true,
                            createClient: () => ({
                                stream: async function* (input: ProtocolStreamInput) {
                                    streamReceivedInput = input
                                    const seed = (input as any)?.seed ?? assistantEntry('', 'asst-1')
                                    yield {
                                        type: 'text-delta',
                                        contentIndex: 0,
                                        delta: 'Caution: UNSAFE_KEYWORD detected in output',
                                        partial: seed,
                                    }
                                    const finalEntry = doneAssistant(seed, {
                                        content: [
                                            {
                                                type: 'text',
                                                text: 'Caution: UNSAFE_KEYWORD detected in output',
                                            },
                                        ],
                                        stopReason: 'stop',
                                    })
                                    yield {
                                        type: 'done',
                                        reason: 'stop',
                                        message: finalEntry,
                                    }
                                    return finalEntry
                                },
                            }),
                        }
                        ctx.registerProtocolProvider(provider)
                    },
                }),
            }

            const guardrailPlugin = createGuardrailMiddlewarePlugin({
                keywordToRedact: 'UNSAFE_KEYWORD',
                redactedReplacement: '[REDACTED_SECURITY]',
                onContextReceived: (ctx) => receivedContexts.push(ctx),
                onComplete: (stats) => completedStats.push(stats),
            })

            await pluginManager.registerPlugin(customProtocolWithUnsafeText.manifest, customProtocolWithUnsafeText.entry)
            await pluginManager.activatePlugin(
                customProtocolWithUnsafeText.manifest.id
            )
            await pluginManager.registerPlugin(guardrailPlugin.manifest, guardrailPlugin.entry)
            await pluginManager.activatePlugin(guardrailPlugin.manifest.id)

            const agentService = new CLIProxyAPIAgentService({
                bridge,
                extensionRegistry: customRegistry,
            })

            const prepared = await agentService.prepare({
                baseUrl: 'https://proxy.example.com',
                apiKey: 'secret-key',
                modelId: MOCK_MODEL.id,
                models: [MOCK_MODEL],
                reasoningLevel: 'none',
                speed: 'standard',
                requestApproval: false,
                protocolProviderId: 'unsafe-custom-protocol',
            })

            const initialUser = userEntry('Test guardrail')
            const stream = agentService.streamChat({
                prepared,
                sessionId: 'session-middleware-1',
                runId: 'run-middleware-1',
                entries: [initialUser],
                userEntry: initialUser,
            })

            const events: AgentRunEvent[] = []
            for await (const event of stream) {
                events.push(event)
            }

            // Verify onRequest updated system prompt
            expect(streamReceivedInput).toBeDefined()
            expect(streamReceivedInput?.systemPrompt).toContain(
                '[GUARDRAIL: Enforce safety standards]'
            )

            // Verify context passed to onStreamEvent
            expect(receivedContexts.length).toBeGreaterThanOrEqual(1)
            expect(receivedContexts[0]).toEqual({
                sessionId: 'session-middleware-1',
                model: 'mock-model-v1',
            })

            // Verify onStreamEvent intercepted and sanitized the text-delta
            const deltas = events.filter(
                (e) => e.type === 'assistant-update' && e.streamEvent?.type === 'text-delta'
            )
            expect(deltas.length).toBeGreaterThanOrEqual(1)
            for (const d of deltas) {
                if (d.type === 'assistant-update') {
                    expect((d.streamEvent as any)?.delta).not.toContain('UNSAFE_KEYWORD')
                    expect((d.streamEvent as any)?.delta).toContain('[REDACTED_SECURITY]')
                }
            }

            // Verify completed final assistant message is sanitized
            const assistantEnd = events.find((e) => e.type === 'assistant-end')
            expect(assistantEnd).toBeDefined()
            const endEvent = assistantEnd as Extract<
                AgentRunEvent,
                { type: 'assistant-end' }
            >
            expect(endEvent.entry.content[0]).toEqual({
                type: 'text',
                text: 'Caution: [REDACTED_SECURITY] detected in output',
            })

            // Verify onStreamComplete hook fired
            expect(completedStats.length).toBe(1)
            expect(completedStats[0].elapsedMs).toBeGreaterThanOrEqual(0)
            expect(completedStats[0].error).toBeUndefined()
        })
    })

    describe('3. Dynamic Switching and Multi-Provider Support', () => {
        it('allows selecting different registered protocol providers per agent preparation', async () => {
            const providerAPlugin = createCustomProtocolPlugin(
                'provider-a-plugin',
                'provider-alpha',
                'Provider Alpha',
                'Response from Alpha'
            )
            const providerBPlugin = createCustomProtocolPlugin(
                'provider-b-plugin',
                'provider-beta',
                'Provider Beta',
                'Response from Beta'
            )

            await pluginManager.registerPlugin(providerAPlugin.manifest, providerAPlugin.entry)
            await pluginManager.activatePlugin('provider-a-plugin')
            await pluginManager.registerPlugin(providerBPlugin.manifest, providerBPlugin.entry)
            await pluginManager.activatePlugin('provider-b-plugin')

            const agentService = new CLIProxyAPIAgentService({
                bridge,
                extensionRegistry: customRegistry,
            })

            // Run 1: with Alpha
            const prepA = await agentService.prepare({
                baseUrl: 'https://proxy.example.com',
                apiKey: 'key-alpha',
                modelId: MOCK_MODEL.id,
                models: [MOCK_MODEL],
                reasoningLevel: 'none',
                speed: 'standard',
                requestApproval: false,
                protocolProviderId: 'provider-alpha',
            })

            const userA = userEntry('Call Alpha')
            const streamA = agentService.streamChat({
                prepared: prepA,
                sessionId: 'session-alpha',
                runId: 'run-alpha',
                entries: [userA],
                userEntry: userA,
            })

            const eventsA: AgentRunEvent[] = []
            for await (const ev of streamA) {
                eventsA.push(ev)
            }
            const endA = eventsA.find((e) => e.type === 'assistant-end') as Extract<
                AgentRunEvent,
                { type: 'assistant-end' }
            >
            expect(endA.entry.content[0]).toEqual({
                type: 'text',
                text: 'Response from Alpha',
            })

            // Run 2: with Beta
            const prepB = await agentService.prepare({
                baseUrl: 'https://proxy.example.com',
                apiKey: 'key-beta',
                modelId: MOCK_MODEL.id,
                models: [MOCK_MODEL],
                reasoningLevel: 'none',
                speed: 'standard',
                requestApproval: false,
                protocolProviderId: 'provider-beta',
            })

            const userB = userEntry('Call Beta')
            const streamB = agentService.streamChat({
                prepared: prepB,
                sessionId: 'session-beta',
                runId: 'run-beta',
                entries: [userB],
                userEntry: userB,
            })

            const eventsB: AgentRunEvent[] = []
            for await (const ev of streamB) {
                eventsB.push(ev)
            }
            const endB = eventsB.find(
                (e) => e.type === 'assistant-end'
            ) as Extract<AgentRunEvent, { type: 'assistant-end' }>
            expect(endB.entry.content[0]).toEqual({
                type: 'text',
                text: 'Response from Beta',
            })
        })
    })

    describe('4. Multi-Middleware Pipeline Composition and Ordering', () => {
        it('executes multiple middlewares in defined order for both onRequest and onStreamEvent', async () => {
            const executionSequence: string[] = []
            let streamInputPrompt = ''

            const customProtocol: TestPluginFixture = {
                manifest: {
                    id: 'ordering-custom-protocol',
                    name: 'Ordering Custom Protocol',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    entries: { renderer: './index.ts' },
                    dependencies: {},
                    capabilities: [],
                    contributes: {
                        protocol: ['ordering-custom-protocol'],
                    },
                },
                entry: definePluginEntry({
                    runtime: 'renderer',
                    activate: (ctx: any) => {
                        ctx.registerProtocolProvider({
                            id: 'ordering-custom-protocol',
                            name: 'Ordering Custom Protocol',
                            isDefault: true,
                            createClient: () => ({
                                stream: async function* (input: ProtocolStreamInput) {
                                    streamInputPrompt = input.systemPrompt
                                    const seed = (input as any)?.seed ?? assistantEntry('', 'asst-1')
                                    yield {
                                        type: 'text-delta',
                                        contentIndex: 0,
                                        delta: 'Raw message from provider',
                                        partial: seed,
                                    }
                                    const final = doneAssistant(seed, {
                                        content: [
                                            {
                                                type: 'text',
                                                text: 'Raw message from provider',
                                            },
                                        ],
                                        stopReason: 'stop',
                                    })
                                    yield {
                                        type: 'done',
                                        reason: 'stop',
                                        message: final,
                                    }
                                    return final
                                },
                            }),
                        })
                    },
                }),
            }

            const middlewareLayer1 = createGuardrailMiddlewarePlugin({
                order: 10,
                onStreamEventCalled: () => {
                    executionSequence.push('layer-10-event')
                },
            })

            const middlewareLayer2 = createMetricsMiddlewarePlugin({
                order: 20,
                onEvent: () => {
                    executionSequence.push('layer-20-event')
                },
            })

            await pluginManager.registerPlugin(customProtocol.manifest, customProtocol.entry)
            await pluginManager.activatePlugin(customProtocol.manifest.id)
            await pluginManager.registerPlugin(middlewareLayer2.manifest, middlewareLayer2.entry) // registered first but order 20
            await pluginManager.activatePlugin(middlewareLayer2.manifest.id)
            await pluginManager.registerPlugin(middlewareLayer1.manifest, middlewareLayer1.entry) // registered second but order 10
            await pluginManager.activatePlugin(middlewareLayer1.manifest.id)

            const agentService = new CLIProxyAPIAgentService({
                bridge,
                extensionRegistry: customRegistry,
            })

            const prepared = await agentService.prepare({
                baseUrl: 'https://proxy.example.com',
                apiKey: 'key',
                modelId: MOCK_MODEL.id,
                models: [MOCK_MODEL],
                reasoningLevel: 'none',
                speed: 'standard',
                requestApproval: false,
                protocolProviderId: 'ordering-custom-protocol',
            })

            const user = userEntry('Test Ordering')
            const stream = agentService.streamChat({
                prepared,
                sessionId: 'session-ordering',
                runId: 'run-ordering',
                entries: [user],
                userEntry: user,
            })

            for await (const _ of stream) {
                // Consume
            }

            // Verify onRequest order (10 then 20) in system prompt composition
            const idx10 = streamInputPrompt.indexOf('GUARDRAIL')
            const idx20 = streamInputPrompt.indexOf('METRICS')
            expect(idx10).toBeGreaterThan(-1)
            expect(idx20).toBeGreaterThan(-1)
            expect(idx10).toBeLessThan(idx20)

            // Verify onStreamEvent execution order (order 10 precedes order 20)
            expect(executionSequence[0]).toBe('layer-10-event')
            expect(executionSequence[1]).toBe('layer-20-event')
        })
    })

    describe('5. Error Handling and Fault Isolation', () => {
        it('isolates middleware crashes without taking down the entire streaming pipeline', async () => {
            const customProtocol = createCustomProtocolPlugin(
                'error-isolation-protocol-plugin',
                'isolation-protocol',
                'Isolation Protocol',
                'Normal response from protocol'
            )

            const faultyPlugin = createFaultyMiddlewarePlugin({
                onBeforeStreamEventThrow: () => {
                    throw new Error('Explosion in custom middleware stream event!')
                },
            })

            await pluginManager.registerPlugin(customProtocol.manifest, customProtocol.entry)
            await pluginManager.activatePlugin(customProtocol.manifest.id)
            await pluginManager.registerPlugin(faultyPlugin.manifest, faultyPlugin.entry)
            await pluginManager.activatePlugin(faultyPlugin.manifest.id)

            const agentService = new CLIProxyAPIAgentService({
                bridge,
                extensionRegistry: customRegistry,
            })

            const prepared = await agentService.prepare({
                baseUrl: 'https://proxy.example.com',
                apiKey: 'key',
                modelId: MOCK_MODEL.id,
                models: [MOCK_MODEL],
                reasoningLevel: 'none',
                speed: 'standard',
                requestApproval: false,
                protocolProviderId: 'isolation-protocol',
            })

            const user = userEntry('Test Fault')
            const stream = agentService.streamChat({
                prepared,
                sessionId: 'session-fault',
                runId: 'run-fault',
                entries: [user],
                userEntry: user,
            })

            const events: AgentRunEvent[] = []
            // Stream should NOT crash; faulty middleware should be safely captured/ignored
            for await (const event of stream) {
                events.push(event)
            }

            const assistantEnd = events.find((e) => e.type === 'assistant-end') as Extract<
                AgentRunEvent,
                { type: 'assistant-end' }
            >
            expect(assistantEnd).toBeDefined()
            expect(assistantEnd.entry.content[0]).toEqual({
                type: 'text',
                text: 'Normal response from protocol',
            })
        })
    })
})
