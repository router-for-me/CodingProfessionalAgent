import { describe, expect, it } from 'vitest'
import { fileChangesRendererEntry } from './index.js'
import type { PluginContext } from '@cpa/plugin-api'
import { render, screen } from '@testing-library/react'
import { FileChangesToolCard } from './components/FileChangesToolCard.js'

describe('fileChangesRendererEntry', () => {
    it('registers chat renderer with matcher and component', () => {
        let chatRendererRegistration: any = null

        const mockContext: PluginContext = {
            manifest: {
                id: 'cpa.core.file-changes',
                name: 'File Changes Tracker',
                version: '1.0.0',
                apiVersion: '1.0.0',
                description: 'File changes plugin',
                engines: { cpa: '>=1.0.0' },
            },
            runtime: 'renderer',
            registerChatRenderer: (reg: any) => {
                chatRendererRegistration = reg
            },
            getService: () => undefined,
        } as unknown as PluginContext

        fileChangesRendererEntry.activate(mockContext)

        expect(chatRendererRegistration).not.toBeNull()
        expect(chatRendererRegistration.id).toBe('file-changes-tool-card')
        expect(chatRendererRegistration.priority).toBe(50)

        // Matching logic tests
        expect(chatRendererRegistration.matches({ type: 'tool_call', name: 'file_changes' })).toBe(true)
        expect(chatRendererRegistration.matches({ type: 'tool_call', name: 'track_file_changes' })).toBe(true)
        expect(chatRendererRegistration.matches({ type: 'tool_call', name: 'fileChanges' })).toBe(true)
        expect(chatRendererRegistration.matches({ type: 'tool_call', name: 'other_tool' })).toBe(false)
        expect(chatRendererRegistration.matches({ type: 'text' })).toBe(false)
    })

    it('renders FileChangesToolCard with summary and file diff counts', () => {
        const part = {
            type: 'tool_call',
            name: 'file_changes',
            result: {
                totalAdditions: 15,
                totalDeletions: 3,
                files: [
                    { path: 'src/main.ts', additions: 10, deletions: 2 },
                    { path: 'src/utils.ts', additions: 5, deletions: 1 },
                ],
            },
        }

        render(<FileChangesToolCard part={part} />)

        expect(screen.getByText('src/main.ts')).toBeInTheDocument()
        expect(screen.getByText('src/utils.ts')).toBeInTheDocument()
        expect(screen.getByText('+15')).toBeInTheDocument()
        expect(screen.getByText('-3')).toBeInTheDocument()
        expect(screen.getByText(/2 files changed/i)).toBeInTheDocument()
    })
})
