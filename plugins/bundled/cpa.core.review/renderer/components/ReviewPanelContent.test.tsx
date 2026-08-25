import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import * as gitDiffModule from '../utils/gitDiff.js'
import { rendererPluginRuntime } from '@/plugins/platform/RendererPluginRuntimeHost'
import { useProjectStore } from '@/stores/projectStore'
import { useUiStore } from '@/stores/uiStore'
import { HostServicesProvider, I18nextProvider } from '@cpa/plugin-ui'
import { ReviewPanelContent, matchDiffFile } from './ReviewPanelContent.js'

const mockSend = vi.fn()
const mockNavigate = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}))

describe('ReviewPanelContent', () => {
  const mockProject = {
    id: 'proj-1',
    name: 'CLIProxyAPI',
    path: '/workspace/CLIProxyAPI',
    pinned: false,
    createdAt: 1000,
    updatedAt: 1000,
  }

  const mockDiffSummary: gitDiffModule.GitDiffSummary = {
    files: [
      {
        oldPath: 'internal/runtime/executor/xai_executor_execute.go',
        newPath: 'internal/runtime/executor/xai_executor_execute.go',
        displayPath: 'internal/runtime/executor/xai_executor_execute.go',
        status: 'modified',
        additions: 1,
        deletions: 1,
        isBinary: false,
        hunks: [
          {
            oldStart: 149,
            oldLines: 7,
            newStart: 149,
            newLines: 7,
            heading: '',
            lines: [
              {
                type: 'normal',
                oldLineNumber: 149,
                newLineNumber: 149,
                content: 'prepared.body, _ = sjson.DeleteBytes(prepared.body, "stream")',
              },
              {
                type: 'delete',
                oldLineNumber: 152,
                newLineNumber: null,
                content: '// image_generation and rewrite its forced choice to allowed_tools on grok-4.6+.',
              },
              {
                type: 'add',
                oldLineNumber: null,
                newLineNumber: 152,
                content: '// image_generation and rewrite its forced choice to "required" on grok-4.6+.',
              },
            ],
          },
        ],
      },
      {
        oldPath: 'internal/runtime/executor/xai_executor_request.go',
        newPath: 'internal/runtime/executor/xai_executor_request.go',
        displayPath: 'internal/runtime/executor/xai_executor_request.go',
        status: 'modified',
        additions: 107,
        deletions: 5,
        isBinary: false,
        hunks: [
          {
            oldStart: 98,
            oldLines: 10,
            newStart: 98,
            newLines: 12,
            heading: '',
            lines: [
              {
                type: 'delete',
                oldLineNumber: 101,
                newLineNumber: null,
                content: 'body = normalizeXAIForcedImageGenerationToolChoice(body)',
              },
              {
                type: 'add',
                oldLineNumber: null,
                newLineNumber: 101,
                content: '// Prune before rewriting image_generation choices',
              },
            ],
          },
        ],
      },
    ],
    totalAdditions: 108,
    totalDeletions: 6,
    totalFilesChanged: 2,
    rawDiff: 'sample diff output',
  }

  const mockRepoDetails: gitDiffModule.GitRepoDetails = {
    repoRoot: '/workspace/CLIProxyAPI',
    currentBranch: 'dev',
    defaultBranch: 'main',
    branches: ['dev', 'main', 'feature/review'],
    remoteUrl: 'https://github.com/router-for-me/CLIProxyAPI.git',
    isClean: false,
  }

  const EMPTY_SESSIONS = Object.freeze([])
  let mockServices: any

  beforeEach(async () => {
    await i18n.changeLanguage('en')
    vi.clearAllMocks()
    useProjectStore.setState({ projects: [mockProject] })
    useUiStore.setState({
      pendingSessionContext: { projectId: 'proj-1', branch: null },
      toasts: [],
    })

    mockServices = {
      chatMessages: {
        send: mockSend,
        getAgentRunState: vi.fn(() => ({ isStreaming: false })),
      },
      agentRun: {
        send: mockSend,
        getRunState: vi.fn(() => ({ isStreaming: false })),
      },
      ui: {
        getPendingSessionContext: () => useUiStore.getState().pendingSessionContext,
        pushToast: (msg: string) => useUiStore.getState().pushToast(msg),
        writeClipboard: vi.fn(async (text: string) => navigator.clipboard?.writeText?.(text)),
      },
      projects: {
        getSnapshot: () => useProjectStore.getState().projects,
        subscribe: (listener: any) => useProjectStore.subscribe(listener),
      },
      sessions: {
        getSnapshot: () => EMPTY_SESSIONS,
        subscribe: () => () => {},
        getCurrentSessionId: () => null,
      },
      navigation: {
        navigate: mockNavigate,
      },
      process: {
        run: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      },
    }

    vi.spyOn(gitDiffModule, 'loadGitRepoDetails').mockResolvedValue(mockRepoDetails)
    vi.spyOn(gitDiffModule, 'loadGitDiff').mockResolvedValue(mockDiffSummary)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders empty project state when no project is selected', () => {
    useProjectStore.setState({ projects: [] })
    useUiStore.setState({ pendingSessionContext: { projectId: null, branch: null } })

    render(
      <I18nextProvider i18n={i18n}><HostServicesProvider services={mockServices}>
        <ReviewPanelContent />
      </HostServicesProvider></I18nextProvider>,
    )
    expect(screen.getByTestId('right-sidebar-review-no-project')).toBeInTheDocument()
    expect(screen.getByText('No project selected')).toBeInTheDocument()
  })

  it('renders not-git-repo warning when project is not a git repo', async () => {
    vi.spyOn(gitDiffModule, 'loadGitRepoDetails').mockResolvedValue(null)

    render(
      <I18nextProvider i18n={i18n}><HostServicesProvider services={mockServices}>
        <ReviewPanelContent />
      </HostServicesProvider></I18nextProvider>,
    )
    await waitFor(() => {
      expect(screen.getByTestId('right-sidebar-review-not-git')).toBeInTheDocument()
    })
    expect(screen.getByText('Current project is not a Git repository')).toBeInTheDocument()
  })

  it('renders full review UI with toolbar, diff cards, and file tree', async () => {
    render(
      <I18nextProvider i18n={i18n}><HostServicesProvider services={mockServices}>
        <ReviewPanelContent />
      </HostServicesProvider></I18nextProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('diff-header-toolbar')).toBeInTheDocument()
      expect(screen.getByTestId('branch-compare-trigger')).toBeInTheDocument()
      expect(
        screen.getByTestId('diff-file-card-internal/runtime/executor/xai_executor_execute.go'),
      ).toBeInTheDocument()
    })

    expect(screen.getByText('+108')).toBeInTheDocument()
    expect(screen.getByText('-6')).toBeInTheDocument()

    // File Cards in Diff container
    expect(
      screen.getByTestId('diff-file-card-internal/runtime/executor/xai_executor_request.go'),
    ).toBeInTheDocument()

    // File Tree on right
    expect(screen.getByTestId('diff-file-tree')).toBeInTheDocument()
    expect(
      screen.getByTestId('tree-file-internal/runtime/executor/xai_executor_execute.go'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('tree-file-internal/runtime/executor/xai_executor_request.go'),
    ).toBeInTheDocument()
  })

  it('opens and closes branch compare modal', async () => {
    render(
      <I18nextProvider i18n={i18n}><HostServicesProvider services={mockServices}>
        <ReviewPanelContent />
      </HostServicesProvider></I18nextProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('branch-compare-trigger')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('branch-compare-trigger'))
    expect(screen.getByTestId('branch-compare-modal')).toBeInTheDocument()
    expect(screen.getByText('Compare Settings')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByTestId('branch-compare-modal')).not.toBeInTheDocument()
  })

  it('scrolls to file when clicking file in file tree and flashes card border', async () => {
    const scrollIntoViewMock = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoViewMock

    render(
      <I18nextProvider i18n={i18n}><HostServicesProvider services={mockServices}>
        <ReviewPanelContent />
      </HostServicesProvider></I18nextProvider>,
    )

    const targetCardTestId =
      'diff-file-card-internal/runtime/executor/xai_executor_request.go'

    await waitFor(() => {
      expect(screen.getByTestId(targetCardTestId)).toBeInTheDocument()
      expect(
        screen.getByTestId('tree-file-internal/runtime/executor/xai_executor_request.go'),
      ).toBeInTheDocument()
    })

    expect(screen.getByTestId(targetCardTestId)).not.toHaveAttribute('data-flashing')

    fireEvent.click(
      screen.getByTestId('tree-file-internal/runtime/executor/xai_executor_request.go'),
    )
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
    })

    // Simulate scrollend or wait for fallback timer
    const container = screen.getByTestId('diff-container')
    fireEvent(container, new Event('scrollend'))

    await waitFor(() => {
      expect(screen.getByTestId(targetCardTestId)).toHaveAttribute('data-flashing', 'true')
      expect(screen.getByTestId(targetCardTestId)).toHaveClass('animate-diff-card-flash')
    })

    // Trigger animationEnd on the card to end the flash
    fireEvent.animationEnd(screen.getByTestId(targetCardTestId))

    await waitFor(() => {
      expect(screen.getByTestId(targetCardTestId)).not.toHaveAttribute('data-flashing')
    })
  })

  it('toggles sidebar on and off', async () => {
    render(
      <I18nextProvider i18n={i18n}><HostServicesProvider services={mockServices}>
        <ReviewPanelContent />
      </HostServicesProvider></I18nextProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('diff-file-tree')).toBeInTheDocument()
    })

    const toggleBtn = screen.getByTitle('Toggle file list')
    fireEvent.click(toggleBtn)

    await waitFor(() => {
      expect(screen.getByTestId('diff-file-tree')).toHaveAttribute('data-state', 'closed')
    })

    fireEvent.click(toggleBtn)
    await waitFor(() => {
      expect(screen.getByTestId('diff-file-tree')).toHaveAttribute('data-state', 'open')
    })
  })

  it('toggles all diff file cards expanded and collapsed', async () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}><HostServicesProvider services={mockServices}>
        <ReviewPanelContent />
      </HostServicesProvider></I18nextProvider>,
    )

    await waitFor(() => {
      expect(
        screen.getByTestId('diff-file-card-internal/runtime/executor/xai_executor_execute.go'),
      ).toBeInTheDocument()
    })

    // Initially expanded - diff content is visible
    expect(container.textContent).toContain('prepared.body, _ = sjson.DeleteBytes(prepared.body, "stream")')

    // Click collapse all button
    const toggleAllBtn = screen.getByTestId('toggle-all-expanded-button')
    fireEvent.click(toggleAllBtn)

    // Diff lines should now be collapsed and hidden
    await waitFor(() => {
      expect(container.textContent).not.toContain('prepared.body, _ = sjson.DeleteBytes(prepared.body, "stream")')
    })

    // Click expand all button
    fireEvent.click(toggleAllBtn)

    // Diff lines should be expanded and visible again
    await waitFor(() => {
      expect(container.textContent).toContain('prepared.body, _ = sjson.DeleteBytes(prepared.body, "stream")')
    })
  })

  it('copies full diff to clipboard and shows diff copied toast', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    })

    render(
      <I18nextProvider i18n={i18n}><HostServicesProvider services={mockServices}>
        <ReviewPanelContent />
      </HostServicesProvider></I18nextProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('diff-header-toolbar')).toBeInTheDocument()
    })

    const moreButton = screen.getByTestId('diff-toolbar-more-button')
    fireEvent.click(moreButton)

    const copyDiffBtn = screen.getByTestId('diff-toolbar-copy-diff-button')
    fireEvent.click(copyDiffBtn)

    expect(writeTextMock).toHaveBeenCalledWith('sample diff output')
    expect(useUiStore.getState().toasts).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: 'Copied diff' })]),
    )
  })

  it('triggers AI review from more menu with the correct project and branch', async () => {
    mockSend.mockResolvedValue('new-session-id')

    render(
      <I18nextProvider i18n={i18n}><HostServicesProvider services={mockServices}>
        <ReviewPanelContent sessionId={null} />
      </HostServicesProvider></I18nextProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('diff-header-toolbar')).toBeInTheDocument()
    })

    const moreButton = screen.getByTestId('diff-toolbar-more-button')
    fireEvent.click(moreButton)

    const aiReviewBtn = screen.getByTestId('diff-toolbar-ai-review-button')
    fireEvent.click(aiReviewBtn)

    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'review',
          projectId: 'proj-1',
          branch: 'dev',
          sessionId: null,
          text: expect.stringContaining('Please review the code changes in this workspace'),
        }),
      )
    })

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/chat/$sessionId',
        params: { sessionId: 'new-session-id' },
      })
    })
  })

  it('refreshes git diff when review:refresh event is emitted on defaultEventBus', async () => {
    render(
      <I18nextProvider i18n={i18n}><HostServicesProvider services={mockServices}>
        <ReviewPanelContent />
      </HostServicesProvider></I18nextProvider>,
    )

    await waitFor(() => {
      expect(gitDiffModule.loadGitDiff).toHaveBeenCalledTimes(1)
    })

    rendererPluginRuntime.eventBus.emit('review:refresh', { projectId: 'proj-1' })

    await waitFor(() => {
      expect(gitDiffModule.loadGitDiff).toHaveBeenCalledTimes(2)
    })
  })

  it('does not re-trigger loadGitDiff when selecting a file from the diff tree', async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn()

    render(
      <I18nextProvider i18n={i18n}><HostServicesProvider services={mockServices}>
        <ReviewPanelContent />
      </HostServicesProvider></I18nextProvider>,
    )

    await waitFor(() => {
      expect(gitDiffModule.loadGitDiff).toHaveBeenCalledTimes(1)
      expect(
        screen.getByTestId('tree-file-internal/runtime/executor/xai_executor_request.go'),
      ).toBeInTheDocument()
    })

    fireEvent.click(
      screen.getByTestId('tree-file-internal/runtime/executor/xai_executor_request.go'),
    )

    // Verify file is selected without causing additional loadGitDiff calls
    expect(gitDiffModule.loadGitDiff).toHaveBeenCalledTimes(1)
  })

  it('automatically enables single-file view for large diffs, lists all files in tree, and allows switching files', async () => {
    const largeFiles: gitDiffModule.GitDiffFile[] = Array.from({ length: 6 }, (_, i) => ({
      oldPath: `src/module_${i}.ts`,
      newPath: `src/module_${i}.ts`,
      displayPath: `src/module_${i}.ts`,
      status: 'modified',
      additions: 10,
      deletions: 2,
      isBinary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          heading: '',
          lines: [
            {
              type: 'normal',
              oldLineNumber: 1,
              newLineNumber: 1,
              content: `console.log("module_${i}")`,
            },
          ],
        },
      ],
    }))

    const largeDiffSummary: gitDiffModule.GitDiffSummary = {
      files: largeFiles,
      totalAdditions: 60,
      totalDeletions: 12,
      totalFilesChanged: 6,
      rawDiff: 'large diff summary',
    }

    vi.spyOn(gitDiffModule, 'loadGitDiff').mockResolvedValue(largeDiffSummary)

    render(
      <I18nextProvider i18n={i18n}><HostServicesProvider services={mockServices}>
        <ReviewPanelContent />
      </HostServicesProvider></I18nextProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('single-file-nav-header')).toBeInTheDocument()
      expect(screen.getByTestId('large-diff-badge')).toBeInTheDocument()
    })

    // In single-file mode, only the first file card is displayed in details
    expect(screen.getByTestId('diff-file-card-src/module_0.ts')).toBeInTheDocument()
    expect(screen.queryByTestId('diff-file-card-src/module_1.ts')).not.toBeInTheDocument()
    expect(screen.getByTestId('single-file-counter')).toHaveTextContent('File 1 of 6')

    // Right file tree still lists all files
    expect(screen.getByTestId('tree-file-src/module_0.ts')).toBeInTheDocument()
    expect(screen.getByTestId('tree-file-src/module_1.ts')).toBeInTheDocument()
    expect(screen.getByTestId('tree-file-src/module_5.ts')).toBeInTheDocument()

    // Click on module_2 in the right tree to switch single-file view
    fireEvent.click(screen.getByTestId('tree-file-src/module_2.ts'))

    await waitFor(() => {
      expect(screen.getByTestId('diff-file-card-src/module_2.ts')).toBeInTheDocument()
      expect(screen.queryByTestId('diff-file-card-src/module_0.ts')).not.toBeInTheDocument()
      expect(screen.getByTestId('single-file-counter')).toHaveTextContent('File 3 of 6')
    })

    // Click next file button
    const nextBtn = screen.getByTestId('single-file-next-button')
    fireEvent.click(nextBtn)

    await waitFor(() => {
      expect(screen.getByTestId('diff-file-card-src/module_3.ts')).toBeInTheDocument()
      expect(screen.getByTestId('single-file-counter')).toHaveTextContent('File 4 of 6')
    })

    // Click prev file button
    const prevBtn = screen.getByTestId('single-file-prev-button')
    fireEvent.click(prevBtn)

    await waitFor(() => {
      expect(screen.getByTestId('diff-file-card-src/module_2.ts')).toBeInTheDocument()
      expect(screen.getByTestId('single-file-counter')).toHaveTextContent('File 3 of 6')
    })

    // Switch to all files view via toggle in nav header
    const toggleAllBtn = screen.getByTestId('toggle-view-mode-all-files')
    fireEvent.click(toggleAllBtn)

    await waitFor(() => {
      // Now all cards should be rendered
      expect(screen.getByTestId('diff-file-card-src/module_0.ts')).toBeInTheDocument()
      expect(screen.getByTestId('diff-file-card-src/module_1.ts')).toBeInTheDocument()
      expect(screen.getByTestId('diff-file-card-src/module_2.ts')).toBeInTheDocument()
      expect(screen.getByTestId('diff-file-card-src/module_5.ts')).toBeInTheDocument()
    })
  })

  it('selects and focuses requested file when selectedFilePath prop is provided', async () => {
    render(
      <I18nextProvider i18n={i18n}><HostServicesProvider services={mockServices}>
        <ReviewPanelContent
          selectedFilePath="internal/runtime/executor/xai_executor_request.go"
        />
      </HostServicesProvider></I18nextProvider>,
    )

    await waitFor(() => {
      expect(
        screen.getByTestId('diff-file-card-internal/runtime/executor/xai_executor_request.go')
      ).toBeInTheDocument()
    })

    const requestTreeItem = screen.getByTestId(
      'tree-file-internal/runtime/executor/xai_executor_request.go'
    )
    expect(requestTreeItem).toBeInTheDocument()
  })

  it('selects requested file when review:select-file event is emitted on defaultEventBus', async () => {
    render(
      <I18nextProvider i18n={i18n}><HostServicesProvider services={mockServices}>
        <ReviewPanelContent />
      </HostServicesProvider></I18nextProvider>,
    )

    await waitFor(() => {
      expect(
        screen.getByTestId('diff-file-card-internal/runtime/executor/xai_executor_execute.go')
      ).toBeInTheDocument()
    })

    rendererPluginRuntime.eventBus.emit('review:select-file', {
      filePath: 'internal/runtime/executor/xai_executor_request.go',
    })

    await waitFor(() => {
      expect(
        screen.getByTestId('diff-file-card-internal/runtime/executor/xai_executor_request.go')
      ).toBeInTheDocument()
    })
  })

  it('loads git details and diff from session worktreePath in worktree mode', async () => {
    const worktreeSession = Object.freeze({
      id: 'sess-worktree',
      projectId: 'proj-1',
      workLocation: 'worktree' as const,
      worktreePath: '/workspace/worktrees/CLIProxyAPI-wt-1',
    })
    const worktreeSessions = Object.freeze([worktreeSession])

    mockServices.sessions = {
      getSnapshot: () => worktreeSessions,
      subscribe: () => () => {},
      getCurrentSessionId: () => 'sess-worktree',
    }

    render(
      <I18nextProvider i18n={i18n}><HostServicesProvider services={mockServices}>
        <ReviewPanelContent sessionId="sess-worktree" />
      </HostServicesProvider></I18nextProvider>,
    )

    await waitFor(() => {
      expect(gitDiffModule.loadGitRepoDetails).toHaveBeenCalledWith(
        '/workspace/worktrees/CLIProxyAPI-wt-1',
        expect.any(Function),
      )
      expect(gitDiffModule.loadGitDiff).toHaveBeenCalledWith(
        '/workspace/worktrees/CLIProxyAPI-wt-1',
        expect.objectContaining({
          mode: 'workingTree',
        }),
      )
    })
  })

  it('loads git details and diff from session worktreeSetup.worktreePath when worktreePath is omitted', async () => {
    const worktreeSession = Object.freeze({
      id: 'sess-worktree-setup',
      projectId: 'proj-1',
      workLocation: 'worktree' as const,
      worktreeSetup: {
        worktreePath: '/workspace/worktrees/CLIProxyAPI-wt-setup',
        branch: 'feat/setup-branch',
        baseBranch: 'main',
      },
    })
    const worktreeSessions = Object.freeze([worktreeSession])

    mockServices.sessions = {
      getSnapshot: () => worktreeSessions,
      subscribe: () => () => {},
      getCurrentSessionId: () => 'sess-worktree-setup',
    }

    render(
      <I18nextProvider i18n={i18n}><HostServicesProvider services={mockServices}>
        <ReviewPanelContent sessionId="sess-worktree-setup" />
      </HostServicesProvider></I18nextProvider>,
    )

    await waitFor(() => {
      expect(gitDiffModule.loadGitRepoDetails).toHaveBeenCalledWith(
        '/workspace/worktrees/CLIProxyAPI-wt-setup',
        expect.any(Function),
      )
      expect(gitDiffModule.loadGitDiff).toHaveBeenCalledWith(
        '/workspace/worktrees/CLIProxyAPI-wt-setup',
        expect.objectContaining({
          mode: 'workingTree',
        }),
      )
    })
  })

  it('renders review UI for a worktree session without a matching project in projectStore', async () => {
    useProjectStore.setState({ projects: [] })
    useUiStore.setState({ pendingSessionContext: { projectId: null, branch: null } })

    const worktreeSession = Object.freeze({
      id: 'sess-worktree-orphan',
      workLocation: 'worktree' as const,
      worktreePath: '/workspace/worktrees/CLIProxyAPI-wt-orphan',
    })
    const worktreeSessions = Object.freeze([worktreeSession])

    mockServices.sessions = {
      getSnapshot: () => worktreeSessions,
      subscribe: () => () => {},
      getCurrentSessionId: () => 'sess-worktree-orphan',
    }

    render(
      <I18nextProvider i18n={i18n}><HostServicesProvider services={mockServices}>
        <ReviewPanelContent sessionId="sess-worktree-orphan" />
      </HostServicesProvider></I18nextProvider>,
    )

    await waitFor(() => {
      expect(screen.queryByTestId('right-sidebar-review-no-project')).not.toBeInTheDocument()
      expect(screen.getByTestId('right-sidebar-review-view')).toBeInTheDocument()
      expect(gitDiffModule.loadGitRepoDetails).toHaveBeenCalledWith(
        '/workspace/worktrees/CLIProxyAPI-wt-orphan',
        expect.any(Function),
      )
    })
  })

  describe('matchDiffFile', () => {
    const files: gitDiffModule.GitDiffFile[] = [
      {
        oldPath: 'src/components/chat/App.tsx',
        newPath: 'src/components/chat/App.tsx',
        displayPath: 'src/components/chat/App.tsx',
        status: 'modified',
        additions: 5,
        deletions: 2,
        isBinary: false,
        hunks: [],
      },
      {
        oldPath: 'package.json',
        newPath: 'package.json',
        displayPath: 'package.json',
        status: 'modified',
        additions: 1,
        deletions: 1,
        isBinary: false,
        hunks: [],
      },
    ]

    it('matches exact displayPath', () => {
      const match = matchDiffFile(files, 'src/components/chat/App.tsx')
      expect(match?.displayPath).toBe('src/components/chat/App.tsx')
    })

    it('matches path with leading dot-slash', () => {
      const match = matchDiffFile(files, './src/components/chat/App.tsx')
      expect(match?.displayPath).toBe('src/components/chat/App.tsx')
    })

    it('matches absolute path ending with displayPath', () => {
      const match = matchDiffFile(
        files,
        '/Users/user/workspace/project/src/components/chat/App.tsx'
      )
      expect(match?.displayPath).toBe('src/components/chat/App.tsx')
    })

    it('matches displayPath ending with targetPath (suffix)', () => {
      const match = matchDiffFile(files, 'chat/App.tsx')
      expect(match?.displayPath).toBe('src/components/chat/App.tsx')
    })

    it('matches windows style backslashes', () => {
      const match = matchDiffFile(files, 'src\\components\\chat\\App.tsx')
      expect(match?.displayPath).toBe('src/components/chat/App.tsx')
    })

    it('returns undefined for non-matching path or empty input', () => {
      expect(matchDiffFile(files, 'unknown/path.ts')).toBeUndefined()
      expect(matchDiffFile(files, '')).toBeUndefined()
      expect(matchDiffFile(files, null)).toBeUndefined()
      expect(matchDiffFile([], 'src/App.tsx')).toBeUndefined()
    })
  })
})
