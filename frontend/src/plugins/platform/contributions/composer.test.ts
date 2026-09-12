import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
    selectComposerControls,
    selectAttachmentProviders,
    selectSubmitPreprocessors,
    runSubmitPreprocessors,
    useComposerControls,
    useAttachmentProviders,
    useSubmitPreprocessors,
    type ComposerControlContribution,
    type AttachmentProvider,
    type ComposerSubmitPreprocessorContribution,
} from './composer'
import { RendererRegistry } from '../rendererRegistry'
import { RendererPluginRuntimeHost } from '../RendererPluginRuntimeHost'
import { PluginEventBus } from '@cpa/plugin-kernel'

describe('composer contribution selectors and pipeline', () => {
    it('preserves control and submit preprocessor order', async () => {
        const registry = new RendererRegistry()
        const eventBus = new PluginEventBus()
        const manager = new RendererPluginRuntimeHost({ registry, eventBus })

        await manager.activateAll()

        const allControls = selectComposerControls(registry)
        expect(allControls.length).toBeGreaterThanOrEqual(4)

        const toolbarLeftControls = selectComposerControls(registry, 'toolbar-left')
        expect(toolbarLeftControls.map((item) => item.id)).toEqual([
            'composer-attach',
            'request-approval',
        ])

        const toolbarRightControls = selectComposerControls(registry, 'toolbar-right')
        expect(toolbarRightControls.map((item) => item.id)).toEqual([
            'context-usage-ring',
            'model-select',
        ])

        const attachmentProviders = selectAttachmentProviders(registry)
        expect(attachmentProviders.map((item) => item.id)).toEqual(['files'])

        const preprocessors = selectSubmitPreprocessors(registry)
        expect(preprocessors.map((item) => item.id)).toEqual([
            'prompt-preprocessor',
            'skill-preprocessor',
        ])

        const input = { text: 'Hello world $test-skill', images: [] }
        const processed = await runSubmitPreprocessors(input, registry)
        expect(processed.text).toBe('Hello world $test-skill')
    })

    it('allows dynamic registration and unregistration of composer controls', () => {
        const registry = new RendererRegistry()
        const DummyComponent = () => null

        const control1: ComposerControlContribution = {
            id: 'custom-control-2',
            placement: 'context',
            order: 20,
            component: DummyComponent,
        }
        const control2: ComposerControlContribution = {
            id: 'custom-control-1',
            placement: 'context',
            order: 10,
            component: DummyComponent,
        }

        const unreg1 = registry.registerComposerControl(control1)
        const unreg2 = registry.registerComposerControl(control2)

        const controls = selectComposerControls(registry, 'context')
        expect(controls.map((c) => c.id)).toEqual(['custom-control-1', 'custom-control-2'])

        unreg2()
        expect(selectComposerControls(registry, 'context').map((c) => c.id)).toEqual([
            'custom-control-2',
        ])

        unreg1()
        expect(selectComposerControls(registry, 'context')).toHaveLength(0)
    })

    it('allows dynamic registration and execution of attachment providers', async () => {
        const registry = new RendererRegistry()

        const provider: AttachmentProvider = {
            id: 'mock-provider',
            order: 10,
            label: 'Mock Attachment',
            select: vi.fn(async () => [
                { id: 'att-1', name: 'test.txt', path: '/path/test.txt' },
            ]),
        }

        const unreg = registry.registerAttachmentProvider(provider)
        const providers = selectAttachmentProviders(registry)
        expect(providers).toHaveLength(1)
        expect(providers[0].id).toBe('mock-provider')

        const result = await providers[0].select?.({ sessionId: 'session-1' })
        expect(result).toEqual([{ id: 'att-1', name: 'test.txt', path: '/path/test.txt' }])

        unreg()
        expect(selectAttachmentProviders(registry)).toHaveLength(0)
    })

    it('executes submit preprocessors in order and pipelines payload transformations', async () => {
        const registry = new RendererRegistry()

        const prep1: ComposerSubmitPreprocessorContribution = {
            id: 'prep-trim',
            order: 10,
            preprocess: (payload) => ({
                ...payload,
                text: payload.text.trim(),
            }),
        }

        const prep2: ComposerSubmitPreprocessorContribution = {
            id: 'prep-prefix',
            order: 20,
            preprocess: (payload) => ({
                ...payload,
                text: `[processed] ${payload.text}`,
            }),
        }

        registry.registerSubmitPreprocessor(prep2)
        registry.registerSubmitPreprocessor(prep1)

        const result = await runSubmitPreprocessors({ text: '  my message  ' }, registry)
        expect(result.text).toBe('[processed] my message')
    })

    it('updates React hooks useComposerControls, useAttachmentProviders, and useSubmitPreprocessors reactively', () => {
        const registry = new RendererRegistry()
        const DummyComponent = () => null

        const { result: controlsHook } = renderHook(() =>
            useComposerControls('context', registry)
        )
        const { result: attachmentsHook } = renderHook(() =>
            useAttachmentProviders(registry)
        )
        const { result: preprocessorsHook } = renderHook(() =>
            useSubmitPreprocessors(registry)
        )

        expect(controlsHook.current).toHaveLength(0)
        expect(attachmentsHook.current).toHaveLength(0)
        expect(preprocessorsHook.current).toHaveLength(0)

        act(() => {
            registry.registerComposerControl({
                id: 'hook-control',
                placement: 'context',
                order: 10,
                component: DummyComponent,
            })
            registry.registerAttachmentProvider({
                id: 'hook-attachment',
                order: 10,
                label: 'Hook Attachment',
                select: async () => [],
            })
            registry.registerSubmitPreprocessor({
                id: 'hook-preprocessor',
                order: 10,
                preprocess: (p) => p,
            })
        })

        expect(controlsHook.current).toHaveLength(1)
        expect(controlsHook.current[0].id).toBe('hook-control')
        expect(attachmentsHook.current).toHaveLength(1)
        expect(attachmentsHook.current[0].id).toBe('hook-attachment')
        expect(preprocessorsHook.current).toHaveLength(1)
        expect(preprocessorsHook.current[0].id).toBe('hook-preprocessor')
    })
})
