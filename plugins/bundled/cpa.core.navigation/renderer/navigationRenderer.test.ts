import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import type { ActionContribution } from '@cpa/plugin-api'
import { navigationRendererEntry } from './index.js'
import manifest from '../manifest.json' with { type: 'json' }

describe('cpa.core.navigation renderer entry', () => {
    it('activates and registers navigation actions', async () => {
        const mockUiService = {
            toggleSidebar: vi.fn(),
            closeSettings: vi.fn(),
        }

        const harness = createPluginTestHarness(navigationRendererEntry, {
            manifest,
            services: {
                ui: mockUiService,
            },
        })

        await harness.activate()

        // 1. Actions
        const actions = harness.getRegistered<ActionContribution>('action')
        expect(actions.map((a) => a.id)).toEqual([
            'toggle-sidebar',
            'focus-main-chat-input',
            'navigate-back',
            'navigate-forward',
        ])

        // Test toggle-sidebar action handler
        const toggleSidebarAction = actions.find((a) => a.id === 'toggle-sidebar')
        toggleSidebarAction?.value.handler?.({ services: { ui: mockUiService } } as any)
        expect(mockUiService.toggleSidebar).toHaveBeenCalled()

        // Test focus-main-chat-input action handler
        const focusInputAction = actions.find((a) => a.id === 'focus-main-chat-input')
        focusInputAction?.value.handler?.({ services: { ui: mockUiService } } as any)
        expect(mockUiService.closeSettings).toHaveBeenCalled()

        // Test navigate-back and forward handlers
        const navBackAction = actions.find((a) => a.id === 'navigate-back')
        expect(() => navBackAction?.value.handler?.()).not.toThrow()

        const navForwardAction = actions.find((a) => a.id === 'navigate-forward')
        expect(() => navForwardAction?.value.handler?.()).not.toThrow()

        // 2. Deactivate and verify complete cleanup
        await harness.deactivate()
        expect(harness.registrations).toHaveLength(0)
    })

    it('statically enforces zero window.electronBridge access across cpa.core.navigation', () => {
        const navPluginDir = path.resolve(__dirname, '../../')
        const scanFiles = (dir: string): string[] => {
            const results: string[] = []
            for (const file of fs.readdirSync(dir)) {
                const fullPath = path.join(dir, file)
                if (fs.statSync(fullPath).isDirectory()) {
                    results.push(...scanFiles(fullPath))
                } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
                    results.push(fullPath)
                }
            }
            return results
        }

        const files = scanFiles(navPluginDir)
        for (const file of files) {
            if (!file.endsWith('.test.ts') && !file.endsWith('.test.tsx')) {
                const content = fs.readFileSync(file, 'utf8')
                expect(content, `File ${file} should not access native bridge`).not.toContain('window.electronBridge')
            }
        }
    })
})
