import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { memoriesRendererEntry } from './index.js'
import type { HostServices, PluginContext } from '@cpa/plugin-api'
import { HostServicesProvider } from '@cpa/plugin-ui'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('@cpa/plugin-ui', async (importOriginal) => ({
    ...await importOriginal<typeof import('@cpa/plugin-ui')>(),
    useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }),
}))

describe('memoriesRendererEntry', () => {
    it('registers personalization section component wrapper and passes its capability client', async () => {
        let wrapperRegistration: any = null
        const invoke = vi.fn().mockResolvedValue(undefined)
        const show = vi.fn()
        const services = { notifications: { show } } as unknown as HostServices

        const mockContext: PluginContext = {
            manifest: {
                id: 'cpa.core.memories',
                name: 'Memories',
                version: '1.0.0',
                apiVersion: '1.0.0',
                description: 'Memories plugin',
                engines: { cpa: '>=1.0.0' },
            },
            runtime: 'renderer',
            capabilityClient: { invoke },
            registerComponentWrapper: (reg: any) => {
                wrapperRegistration = reg
            },
            getService: () => undefined,
        } as unknown as PluginContext

        memoriesRendererEntry.activate(mockContext)

        expect(wrapperRegistration).not.toBeNull()
        expect(wrapperRegistration.id).toBe('cpa.memories.personalization-wrapper')
        expect(wrapperRegistration.targetComponent).toBe('PersonalizationSection')

        const BaseComp = ({ children }: { children?: React.ReactNode }) => (
            <div>Base Personalization Content {children}</div>
        )
        const Wrapped = wrapperRegistration.wrapper(BaseComp)
        render(<HostServicesProvider services={services}><Wrapped /></HostServicesProvider>)
        expect(screen.getByText(/Base Personalization Content/)).toBeInTheDocument()
        expect(screen.getByText('Memory')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
        await waitFor(() => {
            expect(show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Local memory database cleared (legacy Markdown backups kept)', type: 'info' }))
        })
        expect(invoke).toHaveBeenCalledExactlyOnceWith('memories:clear', [])
    })
})
