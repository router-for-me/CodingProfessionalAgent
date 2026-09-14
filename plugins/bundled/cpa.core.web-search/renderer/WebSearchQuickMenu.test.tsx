import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ModelCatalogService, PluginCapabilityClient } from '@cpa/plugin-api'
import { WebSearchQuickMenu } from './WebSearchQuickMenu.js'
import { SETTINGS_KEY } from '../shared/types.js'

vi.mock('@cpa/plugin-ui', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@cpa/plugin-ui')>()
    return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

function setup() {
    const client: PluginCapabilityClient = {
        has: () => true,
        subscribe: () => () => {},
        invoke: vi.fn(async (method) => method === 'kvstore:get'
            ? { enabled: false, modelId: 'search-B' }
            : undefined) as PluginCapabilityClient['invoke'],
    }
    const models = [
        { id: 'search-B', label: 'Search B', cpaCapabilities: { webSearch: true } },
        { id: 'ordinary-A', label: 'Ordinary A' },
    ]
    const catalog: ModelCatalogService = {
        getStatus: () => 'ready',
        getModels: () => models,
    }
    return { client, catalog }
}

describe('WebSearchQuickMenu', () => {
    it('edits the same global settings key and only offers search-capable models', async () => {
        const { client, catalog } = setup()
        const { container } = render(<WebSearchQuickMenu client={client} catalog={catalog} onBack={() => {}} onClose={() => {}} />)
        const toggle = screen.getByRole('switch', { name: 'webSearch.quick.globalToggle' })
        await waitFor(() => expect(toggle).not.toBeDisabled())
        expect(container.querySelector('select')).toBeNull()

        fireEvent.click(toggle)
        await waitFor(() => expect(client.invoke).toHaveBeenCalledWith('kvstore:set', [SETTINGS_KEY, { enabled: true, modelId: 'search-B' }]))

        fireEvent.click(screen.getByRole('combobox'))
        expect(screen.getByRole('option', { name: 'Search B' })).toBeInTheDocument()
        expect(screen.queryByRole('option', { name: 'Ordinary A' })).not.toBeInTheDocument()
    })
})
