import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ModelCatalogService, PluginCapabilityClient } from '@cpa/plugin-api'
import { SearchSettings } from './SearchSettings.js'
import { SETTINGS_KEY } from '../shared/types.js'

vi.mock('@cpa/plugin-ui', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@cpa/plugin-ui')>()
    return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

function setup(value: unknown = { enabled: false, modelId: 'search-B' }, status = 'ready') {
    const models = [{ id: 'search-B', label: 'Search B', cpaCapabilities: { webSearch: true } }, { id: 'ordinary-A', label: 'Ordinary A' }]
    const client: PluginCapabilityClient = { has: () => true, subscribe: () => () => {}, invoke: vi.fn(async (method) => method === 'kvstore:get' ? value : undefined) as PluginCapabilityClient['invoke'] }
    const catalog: ModelCatalogService = { getModels: () => models, getStatus: () => status as 'ready' }
    return { client, catalog }
}

describe('Web Search settings', () => {
    it('loads only plugin settings and persists through central storage capability', async () => {
        const { client, catalog } = setup()
        render(<SearchSettings client={client} catalog={catalog} />)
        const checkbox = screen.getByRole('checkbox')
        await waitFor(() => expect(checkbox).not.toBeDisabled())
        fireEvent.click(checkbox)
        await waitFor(() => expect(checkbox).toBeChecked())
        expect(client.invoke).toHaveBeenCalledWith('kvstore:get', [SETTINGS_KEY])
        expect(client.invoke).toHaveBeenCalledWith('kvstore:set', [SETTINGS_KEY, { enabled: true, modelId: 'search-B' }])
        expect(client.invoke).toHaveBeenCalledWith('kvstore:save', [])
    })
    it('uses a custom combobox and lists only explicitly capable models', async () => {
        const { client, catalog } = setup()
        const { container } = render(<SearchSettings client={client} catalog={catalog} />)
        const combobox = screen.getByRole('combobox')
        await waitFor(() => expect(combobox).not.toBeDisabled())
        expect(container.querySelector('select')).toBeNull()
        fireEvent.click(combobox)
        expect(screen.getByRole('option', { name: 'Search B' })).toBeInTheDocument()
        expect(screen.queryByRole('option', { name: 'Ordinary A' })).not.toBeInTheDocument()
    })
    it('does not offer old candidates while a connection catalog is loading', async () => {
        const { client, catalog } = setup({ enabled: true, modelId: 'search-B' }, 'loading')
        render(<SearchSettings client={client} catalog={catalog} />)
        await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeDisabled())
        expect(screen.getByRole('combobox')).toBeDisabled()
        expect(screen.getByRole('status')).toHaveTextContent('webSearch.noModels')
    })
    it('surfaces save failures without arbitrary upstream error details', async () => {
        const { client, catalog } = setup()
        vi.mocked(client.invoke).mockImplementation(async (method) => {
            if (method === 'kvstore:get') return { enabled: false, modelId: '' } as never
            throw new Error('private-key')
        })
        render(<SearchSettings client={client} catalog={catalog} />)
        await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeDisabled())
        fireEvent.click(screen.getByRole('checkbox'))
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('webSearch.settingsError'))
        expect(screen.getByRole('checkbox')).not.toBeChecked()
        expect(screen.queryByText('private-key')).toBeNull()
    })
})
