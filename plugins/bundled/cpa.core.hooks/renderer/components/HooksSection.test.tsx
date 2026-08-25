import i18n from '@/i18n'
import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setDefaultHostServices } from '@cpa/plugin-ui'
import { useHooksStore } from '../hooksStore.js'
import { HooksSection } from './HooksSection.js'
import type { HookMetadata } from '@cpa/plugin-api'

describe('HooksSection', () => {
    beforeEach(async () => {
        await i18n.changeLanguage('en')
        setDefaultHostServices({
            projects: {
                getSnapshot: () => [
                    {
                        id: 'p1',
                        name: 'CLIProxyAPIHome',
                        path: '/path/to/CLIProxyAPIHome',
                        paths: ['/path/to/CLIProxyAPIHome'],
                        pinned: false,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    },
                ],
                subscribe: () => () => {},
            },
            sessions: {
                getSnapshot: () => [],
                getCurrentSessionId: () => null,
                subscribe: () => () => {},
            },
            hooks: {
                load: async () => ({
                    userHooks: [],
                    projectHooks: [],
                }),
                save: async () => {},
            },
        } as any)

        const mockHook: HookMetadata = {
            key: 'user:pre_tool_use:0:0',
            eventName: 'PreToolUse',
            matcher: 'bash',
            timeoutSec: 30,
            statusMessage: 'Validating bash command',
            additionalContextLimit: 2500,
            sourcePath: '~/.coding-professional-agent/hooks.json',
            source: 'user',
            pluginId: null,
            displayOrder: 100,
            enabled: true,
            isManaged: false,
            currentHash: 'abc12345',
            trustStatus: 'trusted',
            handler: {
                type: 'command',
                command: 'python3 check.py',
                timeout: 30,
                async: false,
                statusMessage: 'Validating bash command',
            },
        }

        useHooksStore.setState({
            loading: false,
            userHooks: [mockHook],
            projectConfigs: {
                '/path/to/CLIProxyAPIHome': {
                    file: { hooks: {}, state: {} },
                    path: '/path/to/CLIProxyAPIHome/.cpa/hooks.json',
                    hooks: [],
                },
            },
            selectedSource: 'root',
            learnMoreOpen: false,
            editorOpen: false,
            editingHook: null,
        })
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('renders root view matching screenshot elements', () => {
        render(<HooksSection />)

        // Title and Subtitle
        expect(screen.getByText('Hooks')).toBeInTheDocument()
        expect(screen.getByText(/Manage lifecycle hooks through configuration and enabled plugins/i)).toBeInTheDocument()
        expect(screen.getByText('Learn more')).toBeInTheDocument()

        // Section 1: From configuration
        expect(screen.getByText('From configuration')).toBeInTheDocument()
        expect(screen.getByText('User configuration')).toBeInTheDocument()
        expect(screen.getByText('1 hooks')).toBeInTheDocument()

        // Section 2: From project config file
        expect(screen.getByText('From project configuration')).toBeInTheDocument()
        expect(screen.getByText('CLIProxyAPIHome')).toBeInTheDocument()
        expect(screen.getByText('0 hooks')).toBeInTheDocument()
    })

    it('does not render project config section when no project has hooks.json', () => {
        useHooksStore.setState({ projectConfigs: {} })
        render(<HooksSection />)

        expect(screen.getByText('User configuration')).toBeInTheDocument()
        expect(screen.queryByText('From project configuration')).toBeNull()
    })

    it('opens learn more modal when clicking learn more link', () => {
        render(<HooksSection />)

        const link = screen.getByText('Learn more')
        fireEvent.click(link)

        expect(screen.getByText('Lifecycle Hooks Guide')).toBeInTheDocument()
        expect(screen.getByText(/what are lifecycle hooks\?/i)).toBeInTheDocument()
        expect(screen.getByText('PreToolUse')).toBeInTheDocument()
        expect(screen.getByText('PostToolUse')).toBeInTheDocument()
    })

    it('navigates to user hooks detail view when clicking user config row', () => {
        render(<HooksSection />)

        const userRow = screen.getByText('User configuration').closest('div[class*="cursor-pointer"]')
        expect(userRow).toBeTruthy()
        fireEvent.click(userRow!)

        expect(screen.getByText('Back')).toBeInTheDocument()
        expect(screen.getByTitle('Add Hook')).toBeInTheDocument()
        expect(screen.getByText('PreToolUse')).toBeInTheDocument()
        expect(screen.getByText('python3 check.py')).toBeInTheDocument()
    })
})
