import { useCallback, useSyncExternalStore } from 'react'
import type {
    AttachmentContext,
    AttachmentProvider,
    ComposerAttachment,
    ComposerControlContribution,
    ComposerControlProps,
    ComposerSubmitContext,
    ComposerSubmitPayload,
    ComposerSubmitPreprocessorContribution,
    SubmitPreprocessorContribution,
} from '@cpa/plugin-api'
import { rendererRegistry, RendererRegistry } from '../rendererRegistry'

export type {
    AttachmentContext,
    AttachmentProvider,
    ComposerAttachment,
    ComposerControlContribution,
    ComposerControlProps,
    ComposerSubmitContext,
    ComposerSubmitPayload,
    ComposerSubmitPreprocessorContribution,
    SubmitPreprocessorContribution,
}

/**
 * Returns registered composer controls, optionally filtered by placement ('context' | 'toolbar-left' | 'toolbar-right').
 */
export function selectComposerControls(
    registry: RendererRegistry = rendererRegistry,
    placement?: 'context' | 'toolbar-left' | 'toolbar-right'
): readonly ComposerControlContribution[] {
    return registry.getComposerControls(placement)
}

/**
 * Returns all registered attachment providers sorted by order.
 */
export function selectAttachmentProviders(
    registry: RendererRegistry = rendererRegistry
): readonly AttachmentProvider[] {
    return registry.getAttachmentProviders()
}

/**
 * Returns all registered submit preprocessors sorted by order.
 */
export function selectSubmitPreprocessors(
    registry: RendererRegistry = rendererRegistry
): readonly ComposerSubmitPreprocessorContribution[] {
    return registry.getSubmitPreprocessors()
}

/**
 * Runs all registered submit preprocessors sequentially in order, piping payload transformations.
 * Executes synchronously if all preprocessors return synchronous results, or returns a Promise if any are async.
 */
export function runSubmitPreprocessors(
    payload: ComposerSubmitPayload,
    registry: RendererRegistry = rendererRegistry,
    context?: ComposerSubmitContext
): Promise<ComposerSubmitPayload> | ComposerSubmitPayload {
    const preprocessors = selectSubmitPreprocessors(registry)
    let currentPayload: ComposerSubmitPayload = { ...payload }

    for (let i = 0; i < preprocessors.length; i++) {
        const preprocessor = preprocessors[i]!
        try {
            const next = preprocessor.preprocess(currentPayload, context)
            if (next && typeof (next as any).then === 'function') {
                return (async () => {
                    let payloadAccum: ComposerSubmitPayload = currentPayload
                    try {
                        const resolved = await next
                        if (resolved && typeof resolved === 'object') {
                            payloadAccum = resolved
                        }
                    } catch (err) {
                        console.error(`[runSubmitPreprocessors] Error in preprocessor "${preprocessor.id}":`, err)
                    }

                    for (let j = i + 1; j < preprocessors.length; j++) {
                        const nextP = preprocessors[j]!
                        try {
                            const res = await nextP.preprocess(payloadAccum, context)
                            if (res && typeof res === 'object') {
                                payloadAccum = res
                            }
                        } catch (err) {
                            console.error(`[runSubmitPreprocessors] Error in preprocessor "${nextP.id}":`, err)
                        }
                    }
                    return payloadAccum
                })()
            }
            if (next && typeof next === 'object') {
                currentPayload = next as ComposerSubmitPayload
            }
        } catch (error) {
            console.error(`[runSubmitPreprocessors] Error in preprocessor "${preprocessor.id}":`, error)
        }
    }

    return currentPayload
}

/**
 * React hook subscribing to composer control contributions.
 */
export function useComposerControls(
    placement?: 'context' | 'toolbar-left' | 'toolbar-right',
    registry: RendererRegistry = rendererRegistry
): readonly ComposerControlContribution[] {
    const subscribe = useCallback(
        (listener: () => void) => registry.subscribe('composer', listener),
        [registry]
    )

    const getSnapshot = useCallback(
        () => registry.getComposerControls(placement),
        [registry, placement]
    )

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * React hook subscribing to attachment providers.
 */
export function useAttachmentProviders(
    registry: RendererRegistry = rendererRegistry
): readonly AttachmentProvider[] {
    const subscribe = useCallback(
        (listener: () => void) => registry.subscribe('composer', listener),
        [registry]
    )

    const getSnapshot = useCallback(
        () => registry.getAttachmentProviders(),
        [registry]
    )

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * React hook subscribing to submit preprocessors.
 */
export function useSubmitPreprocessors(
    registry: RendererRegistry = rendererRegistry
): readonly ComposerSubmitPreprocessorContribution[] {
    const subscribe = useCallback(
        (listener: () => void) => registry.subscribe('composer', listener),
        [registry]
    )

    const getSnapshot = useCallback(
        () => registry.getSubmitPreprocessors(),
        [registry]
    )

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
