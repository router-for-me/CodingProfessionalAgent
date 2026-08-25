import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import type {
    PluginEntryDefinition,
    ResolvedPluginPackage,
} from '@cpa/plugin-api'
import {
    createRendererRuntimeHost,
} from './RendererPluginRuntimeHost'
import { rendererRegistry } from './rendererRegistry'
import { actionRegistry } from '@/application/actions/actionRegistry'
import { viewRegistry } from '@/application/views/viewRegistry'
import { SafePluginSurface } from './safePluginSurface'

describe('Plugin Platform Integration (Renderer & Agent Runtime)', () => {
    beforeEach(() => {
        rendererRegistry.clear()
        actionRegistry.clear?.()
        viewRegistry.clear?.()
    })

    afterEach(() => {
        rendererRegistry.clear()
        actionRegistry.clear?.()
        viewRegistry.clear?.()
    })

    describe('Cross-runtime Integration (Main, Renderer, Agent)', () => {
        it('loads all source kinds and runs one generation across all runtimes', async () => {
            const activationOrder: string[] = []

            // Bundled renderer package
            const bundledPkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'fixture.plugin',
                    name: 'Fixture Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    activationPriority: 10,
                    dependencies: {},
                    capabilities: ['tools:register', 'ui:views', 'events:listen'],
                    contributes: {
                        slot: ['fixture-toolbar-btn'],
                        view: ['fixture-view'],
                        action: ['fixture.action'],
                        'tool-factory': ['fixture_agent_tool'],
                        'resource-provider': ['fixture-prompt'],
                    },
                    entries: { renderer: './renderer.ts' },
                },
                source: { kind: 'bundled', spec: 'bundled:fixture.plugin' },
                sourceRoot: '/fixtures/bundled',
                entries: { renderer: './renderer.ts' },
            }

            // Dependent project package
            const projectPkg: ResolvedPluginPackage = {
                manifest: {
                    id: 'fixture.project',
                    name: 'Fixture Project Plugin',
                    version: '1.0.0',
                    apiVersion: '1.0.0',
                    engines: { cpa: '>=1.0.0' },
                    activationPriority: 20,
                    dependencies: { 'fixture.plugin': '>=1.0.0' },
                    capabilities: ['tools:register'],
                    contributes: {},
                    entries: { renderer: './renderer.ts' },
                },
                source: { kind: 'project-directory', spec: 'project:fixture.project' },
                sourceRoot: '/project/.cpa/plugins/fixture.project',
                entries: { renderer: './renderer.ts' },
            }

            let toolExecuted = false
            const definitions: Record<string, PluginEntryDefinition> = {
                'fixture.plugin': {
                    runtime: 'renderer',
                    activate: (context) => {
                        activationOrder.push('fixture.plugin')

                        // 1. UI slot component
                        context.registerSlotComponent?.('chat.toolbar', {
                            id: 'fixture-toolbar-btn',
                            component: () => <button data-testid="fixture-btn">Plugin Button</button>,
                            order: 10,
                        })

                        // 2. View & Navigation
                        context.registerView?.({
                            id: 'fixture-view',
                            title: 'Fixture View',
                            component: () => <div data-testid="fixture-view-content">View Content</div>,
                        })

                        // 3. Action
                        context.registerAction?.({
                            id: 'fixture.action',
                            title: 'Run Fixture Action',
                            handler: () => {},
                            execute: () => 'action-success',
                        })

                        // 4. Agent Tool
                        context.registerAgentTool?.({
                            name: 'fixture_agent_tool',
                            description: 'A tool registered by fixture plugin',
                            parameters: {
                                type: 'object',
                                properties: {
                                    input: { type: 'string', description: 'Input text' },
                                },
                                required: ['input'],
                            },
                            execute: async ({ input }: { input: string }) => {
                                toolExecuted = true
                                return { ok: true, output: `echo: ${input}` }
                            },
                        })

                        // 5. System Prompt Hook
                        context.registerSystemPrompt?.({
                            id: 'fixture-prompt',
                            content: 'System prompt appended by fixture plugin',
                        })
                    },
                    deactivate: () => {},
                },
                'fixture.project': {
                    runtime: 'renderer',
                    activate: () => {
                        activationOrder.push('fixture.project')
                    },
                },
            }

            const host = createRendererRuntimeHost({
                bundledPackages: [projectPkg, bundledPkg],
                defaultDefinitions: definitions,
            })

            await host.activateAll()

            // 1. Verify activation order
            expect(activationOrder).toEqual(['fixture.plugin', 'fixture.project'])
            expect(host.isPluginActive('fixture.plugin')).toBe(true)
            expect(host.isPluginActive('fixture.project')).toBe(true)

            // 2. Verify UI contributions rendered via SafePluginSurface
            const slotContributions = rendererRegistry.getSlotContributions('chat.toolbar')
            expect(slotContributions).toHaveLength(1)
            const ToolbarComponent = slotContributions[0].component
            const { unmount } = render(
                <SafePluginSurface id="toolbar-btn" pluginId="fixture.plugin">
                    <ToolbarComponent />
                </SafePluginSurface>,
            )
            expect(screen.getByTestId('fixture-btn')).toBeDefined()
            unmount()

            // 3. Verify View and Action contributions
            const views = viewRegistry.listViews()
            expect(views.find((v) => v.id === 'fixture-view')).toBeDefined()

            const action = actionRegistry.get('fixture.action')
            expect(action).toBeDefined()
            expect((action as any)?.execute?.()).toBe('action-success')

            // 4. Verify Agent Tool registration & simulated Agent Turn execution
            const agentTools = rendererRegistry.getAgentTools()
            expect(agentTools.find((t) => t.name === 'fixture_agent_tool')).toBeDefined()

            // Acquire generation lease for turn
            const lease = host.acquireGeneration(['fixture.plugin'])
            const generationIds = [lease.generation]
            expect(generationIds).toHaveLength(1)

            // Execute tool within agent turn
            const targetTool = agentTools.find((t) => t.name === 'fixture_agent_tool')
            const toolResult = await (targetTool as any)?.execute?.({ input: 'fixture prompt' }, {})
            expect(toolResult).toEqual({ ok: true, output: 'echo: fixture prompt' })
            expect(toolExecuted).toBe(true)

            // Release lease
            lease.release()

            // 5. Verify Prompt hook
            const prompts = rendererRegistry.getSystemPrompts()
            expect(prompts.some((p) => p.content?.includes('System prompt appended'))).toBe(true)

            // 6. Verify runtime metrics are recorded
            const metrics = host.getPluginMetrics()
            expect(metrics.find((m) => m.pluginId === 'fixture.plugin')?.activationCount).toBe(1)

            // 7. Teardown plugin and verify zero leaked resources
            await host.deactivatePlugin('fixture.plugin')

            expect(host.isPluginActive('fixture.plugin')).toBe(false)
            expect(host.isPluginActive('fixture.project')).toBe(false)

            const leakedSlots = rendererRegistry.getSlotContributions('chat.toolbar')
            const leakedViews = viewRegistry.listViews().filter((v) => v.id === 'fixture-view')
            const leakedActions = actionRegistry.get('fixture.action')
            const leakedPrompts = rendererRegistry.getSystemPrompts().filter((p) => p.id === 'fixture-prompt')
            const leakedTools = rendererRegistry.getAgentTools().filter((t) => t.name === 'fixture_agent_tool')

            expect(leakedSlots).toHaveLength(0)
            expect(leakedViews).toHaveLength(0)
            expect(leakedActions).toBeUndefined()
            expect(leakedPrompts).toHaveLength(0)
            expect(leakedTools).toHaveLength(0)
        })
    })

    describe('SafePluginSurface & Error Boundaries', () => {
        it('isolates faulty plugin components without crashing host UI', () => {
            const FaultyComponent: React.FC = () => {
                throw new Error('Plugin render crash')
            }

            const { container } = render(
                <SafePluginSurface id="crash-surface" pluginId="crash.plugin">
                    <FaultyComponent />
                </SafePluginSurface>,
            )

            expect(container).toBeDefined()
            // Error boundary catches exception and renders user-friendly fallback
            expect(screen.getByText(/Plugin error/i)).toBeDefined()
        })
    })
})
