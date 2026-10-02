import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { HostServicesProvider } from '@cpa/plugin-ui'
import { CodeModeSettings } from './settings'
import { ExecToolCard } from './ExecToolCard'

function services(mode = 'direct') {
    const snapshot = { toolMode: mode }
    return { settings: { getSnapshot: () => snapshot, get: async () => snapshot, update: vi.fn(async () => {}), subscribe: () => () => {} }, rendererContributions: { selectChatRenderer: vi.fn((value) => ({ id: 'ordinary-tool', pluginId: 'test-plugin', component: () => <span>{value.name} nested card</span> })) } } as any
}

describe('Code Mode settings and cards', () => {
    it.each(['direct', 'code', 'code-only'])('renders the %s mode with a custom combobox', async (mode) => {
        await i18n.changeLanguage('en')
        render(<HostServicesProvider services={services(mode)}><CodeModeSettings /></HostServicesProvider>)
        expect(screen.getByRole('combobox')).toBeInTheDocument()
        expect(document.querySelector('select')).toBeNull()
        const expected = { direct: 'Direct tools (default)', code: 'Tools and code', 'code-only': 'Code tools only' }[mode]
        expect(screen.getByRole('combobox')).toHaveTextContent(expected!)
        expect(screen.getByLabelText('Default exec yield')).toHaveValue(30000)
        expect(screen.getAllByText('ms').length).toBeGreaterThan(0)
    })
    it('persists tool lists on blur without swallowing separators', async () => {
        await i18n.changeLanguage('en')
        const host = services()
        render(<HostServicesProvider services={host}><CodeModeSettings /></HostServicesProvider>)
        await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument())
        const input = screen.getByLabelText('Excluded nested tool names (comma-separated)')
        fireEvent.change(input, { target: { value: 'read, bash' } })
        fireEvent.blur(input)
        expect(host.settings.update).toHaveBeenCalledWith({ excludedToolNames: ['read', 'bash'] })
    })
    it.each(['en', 'zh-CN'])('renders a yielded cell and folded reusable nested cards in %s', async (locale) => {
        await i18n.changeLanguage(locale)
        const host = services()
        render(<HostServicesProvider services={host}><ExecToolCard value={{ type: 'tool_call', id: 'parent', name: 'exec', args: { source: 'await tools.read({path:"a"})' }, result: 'Cell cell-1 yielded; use wait with cell_id to continue.' }} details={{ cellId: 'cell-1', status: 'yielded', nestedTools: [{ type: 'tool_call', id: 'nested', name: 'read', status: 'done', result: 'output' }] }} /></HostServicesProvider>)
        expect(screen.getByText(locale === 'en' ? 'Yielded' : '已让出')).toBeInTheDocument()
        expect(screen.getByText('await tools.read({path:"a"})')).toBeInTheDocument()
        expect(screen.getByText('read nested card')).toBeInTheDocument()
        expect(document.querySelector('details')).not.toHaveAttribute('open')
        expect(host.rendererContributions.selectChatRenderer).toHaveBeenCalled()
    })
    it('shows wait identity and termination intent', async () => {
        await i18n.changeLanguage('en')
        render(<HostServicesProvider services={services()}><ExecToolCard value={{ id: 'wait', name: 'wait', args: { cell_id: 'cell-2', terminate: true }, status: 'done', result: 'Cell cell-2 terminated.' }} /></HostServicesProvider>)
        expect(screen.getByText('Terminated')).toBeInTheDocument()
        expect(screen.getByText(/cell-2 Terminate requested/)).toBeInTheDocument()
    })
})
