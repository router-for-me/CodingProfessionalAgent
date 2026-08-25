import React from 'react'
import { describe, expect, it } from 'vitest'
import { memoriesRendererEntry } from './index.js'
import type { PluginContext } from '@cpa/plugin-api'
import { render, screen } from '@testing-library/react'

describe('memoriesRendererEntry', () => {
    it('registers personalization section component wrapper', () => {
        let wrapperRegistration: any = null

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
        render(<Wrapped />)
        expect(screen.getByText(/Base Personalization Content/)).toBeInTheDocument()
        expect(screen.getByText('Memory')).toBeInTheDocument()
    })
})
