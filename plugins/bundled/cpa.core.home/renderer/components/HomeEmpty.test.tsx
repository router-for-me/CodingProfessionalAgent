import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { HostServicesProvider } from '@cpa/plugin-ui'
import { HomeEmpty } from './HomeEmpty.js'

describe('HomeEmpty component', () => {
    it('renders title and quick action cards', () => {
        render(<HomeEmpty />)

        expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
        expect(screen.getByRole('list')).toBeInTheDocument()
        const cards = screen.getAllByRole('listitem')
        expect(cards).toHaveLength(4)
    })

    it('triggers onSelect when a quick action card is clicked', () => {
        const onSelect = vi.fn()
        render(<HomeEmpty onSelect={onSelect} />)

        const cards = screen.getAllByRole('listitem')
        fireEvent.click(cards[0]!)
        expect(onSelect).toHaveBeenCalledWith('explore')

        fireEvent.click(cards[1]!)
        expect(onSelect).toHaveBeenCalledWith('build')
    })

    it('calls setCurrentSessionId(null) on mount via host services', () => {
        const setCurrentSessionId = vi.fn()
        const mockServices: any = {
            sessions: {
                setCurrentSessionId,
            },
            ui: {
                getPendingSessionContext: () => ({ projectId: null, branch: null }),
            },
        }

        render(
            <HostServicesProvider services={mockServices}>
                <HomeEmpty />
            </HostServicesProvider>,
        )

        expect(setCurrentSessionId).toHaveBeenCalledWith(null)
    })

    it('creates session and navigates when clicking card with session create service', async () => {
        const createSession = vi.fn().mockResolvedValue('sess-created-1')
        const navigate = vi.fn().mockResolvedValue(undefined)
        const mockServices: any = {
            sessions: {
                setCurrentSessionId: vi.fn(),
                create: createSession,
            },
            ui: {
                getPendingSessionContext: () => ({
                    projectId: 'proj-1',
                    branch: 'main',
                    workLocation: 'local',
                    environmentId: null,
                }),
            },
            navigation: {
                navigate,
            },
        }

        render(
            <HostServicesProvider services={mockServices}>
                <HomeEmpty />
            </HostServicesProvider>,
        )

        const cards = screen.getAllByRole('listitem')
        fireEvent.click(cards[0]!)

        await waitFor(() => {
            expect(createSession).toHaveBeenCalledWith({
                projectId: 'proj-1',
                branch: 'main',
                workLocation: 'local',
                environmentId: null,
            })
            expect(navigate).toHaveBeenCalledWith('/chat/sess-created-1')
        })
    })

    it('sends prompt and navigates when clicking card with chatMessages service', async () => {
        const send = vi.fn().mockResolvedValue('sess-agent-1')
        const navigate = vi.fn().mockResolvedValue(undefined)
        const mockServices: any = {
            sessions: {
                setCurrentSessionId: vi.fn(),
            },
            chatMessages: {
                send,
            },
            ui: {
                getPendingSessionContext: () => ({
                    projectId: 'proj-2',
                    branch: 'feature',
                    workLocation: 'worktree',
                    environmentId: null,
                }),
            },
            navigation: {
                navigate,
            },
        }

        render(
            <HostServicesProvider services={mockServices}>
                <HomeEmpty />
            </HostServicesProvider>,
        )

        const cards = screen.getAllByRole('listitem')
        fireEvent.click(cards[2]!) // review

        await waitFor(() => {
            expect(send).toHaveBeenCalledWith(
                expect.objectContaining({
                    projectId: 'proj-2',
                    branch: 'feature',
                    workLocation: 'worktree',
                }),
            )
            expect(navigate).toHaveBeenCalledWith('/chat/sess-agent-1')
        })
    })

    it('sends prompt and navigates when clicking card with agentRun service', async () => {
        const send = vi.fn().mockResolvedValue('sess-agent-2')
        const navigate = vi.fn().mockResolvedValue(undefined)
        const mockServices: any = {
            sessions: {
                setCurrentSessionId: vi.fn(),
            },
            agentRun: {
                send,
                getRunState: () => ({ isStreaming: false, activeRunId: null }),
            },
            ui: {
                getPendingSessionContext: () => ({
                    projectId: 'proj-3',
                    branch: 'main',
                    workLocation: 'local',
                    environmentId: null,
                }),
            },
            navigation: {
                navigate,
            },
        }

        render(
            <HostServicesProvider services={mockServices}>
                <HomeEmpty />
            </HostServicesProvider>,
        )

        const cards = screen.getAllByRole('listitem')
        fireEvent.click(cards[0]!) // explore

        await waitFor(() => {
            expect(send).toHaveBeenCalledWith(
                expect.objectContaining({
                    projectId: 'proj-3',
                    branch: 'main',
                    workLocation: 'local',
                }),
            )
            expect(navigate).toHaveBeenCalledWith('/chat/sess-agent-2')
        })
    })

    it('renders gracefully in web mode without services', () => {
        render(
            <HostServicesProvider services={null}>
                <HomeEmpty />
            </HostServicesProvider>,
        )

        expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
    })

    it('animates rolling on logo click and settles back upright', () => {
        let rafCallback: FrameRequestCallback | null = null
        let currentTime = 1000
        vi.spyOn(performance, 'now').mockImplementation(() => currentTime)
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
            rafCallback = cb
            return 1
        })
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
            rafCallback = null
        })

        const { container } = render(<HomeEmpty />)
        const logoButton = screen.getByRole('button', { name: 'Logo' })
        expect(logoButton).toBeInTheDocument()

        const svg = container.querySelector('svg')
        expect(svg).toBeInTheDocument()
        expect(svg?.style.transform).toBe('')

        // First click triggers rotation
        fireEvent.click(logoButton)
        expect(rafCallback).not.toBeNull()

        // Step a frame
        currentTime += 16
        rafCallback!(currentTime)
        expect(svg?.style.transform).toMatch(/rotate\(.+deg\)/)

        // Second click adds another turn
        fireEvent.click(logoButton)

        // Step through frames until animation settles back to upright
        for (let i = 0; i < 500 && rafCallback; i++) {
            currentTime += 16
            const cb: FrameRequestCallback = rafCallback
            rafCallback = null
            cb(currentTime)
        }

        expect(svg?.style.transform).toBe('')
    })

    it('statically enforces zero window.electronBridge access across cpa.core.home', () => {
        const homePluginDir = path.resolve(__dirname, '../../')
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

        const files = scanFiles(homePluginDir)
        for (const file of files) {
            if (!file.endsWith('.test.ts') && !file.endsWith('.test.tsx')) {
                const content = fs.readFileSync(file, 'utf8')
                expect(content, `File ${file} should not access native bridge`).not.toContain('window.electronBridge')
            }
        }
    })
})
