import i18n from '@/i18n'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { HostServicesProvider } from '@cpa/plugin-ui'
import { WorktreesSection, DEFAULT_WORKTREE_SETTINGS } from './WorktreesSection.js'

describe('WorktreesSection', () => {
    let mockSettingsState: any
    let mockServices: any
    let settingsListeners: Array<(s: any) => void>

    beforeEach(async () => {
        await i18n.changeLanguage('en')
        settingsListeners = []
        mockSettingsState = {
            worktrees: { ...DEFAULT_WORKTREE_SETTINGS },
        }
        mockServices = {
            settings: {
                getSnapshot: () => mockSettingsState,
                subscribe: (fn: any) => {
                    settingsListeners.push(fn)
                    return () => {
                        settingsListeners = settingsListeners.filter((l) => l !== fn)
                    }
                },
                setWorktreeSettings: (next: any) => {
                    mockSettingsState = {
                        ...mockSettingsState,
                        worktrees: { ...mockSettingsState.worktrees, ...next },
                    }
                    settingsListeners.forEach((l) => l(mockSettingsState))
                },
            },
            ui: {
                pushToast: vi.fn(),
            },
            projects: {
                revealPath: vi.fn(),
            },
            fileSystem: {
                getRuntimeInfo: vi.fn().mockResolvedValue({ homeDir: '/home/user' }),
                readDir: vi.fn().mockResolvedValue([]),
                readFile: vi.fn().mockResolvedValue(null),
                readFileIfExists: vi.fn().mockResolvedValue(null),
                removeDir: vi.fn().mockResolvedValue(undefined),
            },
            process: {
                run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
            },
        }
    })

    it('renders all worktree settings and controls matching reference layout', () => {
        render(
            <HostServicesProvider services={mockServices}>
                <WorktreesSection />
            </HostServicesProvider>,
        )

        // Check main title
        expect(
            screen.getByRole('heading', { level: 1, name: 'Worktrees' }),
        ).toBeInTheDocument()

        // Check root dir input
        const rootDirInput = screen.getByLabelText(
            'Worktree root directory',
        ) as HTMLInputElement
        expect(rootDirInput).toBeInTheDocument()
        expect(rootDirInput.value).toBe('~/.coding-professional-agent/worktrees')

        // Check fetch upstream switch (default false)
        expect(
            screen.getByRole('switch', {
                name: 'Always fetch upstream updates before creating worktree',
            }),
        ).toHaveAttribute('aria-checked', 'false')

        // Check auto delete old worktrees switch (default true)
        expect(
            screen.getByRole('switch', { name: 'Automatically delete old worktrees' }),
        ).toHaveAttribute('aria-checked', 'true')

        // Check delete limit input (default 15)
        const deleteLimitInput = screen.getByLabelText(
            'Auto-delete limit',
        ) as HTMLInputElement
        expect(deleteLimitInput).toBeInTheDocument()
        expect(deleteLimitInput.value).toBe('15')

        // Check empty state
        expect(screen.getByText('No worktrees yet')).toBeInTheDocument()
        expect(
            screen.getByText('Worktrees created by CPA will appear here'),
        ).toBeInTheDocument()
    })

    it('allows toggling switches and editing inputs and updates settingsStore', () => {
        render(
            <HostServicesProvider services={mockServices}>
                <WorktreesSection />
            </HostServicesProvider>,
        )

        // Toggle fetch upstream
        const fetchUpstreamSwitch = screen.getByRole('switch', {
            name: 'Always fetch upstream updates before creating worktree',
        })
        fireEvent.click(fetchUpstreamSwitch)
        expect(fetchUpstreamSwitch).toHaveAttribute('aria-checked', 'true')
        expect(mockSettingsState.worktrees.fetchUpstream).toBe(true)

        // Toggle auto delete old
        const autoDeleteSwitch = screen.getByRole('switch', {
            name: 'Automatically delete old worktrees',
        })
        fireEvent.click(autoDeleteSwitch)
        expect(autoDeleteSwitch).toHaveAttribute('aria-checked', 'false')
        expect(mockSettingsState.worktrees.autoDeleteOld).toBe(false)

        // Edit root dir
        const rootDirInput = screen.getByLabelText(
            'Worktree root directory',
        ) as HTMLInputElement
        fireEvent.change(rootDirInput, {
            target: { value: '/custom/worktrees' },
        })
        expect(rootDirInput.value).toBe('/custom/worktrees')
        expect(mockSettingsState.worktrees.rootDir).toBe('/custom/worktrees')

        // Edit limit
        const deleteLimitInput = screen.getByLabelText(
            'Auto-delete limit',
        ) as HTMLInputElement
        fireEvent.change(deleteLimitInput, { target: { value: '20' } })
        expect(deleteLimitInput.value).toBe('20')
        expect(mockSettingsState.worktrees.deleteLimit).toBe(20)
    })

    it('reads and displays worktrees from the configured root directory', async () => {
        const files: Record<string, string> = {
            '/home/user/.coding-professional-agent/worktrees/cpa-feat-1/.git':
                'gitdir: /repo/cpa/.git/worktrees/cpa-feat-1\n',
            '/repo/cpa/.git/worktrees/cpa-feat-1/HEAD':
                'ref: refs/heads/feat/awesome\n',
            '/repo/cpa/.git/worktrees/cpa-feat-1/commondir': '../..\n',
        }

        const fsBridge = {
            readDir: async () => [
                { name: 'cpa-feat-1', isDir: true },
                { name: 'random-dir', isDir: true },
            ],
            readFile: async (p: string) => files[p] ?? null,
        }

        render(
            <HostServicesProvider services={mockServices}>
                <WorktreesSection fsBridge={fsBridge} />
            </HostServicesProvider>,
        )

        await waitFor(() => {
            expect(screen.getByText('cpa-feat-1')).toBeInTheDocument()
        })
        expect(screen.getByText('feat/awesome')).toBeInTheDocument()
        expect(screen.getByText('Managed worktrees (1)')).toBeInTheDocument()
    })

    it('triggers reveal in file manager when clicking the button', async () => {
        const fsBridge = {
            readDir: async () => [{ name: 'my-worktree', isDir: true }],
            readFile: async (p: string) => {
                if (p.endsWith('.git')) {
                    return 'gitdir: /repo/cpa/.git/worktrees/my-worktree\n'
                }
                return null
            },
        }

        render(
            <HostServicesProvider services={mockServices}>
                <WorktreesSection fsBridge={fsBridge} />
            </HostServicesProvider>,
        )

        await waitFor(() => {
            expect(screen.getByText('my-worktree')).toBeInTheDocument()
        })

        const revealBtn = screen.getByLabelText(/reveal in file manager/i)
        fireEvent.click(revealBtn)
        expect(mockServices.projects.revealPath).toHaveBeenCalledWith(
            '/home/user/.coding-professional-agent/worktrees/my-worktree',
        )
    })

    it('deletes worktree, removes git worktree association in main repo, and updates the list', async () => {
        const gitCalls: Array<{ cwd?: string; args: readonly string[] }> = []
        const fakeGitRunner = async (
            args: readonly string[],
            cwd?: string,
        ) => {
            gitCalls.push({ cwd, args })
            return { exitCode: 0, stdout: '', stderr: '' }
        }

        const files: Record<string, string> = {
            '/home/user/.coding-professional-agent/worktrees/cpa-feat-1/.git':
                'gitdir: /repo/cpa/.git/worktrees/cpa-feat-1\n',
            '/repo/cpa/.git/worktrees/cpa-feat-1/HEAD':
                'ref: refs/heads/feat/awesome\n',
            '/repo/cpa/.git/worktrees/cpa-feat-1/commondir': '../..\n',
        }
        let entries = [{ name: 'cpa-feat-1', isDir: true }]
        const removedDirs: string[] = []

        const fsBridge = {
            readDir: async () => entries,
            readFile: async (p: string) => files[p] ?? null,
            removeDir: async (dir: string) => {
                removedDirs.push(dir)
                entries = entries.filter(
                    (e) => `/home/user/.coding-professional-agent/worktrees/${e.name}` !== dir,
                )
            },
        }

        render(
            <HostServicesProvider services={mockServices}>
                <WorktreesSection
                    fsBridge={fsBridge}
                    gitRunner={fakeGitRunner}
                />
            </HostServicesProvider>,
        )

        await waitFor(() => {
            expect(screen.getByText('cpa-feat-1')).toBeInTheDocument()
        })

        const deleteBtn = screen.getByLabelText('Delete worktree')
        expect(deleteBtn).toBeInTheDocument()
        fireEvent.click(deleteBtn)

        await waitFor(() => {
            expect(screen.queryByText('cpa-feat-1')).not.toBeInTheDocument()
        })

        // Verify git worktree remove was called in main repo /repo/cpa with safe parameter array
        expect(gitCalls).toHaveLength(1)
        expect(gitCalls[0]?.cwd).toBe('/repo/cpa')
        expect(gitCalls[0]?.args).toEqual([
            'worktree',
            'remove',
            '--force',
            '/home/user/.coding-professional-agent/worktrees/cpa-feat-1',
        ])
        expect(removedDirs).toContain('/home/user/.coding-professional-agent/worktrees/cpa-feat-1')
        expect(mockServices.ui.pushToast).toHaveBeenCalledWith('Worktree deleted')
    })

    it('supports custom onDelete callback', async () => {
        const onDelete = vi.fn()
        const fsBridge = {
            readDir: async () => [{ name: 'custom-wt', isDir: true }],
            readFile: async (p: string) => {
                if (p.endsWith('.git')) {
                    return 'gitdir: /repo/cpa/.git/worktrees/custom-wt\n'
                }
                return null
            },
        }

        render(
            <HostServicesProvider services={mockServices}>
                <WorktreesSection
                    fsBridge={fsBridge}
                    onDelete={onDelete}
                />
            </HostServicesProvider>,
        )

        await waitFor(() => {
            expect(screen.getByText('custom-wt')).toBeInTheDocument()
        })

        const deleteBtn = screen.getByLabelText('Delete worktree')
        fireEvent.click(deleteBtn)

        expect(onDelete).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'custom-wt',
                path: '/home/user/.coding-professional-agent/worktrees/custom-wt',
            }),
        )
    })

    it('renders gracefully in web mode / no bridge without errors', async () => {
        render(
            <HostServicesProvider services={null}>
                <WorktreesSection />
            </HostServicesProvider>,
        )

        expect(screen.getByRole('heading', { level: 1, name: 'Worktrees' })).toBeInTheDocument()
        expect(screen.getByText('No worktrees yet')).toBeInTheDocument()
    })

    it('has complete localized translations in zh-CN', () => {
        expect(i18n.t('settings.nav.worktrees', { lng: 'zh-CN' })).not.toBe('Worktrees')
        expect(i18n.t('settings.worktrees.title', { lng: 'zh-CN' })).not.toBe('Worktrees')
        expect(i18n.t('settings.worktrees.subtitle', { lng: 'zh-CN' })).toBeTruthy()
        expect(i18n.t('settings.worktrees.rootDir.desc', { lng: 'zh-CN' })).toBeTruthy()
        expect(i18n.t('settings.worktrees.fetchUpstream.desc', { lng: 'zh-CN' })).toBeTruthy()
        expect(i18n.t('settings.worktrees.autoDeleteOld', { lng: 'zh-CN' })).toBeTruthy()
        expect(i18n.t('settings.worktrees.autoDeleteOld.desc', { lng: 'zh-CN' })).toBeTruthy()
        expect(i18n.t('settings.worktrees.deleteLimit.desc', { lng: 'zh-CN' })).toBeTruthy()
        expect(i18n.t('settings.worktrees.activeTitle', { lng: 'zh-CN' })).toBeTruthy()
    })

    it('statically enforces zero window.electronBridge access across cpa.core.worktree', () => {
        const worktreePluginDir = path.resolve(__dirname, '../../')
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

        const files = scanFiles(worktreePluginDir)
        for (const file of files) {
            if (!file.endsWith('.test.ts') && !file.endsWith('.test.tsx')) {
                const content = fs.readFileSync(file, 'utf8')
                expect(content, `File ${file} should not access native bridge`).not.toContain('window.electronBridge')
                expect(content, `File ${file} should not contain hardcoded luis path`).not.toContain('/Users/luis/.codex/worktrees')
            }
        }
    })
})
