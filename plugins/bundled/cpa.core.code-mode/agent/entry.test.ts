import { describe, expect, it, vi } from 'vitest'
import { SettingsServiceToken, type AppSettings, type PluginContext, type ToolFactoryContribution } from '@cpa/plugin-api'
import { entry } from './index'

describe('Code Mode agent tool factories', () => {
    it('reads settings from the plugin service when the tool factory context has none', async () => {
        const snapshot = { toolMode: 'code' } as AppSettings
        const settings = { get: async () => snapshot, getSnapshot: () => snapshot, subscribe: () => () => {} }
        const registered: ToolFactoryContribution[] = []
        const context = {
            generation: 1,
            capabilityClient: { has: () => true, invoke: vi.fn(async () => undefined), subscribe: () => () => {} },
            register(contribution: { value: ToolFactoryContribution }) {
                registered.push(contribution.value)
            },
            getService(token: { id?: string } | string) {
                const id = typeof token === 'string' ? token : token.id
                if (id === SettingsServiceToken.id) return settings
                throw new Error(`Service "${id}" not found`)
            },
        } as unknown as PluginContext

        await entry.activate(context)
        const exec = registered.find((factory) => factory.id === 'exec')
        const tool = await exec?.create({ platform: 'darwin', services: {} as never })
        expect(tool?.name).toBe('exec')
        await entry.deactivate?.(context)
    })
})
