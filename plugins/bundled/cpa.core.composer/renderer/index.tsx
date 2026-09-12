import { definePluginEntry } from '@cpa/plugin-sdk'
import type {
    ActionContribution,
    AttachmentProvider,
    ComposerControlContribution,
    ComposerSubmitPreprocessorContribution,
    PluginContext,
    SlotContribution,
} from '@cpa/plugin-api'
import { Composer } from './components/Composer.js'
import { ComposerContainer } from './components/ComposerContainer.js'
import { ModelSelect } from './components/ModelSelect.js'
import { ContextUsageRing } from './components/ContextUsageRing.js'
import {
    AttachControl,
    RequestApprovalControl,
} from './components/ComposerToolbarControls.js'
import { expandPromptTemplate } from './utils/promptTemplates.js'
import {
    executeCycleReasoningEffort,
    executeNextModel,
    executePreviousModel,
} from './utils/actions.js'

export {
    Composer,
    ComposerContainer,
    ModelSelect,
    ContextUsageRing,
    AttachControl,
    RequestApprovalControl,
}

export const composerRendererEntry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        // 1. Register Workspace Composer Slot
        context.register<SlotContribution>({
            kind: 'slot',
            id: 'composer-container',
            target: 'workspace.composer',
            value: {
                id: 'composer-container',
                pluginId: 'cpa.core.composer',
                order: 10,
                component: ComposerContainer,
            },
        })

        // 2. Register Composer Controls
        context.register<ComposerControlContribution>({
            kind: 'composer',
            id: 'composer-attach',
            target: 'control:toolbar-left',
            value: {
                id: 'composer-attach',
                placement: 'toolbar-left',
                order: 10,
                component: AttachControl,
            },
        })

        context.register<ComposerControlContribution>({
            kind: 'composer',
            id: 'request-approval',
            target: 'control:toolbar-left',
            value: {
                id: 'request-approval',
                placement: 'toolbar-left',
                order: 20,
                component: RequestApprovalControl,
            },
        })

        context.register<ComposerControlContribution>({
            kind: 'composer',
            id: 'context-usage-ring',
            target: 'control:toolbar-right',
            value: {
                id: 'context-usage-ring',
                placement: 'toolbar-right',
                order: 10,
                component: ContextUsageRing as any,
            },
        })

        context.register<ComposerControlContribution>({
            kind: 'composer',
            id: 'model-select',
            target: 'control:toolbar-right',
            value: {
                id: 'model-select',
                placement: 'toolbar-right',
                order: 20,
                component: ModelSelect as any,
            },
        })

        // 4. Register Attachment Providers
        context.register<AttachmentProvider>({
            kind: 'composer',
            id: 'files',
            target: 'attachment',
            value: {
                id: 'files',
                order: 10,
                label: 'Files & folders',
                labelKey: 'composer.attachMenu.filesAndFolders',
            },
        })

        // 5. Register Submit Preprocessors
        context.register<ComposerSubmitPreprocessorContribution>({
            kind: 'composer',
            id: 'prompt-preprocessor',
            target: 'submit-preprocessor',
            value: {
                id: 'prompt-preprocessor',
                order: 10,
                preprocess: (payload, ctx) => {
                    const text = payload.text || ''
                    const trimmed = text.trim()
                    if (
                        trimmed.startsWith('/') &&
                        !trimmed.startsWith('/compact') &&
                        !trimmed.startsWith('/skill:')
                    ) {
                        const prompts = (ctx as any)?.prompts || []
                        const expanded = expandPromptTemplate(trimmed, prompts)
                        return {
                            ...payload,
                            text: expanded,
                        }
                    }
                    return payload
                },
            },
        })

        context.register<ComposerSubmitPreprocessorContribution>({
            kind: 'composer',
            id: 'skill-preprocessor',
            target: 'submit-preprocessor',
            value: {
                id: 'skill-preprocessor',
                order: 20,
                preprocess: (payload, ctx) => {
                    const text = payload.text || ''
                    const dollarMatches = text.matchAll(/\$([a-zA-Z0-9_-]+)/g)
                    for (const match of dollarMatches) {
                        const skillName = match[1]
                        if (skillName && !/^\d+$/.test(skillName)) {
                            (ctx as any)?.services?.skillUsage?.recordUsage?.(skillName)
                        }
                    }
                    return payload
                },
            },
        })

        // 6. Register Actions and Shortcuts
        context.register<ActionContribution>({
            kind: 'action',
            id: 'cycle-reasoning-effort',
            value: {
                id: 'cycle-reasoning-effort',
                title: 'shortcuts.item.cycleReasoningEffort.title',
                description: 'shortcuts.item.cycleReasoningEffort.desc',
                defaultShortcuts: ['Shift+Tab'],
                handler: (actionCtx) => {
                    executeCycleReasoningEffort(actionCtx)
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'next-model',
            value: {
                id: 'next-model',
                title: 'shortcuts.item.nextModel.title',
                description: 'shortcuts.item.nextModel.desc',
                defaultShortcuts: ['Ctrl+P'],
                handler: (actionCtx) => {
                    executeNextModel(actionCtx)
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'previous-model',
            value: {
                id: 'previous-model',
                title: 'shortcuts.item.previousModel.title',
                description: 'shortcuts.item.previousModel.desc',
                defaultShortcuts: ['Ctrl+Shift+P'],
                handler: (actionCtx) => {
                    executePreviousModel(actionCtx)
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'open-model-selector',
            value: {
                id: 'open-model-selector',
                title: 'shortcuts.item.openModelSelector.title',
                description: 'shortcuts.item.openModelSelector.desc',
                defaultShortcuts: ['Ctrl+Shift+M'],
                handler: (actionCtx) => {
                    actionCtx.services.ui?.emitEvent?.('composer:toggle-model-selector')
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'open-folder',
            value: {
                id: 'open-folder',
                title: 'shortcuts.item.openFolder.title',
                description: 'shortcuts.item.openFolder.desc',
                defaultShortcuts: ['Meta+O'],
                handler: async (actionCtx) => {
                    actionCtx.services.ui?.emitEvent?.('composer:open-folder')
                    await actionCtx.services.projects?.selectDirectory?.()
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'compact',
            value: {
                id: 'compact',
                title: 'Compact',
                description: 'Compact context and summarize conversation history',
                placements: [{ surface: 'composer.slash', order: 10 }],
                handler: (actionCtx) => {
                    actionCtx.services.ui?.emitEvent?.('composer:slash-compact')
                },
            },
        })

        context.register<ActionContribution>({
            kind: 'action',
            id: 'stop-execution',
            value: {
                id: 'stop-execution',
                title: 'shortcuts.item.stopExecution.title',
                description: 'shortcuts.item.stopExecution.desc',
                defaultShortcuts: ['Escape'],
                handler: (actionCtx) => {
                    actionCtx.services.ui?.emitEvent?.('composer:stop')
                },
            },
        })
    },
})

export const entry = composerRendererEntry
export default composerRendererEntry
