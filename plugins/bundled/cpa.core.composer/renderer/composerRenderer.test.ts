import { describe, expect, it, vi } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import type {
    ActionContribution,
    AttachmentProvider,
    ComposerControlContribution,
    ComposerSubmitPreprocessorContribution,
    SlotContribution,
} from '@cpa/plugin-api'
import { composerRendererEntry } from './index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const pluginDir = path.resolve(__dirname, '..')
const manifestPath = path.join(pluginDir, 'manifest.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

describe('cpa.core.composer Renderer Entry', () => {
    it('has an authoritative manifest without legacy definition', () => {
        expect(fs.existsSync(manifestPath)).toBe(true)
        expect(manifest.id).toBe('cpa.core.composer')
        expect(manifest.version).toBe('1.0.0')
        expect(manifest.apiVersion).toBe('1.0.0')
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.main).toBeUndefined()
        expect(manifest.entries.agent).toBeUndefined()
        expect(manifest.capabilities).toEqual(
            expect.arrayContaining([
                'settings.*',
                'models.*',
                'agent.*',
                'sessions.*',
                'projects.*',
                'skills.*',
                'filesystem.*',
                'ui.*',
            ]),
        )
        expect(manifest.contributes.slot).toEqual(['composer-container'])
        expect(manifest.contributes.composer).toEqual(
            expect.arrayContaining([
                'composer-attach',
                'request-approval',
                'context-usage-ring',
                'model-select',
                'files',
                'goal',
                'plan-mode',
                'prompt-preprocessor',
                'skill-preprocessor',
            ]),
        )
        expect(manifest.contributes.action).toEqual(
            expect.arrayContaining([
                'cycle-reasoning-effort',
                'next-model',
                'previous-model',
                'open-model-selector',
                'open-folder',
                'compact',
            ]),
        )
    })

    it('exports a valid renderer entry created with definePluginEntry', () => {
        expect(composerRendererEntry).toBeDefined()
        expect(composerRendererEntry.runtime).toBe('renderer')
        expect(typeof composerRendererEntry.activate).toBe('function')
        expect((composerRendererEntry as any).manifest).toBeUndefined()
    })

    it('activates and registers all slot, composer, and action contributions', async () => {
        const harness = createPluginTestHarness(composerRendererEntry, {
            manifest,
        })

        await harness.activate()

        const slots = harness.getRegistered<SlotContribution>('slot')
        expect(slots.map((s) => s.id)).toEqual(['composer-container'])

        const composerContribs = harness.getRegistered('composer')
        expect(composerContribs.map((c) => c.id)).toEqual(
            expect.arrayContaining([
                'composer-attach',
                'request-approval',
                'context-usage-ring',
                'model-select',
                'files',
                'goal',
                'plan-mode',
                'prompt-preprocessor',
                'skill-preprocessor',
            ]),
        )

        const actions = harness.getRegistered<ActionContribution>('action')
        expect(actions.map((a) => a.id)).toEqual(
            expect.arrayContaining([
                'cycle-reasoning-effort',
                'next-model',
                'previous-model',
                'open-model-selector',
                'open-folder',
                'compact',
                'stop-execution',
            ]),
        )

        const stopAction = actions.find((a) => a.id === 'stop-execution')
        expect(stopAction).toBeDefined()
        expect(stopAction?.value.defaultShortcuts).toEqual(['Escape'])
        const emitSpy = vi.fn()
        stopAction?.value.handler?.({
            services: { ui: { emitEvent: emitSpy } },
        } as any)
        expect(emitSpy).toHaveBeenCalledWith('composer:stop')
    })

    it('cleans up contributions cleanly when deactivated', async () => {
        const harness = createPluginTestHarness(composerRendererEntry, {
            manifest,
        })

        await harness.activate()
        expect(harness.getRegistered('slot').length).toBeGreaterThan(0)
        expect(harness.getRegistered('composer').length).toBeGreaterThan(0)
        expect(harness.getRegistered('action').length).toBeGreaterThan(0)

        await harness.deactivate()
        expect(harness.getRegistered('slot')).toHaveLength(0)
        expect(harness.getRegistered('composer')).toHaveLength(0)
        expect(harness.getRegistered('action')).toHaveLength(0)
    })

    it('processes submit preprocessors correctly through registered pipeline', async () => {
        const harness = createPluginTestHarness(composerRendererEntry, {
            manifest,
        })

        await harness.activate()

        const preprocessors = harness.getRegistered<ComposerSubmitPreprocessorContribution>('composer')
        const promptPrep = preprocessors.find((p) => p.id === 'prompt-preprocessor')
        expect(promptPrep).toBeDefined()

        const expanded = (promptPrep!.value as any).preprocess(
            { text: '/test-cmd arg1' },
            {
                prompts: [
                    {
                        name: 'test-cmd',
                        description: 'test',
                        content: 'Expanded with $1',
                        filePath: '/p/test.md',
                    },
                ],
            } as any,
        )
        expect((expanded as any).text).toBe('Expanded with arg1')
    })
})
