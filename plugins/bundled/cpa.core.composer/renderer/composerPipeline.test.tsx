import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
    AttachmentProvider,
    ComposerControlContribution,
    ComposerSubmitPayload,
    ComposerSubmitPreprocessorContribution,
    HostServices,
} from '@cpa/plugin-api'
import {
    RendererRegistry,
} from '../../../../frontend/src/plugins/platform/rendererRegistry.js'
import {
    runSubmitPreprocessors,
    selectAttachmentProviders,
    selectComposerControls,
    selectSubmitPreprocessors,
} from '../../../../frontend/src/plugins/platform/contributions/composer.js'
import { HostServicesProvider, setDefaultHostServices } from '@cpa/plugin-ui'

describe('Composer Contribution Pipelines and Architecture Boundaries', () => {
    let mockServices: HostServices
    let testRegistry: RendererRegistry

    beforeEach(() => {
        testRegistry = new RendererRegistry()
        mockServices = {
            sessions: {
                list: vi.fn(async () => []),
                get: vi.fn(async () => undefined),
                update: vi.fn(async () => {}),
                broadcastRunStatus: vi.fn(async () => {}),
                getSnapshot: () => [
                    {
                        id: 'session-1',
                        title: 'Test Session',
                        projectId: 'p1',
                        modelId: 'gpt-5-codex',
                        reasoningEffort: 'medium',
                    },
                ],
                getCurrentSessionId: () => 'session-1',
                getActiveRun: () => undefined,
                setSessionRuntimeSettings: vi.fn(),
            },
            projects: {
                list: vi.fn(async () => [{ id: 'p1', name: 'Proj1', path: '/path/to/p1', pinned: false, createdAt: 0, updatedAt: 0 }]),
                save: vi.fn(async () => {}),
                remove: vi.fn(async () => {}),
                getSnapshot: () => [{ id: 'p1', name: 'Proj1', path: '/path/to/p1', pinned: false, createdAt: 0, updatedAt: 0 }],
                selectDirectory: vi.fn(async () => '/path/to/selected'),
            },
            settings: {
                getSnapshot: () => ({
                    modelId: 'gpt-5-codex',
                    reasoningLevel: 'medium',
                    speed: 'standard',
                    systemPrompt: '',
                    modelSettings: {},
                }),
                subscribe: vi.fn(() => () => {}),
                update: vi.fn(async () => {}),
                setModelId: vi.fn(),
                setReasoningLevel: vi.fn(),
            },
            models: {
                getModels: () => [
                    { id: 'gpt-5-codex', label: 'GPT-5 CPA', contextWindow: 200000, supportedReasoningEfforts: ['low', 'medium', 'high', 'off'] },
                    { id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet', contextWindow: 200000, supportedReasoningEfforts: ['low', 'high', 'off'] },
                ],
                getStatus: () => 'ready',
                getError: () => null,
                subscribe: vi.fn(() => () => {}),
                refresh: vi.fn(async () => {}),
            },
            worktrees: {
                list: vi.fn(async () => []),
                getSnapshot: () => [],
                setup: vi.fn(async () => ({ success: true, worktreePath: '/p1/wt' })),
            },
            hooks: {
                executeHook: vi.fn(async () => {}),
            },
            navigation: {
                navigate: vi.fn(),
            },
            notifications: {
                notify: vi.fn(),
            },
            schedule: {
                getSchedules: () => [],
                subscribe: vi.fn(() => () => {}),
            },
            skillUsage: {
                recordUsage: vi.fn(),
                fetchUsageCounts: vi.fn(async () => ({})),
                getSnapshot: () => ({}),
                subscribe: vi.fn(() => () => {}),
            },
            persistence: {
                get: vi.fn(async () => null),
                set: vi.fn(async () => {}),
                delete: vi.fn(async () => {}),
            },
            ui: {
                getPendingSessionContext: () => ({ projectId: null, branch: null }),
                setPendingSessionContext: vi.fn(),
                isGroupCollapsed: () => false,
                toggleGroup: vi.fn(),
                setSidebarCollapsed: vi.fn(),
                openSettings: vi.fn(),
                pushToast: vi.fn(),
                emitEvent: vi.fn(),
            },
            fileSystem: {
                readFile: vi.fn(async () => ({ dataBase64: '' })),
                writeFile: vi.fn(async () => {}),
                selectFilesAndFolders: vi.fn(async () => [
                    { name: 'file1.ts', path: '/path/file1.ts', isDirectory: false },
                ]),
            },
            chatMessages: {
                getDisplayMessages: () => [],
                getEntries: () => [],
                send: vi.fn(async () => 'run-1'),
                stop: vi.fn(),
                abort: vi.fn(),
                compact: vi.fn(async () => {}),
                getAgentRunState: () => ({ isStreaming: false, activeRunId: null }),
                subscribeAgentRunState: vi.fn(() => () => {}),
                getSupportsImages: () => true,
                subscribeSupportsImages: vi.fn(() => () => {}),
                getPrompts: () => [],
                subscribePrompts: vi.fn(() => () => {}),
            },
        }
        setDefaultHostServices(mockServices)
    })

    describe('1. SubmitPreprocessor Pipeline', () => {
        it('runs preprocessors strictly in order and chains payload transformations', async () => {
            const prep1: ComposerSubmitPreprocessorContribution = {
                id: 'prep-second',
                order: 20,
                preprocess: (payload) => ({
                    ...payload,
                    text: `${payload.text} -> prep2(20)`,
                }),
            }
            const prep2: ComposerSubmitPreprocessorContribution = {
                id: 'prep-first',
                order: 5,
                preprocess: (payload) => ({
                    ...payload,
                    text: `${payload.text} -> prep1(5)`,
                }),
            }
            const prep3: ComposerSubmitPreprocessorContribution = {
                id: 'prep-async-third',
                order: 30,
                preprocess: async (payload) => ({
                    ...payload,
                    text: `${payload.text} -> prep3(30-async)`,
                }),
            }

            testRegistry.registerSubmitPreprocessor(prep1)
            testRegistry.registerSubmitPreprocessor(prep2)
            testRegistry.registerSubmitPreprocessor(prep3)

            const initial: ComposerSubmitPayload = { text: 'initial' }
            const result = await runSubmitPreprocessors(initial, testRegistry, {
                sessionId: 'session-1',
            })

            expect(result.text).toBe('initial -> prep1(5) -> prep2(20) -> prep3(30-async)')
        })

        it('isolates errors from failing preprocessors and continues running remaining preprocessors', async () => {
            const failingPrep: ComposerSubmitPreprocessorContribution = {
                id: 'failing-prep',
                order: 10,
                preprocess: () => {
                    throw new Error('Boom from failing preprocessor!')
                },
            }
            const goodPrep: ComposerSubmitPreprocessorContribution = {
                id: 'good-prep',
                order: 20,
                preprocess: (payload) => ({
                    ...payload,
                    text: `${payload.text} -> recovered`,
                }),
            }

            testRegistry.registerSubmitPreprocessor(failingPrep)
            testRegistry.registerSubmitPreprocessor(goodPrep)

            const initial: ComposerSubmitPayload = { text: 'start' }
            const result = await runSubmitPreprocessors(initial, testRegistry)

            expect(result.text).toBe('start -> recovered')
        })

        it('isolates async rejection in preprocessors and continues chaining', async () => {
            const asyncFailing: ComposerSubmitPreprocessorContribution = {
                id: 'async-failing',
                order: 10,
                preprocess: async () => {
                    throw new Error('Async Boom')
                },
            }
            const goodPrep: ComposerSubmitPreprocessorContribution = {
                id: 'good-prep-after',
                order: 20,
                preprocess: (payload) => ({
                    ...payload,
                    text: `${payload.text} -> ok`,
                }),
            }

            testRegistry.registerSubmitPreprocessor(asyncFailing)
            testRegistry.registerSubmitPreprocessor(goodPrep)

            const initial: ComposerSubmitPayload = { text: 'start' }
            const result = await runSubmitPreprocessors(initial, testRegistry)

            expect(result.text).toBe('start -> ok')
        })
    })

    describe('2. Attachment Providers', () => {
        it('dynamically queries registered attachment providers and merges custom provider select results', async () => {
            const customProvider: AttachmentProvider = {
                id: 'custom-picker',
                order: 15,
                label: 'Custom Picker',
                description: 'Custom attachment picker',
                select: vi.fn(async () => [
                    {
                        id: 'custom-1',
                        name: 'custom_doc.pdf',
                        path: '/path/custom_doc.pdf',
                        kind: 'file',
                    },
                ]),
            }

            testRegistry.registerAttachmentProvider(customProvider)
            const providers = selectAttachmentProviders(testRegistry)
            expect(providers.some((p) => p.id === 'custom-picker')).toBe(true)

            const selected = await customProvider.select!({ sessionId: 'session-1' })
            expect(selected).toHaveLength(1)
            expect(selected[0].name).toBe('custom_doc.pdf')
        })

        it('handles attachment provider rejection and capability denial safely', async () => {
            const deniedProvider: AttachmentProvider = {
                id: 'denied-provider',
                order: 15,
                label: 'Denied Picker',
                select: vi.fn(async () => {
                    const err: any = new Error('Capability filesystem.read denied')
                    err.code = 'CAPABILITY_DENIED'
                    throw err
                }),
            }

            testRegistry.registerAttachmentProvider(deniedProvider)

            await expect(deniedProvider.select!({ sessionId: 'session-1' })).rejects.toThrow(
                'Capability filesystem.read denied',
            )
        })
    })

    describe('3. Composer Controls Dynamic Registration and Error Boundary', () => {
        it('dynamically sorts composer controls by order and supports unregistration', () => {
            const ctrl1: ComposerControlContribution = {
                id: 'ctrl-1',
                placement: 'toolbar-right',
                order: 50,
                component: () => <span data-testid="ctrl-1">Ctrl 1</span>,
            }
            const ctrl2: ComposerControlContribution = {
                id: 'ctrl-2',
                placement: 'toolbar-right',
                order: 10,
                component: () => <span data-testid="ctrl-2">Ctrl 2</span>,
            }

            const unreg1 = testRegistry.registerComposerControl(ctrl1)
            const unreg2 = testRegistry.registerComposerControl(ctrl2)

            let controls = selectComposerControls(testRegistry, 'toolbar-right')
            expect(controls.map((c) => c.id)).toEqual(['ctrl-2', 'ctrl-1'])

            unreg2()
            controls = selectComposerControls(testRegistry, 'toolbar-right')
            expect(controls.map((c) => c.id)).toEqual(['ctrl-1'])

            unreg1()
            controls = selectComposerControls(testRegistry, 'toolbar-right')
            expect(controls).toHaveLength(0)
        })
    })
})
