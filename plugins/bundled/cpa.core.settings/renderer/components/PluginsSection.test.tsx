import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { createHostServices } from '@/application/services/createHostServices'
import {
    createRendererRuntimeHost,
    rendererPluginRuntime,
} from '@/plugins/platform/RendererPluginRuntimeHost'
import type { PluginEntryDefinition, PluginManifest } from '@cpa/plugin-api'
import { definePluginEntry } from '@cpa/plugin-sdk'
import { PluginsSection } from './PluginsSection.js'

function makeManifest(id: string, overrides: Partial<PluginManifest> = {}): PluginManifest {
    return {
        id,
        name: id,
        version: '1.0.0',
        apiVersion: '1.0.0',
        engines: { cpa: '>=1.0.0' },
        entries: { renderer: './renderer/index.tsx' },
        dependencies: {},
        capabilities: [],
        contributes: {},
        ...overrides,
    }
}

describe('PluginsSection', () => {
    beforeEach(async () => {
        await i18n.changeLanguage('en')
        createHostServices()
        await rendererPluginRuntime.activateAll()
    })

    afterEach(async () => {
        await rendererPluginRuntime.reset()
        vi.restoreAllMocks()
    })

    it('renders plugin state from the unified runtime without legacy labels', async () => {
        render(<PluginsSection />)

        expect(await screen.findByText(/Session & Project Manager/)).toBeInTheDocument()
        expect(screen.getAllByText('Active').length).toBeGreaterThan(0)
    })

    it('renders empty message when no plugins are registered', () => {
        const host = createRendererRuntimeHost({ bundledPackages: [] })
        render(<PluginsSection runtime={host} />)

        expect(screen.getByText('Installed Plugins')).toBeInTheDocument()
        expect(screen.getByText('No plugins installed')).toBeInTheDocument()
    })

    it('renders core plugin with core badge and no disable button', async () => {
        const host = createRendererRuntimeHost({ bundledPackages: [] })
        const manifest = makeManifest('cpa.core.test', {
            name: 'Core Test Plugin',
            description: 'Core functionality for testing',
            author: 'CPA Team',
            criticality: 'required',
        })
        const entry = definePluginEntry({
            runtime: 'renderer',
            activate: () => {},
        })

        await host.registerPlugin(manifest, entry)
        await host.activatePlugin('cpa.core.test')

        render(<PluginsSection runtime={host} />)

        expect(screen.getByText('Core Test Plugin')).toBeInTheDocument()
        expect(screen.getByText('v1.0.0')).toBeInTheDocument()
        expect(screen.getByText('Core functionality for testing')).toBeInTheDocument()
        expect(screen.getByText('By CPA Team')).toBeInTheDocument()
        expect(screen.getByText('Core')).toBeInTheDocument()
        expect(screen.getByText('Active')).toBeInTheDocument()
        expect(screen.getByText('Core plugin')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull()
    })

    it('renders external plugin with external badge and enables/disables it', async () => {
        const host = createRendererRuntimeHost({ bundledPackages: [] })
        const deactivateSpy = vi.fn()
        const activateSpy = vi.fn()

        const manifest = makeManifest('cpa.ext.formatter', {
            name: 'Code Formatter',
            version: '0.9.1',
            description: 'Formats code automatically',
            criticality: 'optional',
        })
        const entry = definePluginEntry({
            runtime: 'renderer',
            activate: activateSpy,
            deactivate: deactivateSpy,
        })

        await host.registerPlugin(manifest, entry)
        await host.activatePlugin('cpa.ext.formatter')

        render(<PluginsSection runtime={host} />)

        expect(screen.getByText('Code Formatter')).toBeInTheDocument()
        expect(screen.getByText('External')).toBeInTheDocument()
        expect(screen.getByText('Active')).toBeInTheDocument()

        const disableBtn = screen.getByRole('button', { name: 'Disable' })
        fireEvent.click(disableBtn)

        await waitFor(() => {
            expect(deactivateSpy).toHaveBeenCalledOnce()
            expect(host.isPluginActive('cpa.ext.formatter')).toBe(false)
            expect(screen.getByText('Inactive')).toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument()
        })

        const enableBtn = screen.getByRole('button', { name: 'Enable' })
        fireEvent.click(enableBtn)

        await waitFor(() => {
            expect(activateSpy).toHaveBeenCalledTimes(2) // 1 initial + 1 on enable
            expect(host.isPluginActive('cpa.ext.formatter')).toBe(true)
            expect(screen.getByText('Active')).toBeInTheDocument()
        })
    })

    it('renders error badge and error stack when plugin has failed', async () => {
        const host = createRendererRuntimeHost({ bundledPackages: [] })

        const manifest = makeManifest('cpa.ext.faulty', {
            name: 'Faulty Plugin',
            criticality: 'optional',
        })
        const entry = definePluginEntry({
            runtime: 'renderer',
            activate: () => {
                const err = new Error('Syntax error inside plugin bootstrap')
                err.stack = 'Error: Syntax error inside plugin bootstrap\n    at eval (custom.js:1:1)'
                throw err
            },
        })

        await host.registerPlugin(manifest, entry)
        try {
            await host.activatePlugin('cpa.ext.faulty')
        } catch {
            // Expected
        }

        render(<PluginsSection runtime={host} />)

        expect(screen.getByText('Faulty Plugin')).toBeInTheDocument()
        expect(screen.getByText('Error')).toBeInTheDocument()
        expect(screen.getByTestId('plugin-error-cpa.ext.faulty')).toBeInTheDocument()
        expect(screen.getByText(/Syntax error inside plugin bootstrap/)).toBeInTheDocument()
    })

    it('sorts core plugins before external plugins, and by priority and name', async () => {
        const extBManifest = makeManifest('cpa.ext.b', { name: 'Zeta External', activationPriority: 50, criticality: 'optional' })
        const extAManifest = makeManifest('cpa.ext.a', { name: 'Alpha External', activationPriority: 10, criticality: 'optional' })
        const coreBManifest = makeManifest('cpa.core.b', { name: 'Zeta Core', activationPriority: 80, criticality: 'required' })
        const coreAManifest = makeManifest('cpa.core.a', { name: 'Alpha Core', activationPriority: 20, criticality: 'required' })

        const dummyEntry = definePluginEntry({ runtime: 'renderer', activate: () => {} })

        const host = createRendererRuntimeHost({ bundledPackages: [] })
        await host.registerPlugin(extBManifest, dummyEntry)
        await host.registerPlugin(extAManifest, dummyEntry)
        await host.registerPlugin(coreBManifest, dummyEntry)
        await host.registerPlugin(coreAManifest, dummyEntry)

        render(<PluginsSection runtime={host} />)

        const rows = screen.getAllByTestId(/^plugin-row-/)
        const renderedIds = rows.map((r) => r.getAttribute('data-testid')?.replace('plugin-row-', ''))
        expect(renderedIds).toEqual(['cpa.core.a', 'cpa.core.b', 'cpa.ext.a', 'cpa.ext.b'])
    })

    it('handles install flow with exact semver and scope selection', async () => {
        const installSpy = vi.fn()
        const pluginManagementMock = {
            getPluginSummaries: () => [],
            subscribe: () => () => {},
            activatePlugin: vi.fn(),
            deactivatePlugin: vi.fn(),
            reloadPlugin: vi.fn(),
            installPlugin: installSpy,
            uninstallPlugin: vi.fn(),
            isPluginActive: () => false,
        }

        createHostServices({ pluginManagement: pluginManagementMock })
        render(<PluginsSection />)

        const input = screen.getByPlaceholderText(/npm package name or spec/i)
        expect(input).toBeInTheDocument()

        fireEvent.change(input, { target: { value: '@my-scope/new-plugin@1.2.0' } })

        const installBtn = screen.getByRole('button', { name: /install/i })
        fireEvent.click(installBtn)

        await waitFor(() => {
            expect(installSpy).toHaveBeenCalledWith(
                '@my-scope/new-plugin@1.2.0',
                expect.objectContaining({ scope: 'project' }),
            )
        })
    })

    it('handles uninstall flow for non-core external plugins', async () => {
        const uninstallSpy = vi.fn()
        const extManifest = makeManifest('cpa.ext.custom', {
            name: 'Custom Ext Plugin',
            criticality: 'optional',
        })
        const pluginManagementMock = {
            getPluginSummaries: () => [
                {
                    manifest: extManifest,
                    status: 'active' as const,
                    source: { kind: 'npm' as const, spec: 'npm:@scope/custom@1.0.0' },
                },
            ],
            subscribe: () => () => {},
            activatePlugin: vi.fn(),
            deactivatePlugin: vi.fn(),
            reloadPlugin: vi.fn(),
            installPlugin: vi.fn(),
            uninstallPlugin: uninstallSpy,
            isPluginActive: (id: string) => id === 'cpa.ext.custom',
        }

        createHostServices({ pluginManagement: pluginManagementMock })
        render(<PluginsSection />)

        expect(screen.getByText('Custom Ext Plugin')).toBeInTheDocument()
        const uninstallBtn = screen.getByRole('button', { name: /uninstall/i })
        fireEvent.click(uninstallBtn)

        await waitFor(() => {
            expect(uninstallSpy).toHaveBeenCalledWith('cpa.ext.custom')
        })
    })

    it('displays action error when activatePlugin throws and prevents duplicate concurrent clicks', async () => {
        let rejectActivate: (err: any) => void = () => {}
        const activateSpy = vi.fn().mockImplementation(
            () =>
                new Promise<void>((_, rej) => {
                    rejectActivate = rej
                }),
        )

        const extManifest = makeManifest('cpa.ext.test-action', {
            name: 'Action Test Plugin',
            criticality: 'optional',
        })
        const pluginManagementMock = {
            getPluginSummaries: () => [
                {
                    manifest: extManifest,
                    status: 'inactive' as const,
                },
            ],
            subscribe: () => () => {},
            activatePlugin: activateSpy,
            deactivatePlugin: vi.fn(),
            reloadPlugin: vi.fn(),
            installPlugin: vi.fn(),
            uninstallPlugin: vi.fn(),
            isPluginActive: () => false,
        }

        createHostServices({ pluginManagement: pluginManagementMock })
        render(<PluginsSection />)

        const enableBtn = screen.getByRole('button', { name: /enable/i })

        // Click enable
        fireEvent.click(enableBtn)
        expect(activateSpy).toHaveBeenCalledTimes(1)

        // Attempt second click while in-flight
        fireEvent.click(enableBtn)
        expect(activateSpy).toHaveBeenCalledTimes(1)

        // Reject the in-flight activation
        rejectActivate(new Error('Plugin enable failed: disk full'))

        // Wait for UI to show the error
        await waitFor(() => {
            expect(screen.getByTestId('plugin-error-cpa.ext.test-action')).toBeInTheDocument()
            expect(screen.getByText('Plugin enable failed: disk full')).toBeInTheDocument()
        })
    })

    it('does not render error banner for inactive/disabled plugins with catalog error', () => {
        const manifest = makeManifest('cpa.ext.disabled', { name: 'Disabled Plugin', criticality: 'optional' })
        const host = {
            subscribe: () => () => {},
            getPluginSummaries: () => [
                {
                    manifest,
                    status: 'inactive' as const,
                    generation: 1,
                    error: 'Plugin is disabled',
                    isCore: false,
                },
            ],
            activatePlugin: async () => {},
            deactivatePlugin: async () => {},
            reloadPlugin: async () => {},
            isPluginActive: () => false,
        }

        render(<PluginsSection runtime={host as any} />)

        expect(screen.getByText('Disabled Plugin')).toBeInTheDocument()
        expect(screen.getByText('Inactive')).toBeInTheDocument()
        expect(screen.queryByTestId('plugin-error-cpa.ext.disabled')).not.toBeInTheDocument()
    })
})

