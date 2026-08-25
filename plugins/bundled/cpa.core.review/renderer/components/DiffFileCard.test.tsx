import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import i18n from '@/i18n'
import { HostServicesProvider } from '@cpa/plugin-ui'
import type { GitDiffFile } from '../utils/gitDiff.js'
import { DiffFileCard } from './DiffFileCard.js'

describe('DiffFileCard', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  const sampleFile: GitDiffFile = {
    oldPath: 'src/main.ts',
    newPath: 'src/main.ts',
    displayPath: 'src/main.ts',
    status: 'modified',
    additions: 2,
    deletions: 1,
    isBinary: false,
    hunks: [
      {
        oldStart: 4,
        oldLines: 4,
        newStart: 4,
        newLines: 5,
        heading: '',
        lines: [
          {
            type: 'normal',
            oldLineNumber: 4,
            newLineNumber: 4,
            content: 'const x = 1',
          },
          {
            type: 'delete',
            oldLineNumber: 5,
            newLineNumber: null,
            content: 'const y = 2',
          },
          {
            type: 'add',
            oldLineNumber: null,
            newLineNumber: 5,
            content: 'const y = 3',
          },
          {
            type: 'add',
            oldLineNumber: null,
            newLineNumber: 6,
            content: 'const z = 4',
          },
          {
            type: 'normal',
            oldLineNumber: 6,
            newLineNumber: 7,
            content: 'return x + y',
          },
        ],
      },
    ],
  }

  const mockFileContent = `// Line 1: Header
// Line 2: Import
// Line 3: Config
const x = 1
const y = 3
const z = 4
return x + y
// Line 8: Footer
`

  let mockServices: any

  beforeEach(() => {
    mockServices = {
      fileSystem: {
        readFile: vi.fn(async () => ({
          dataBase64: btoa(mockFileContent),
        })),
      },
      ui: {
        writeClipboard: vi.fn(async () => {}),
        pushToast: vi.fn(),
      },
      process: {
        run: vi.fn(async () => ({ exitCode: 0, stdout: mockFileContent, stderr: '' })),
      },
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders file header with path and additions/deletions stats', () => {
    render(
      <HostServicesProvider services={mockServices}>
        <DiffFileCard file={sampleFile} />
      </HostServicesProvider>,
    )

    expect(screen.getByText('src/main.ts')).toBeInTheDocument()
    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(screen.getByText('-1')).toBeInTheDocument()
  })

  it('renders diff lines with additions and deletions styled', () => {
    const { container } = render(
      <HostServicesProvider services={mockServices}>
        <DiffFileCard file={sampleFile} />
      </HostServicesProvider>,
    )

    expect(container.textContent).toContain('const x = 1')
    expect(container.textContent).toContain('const y = 2')
    expect(container.textContent).toContain('const y = 3')
    expect(container.textContent).toContain('const z = 4')
  })

  it('toggles expansion on header click', () => {
    const { container } = render(
      <HostServicesProvider services={mockServices}>
        <DiffFileCard file={sampleFile} />
      </HostServicesProvider>,
    )

    expect(container.textContent).toContain('const x = 1')

    // Collapse
    fireEvent.click(screen.getByText('src/main.ts'))
    expect(container.textContent).not.toContain('const x = 1')

    // Expand
    fireEvent.click(screen.getByText('src/main.ts'))
    expect(container.textContent).toContain('const x = 1')
  })

  it('expands hidden unmodified lines when clicking unmodified banner', async () => {
    const { container } = render(
      <HostServicesProvider services={mockServices}>
        <DiffFileCard file={sampleFile} projectPath="/workspace/project" />
      </HostServicesProvider>,
    )

    // Unmodified lines banner should show 3 unmodified lines (lines 1..3 before line 4)
    expect(screen.getByText('3 unmodified lines')).toBeInTheDocument()
    expect(container.textContent).not.toContain('// Line 1: Header')

    // Click the banner to expand
    fireEvent.click(screen.getByText('3 unmodified lines'))

    await waitFor(() => {
      expect(container.textContent).toContain('// Line 1: Header')
      expect(container.textContent).toContain('// Line 2: Import')
      expect(container.textContent).toContain('// Line 3: Config')
    })

    // Banner label updates to collapse
    expect(screen.getByText('Collapse 3 unmodified lines')).toBeInTheDocument()

    // Click again to collapse
    fireEvent.click(screen.getByText('Collapse 3 unmodified lines'))
    expect(container.textContent).not.toContain('// Line 1: Header')
  })

  it('renders split diff rows and fixed center divider when isSplitView is true', () => {
    const { container } = render(
      <HostServicesProvider services={mockServices}>
        <DiffFileCard file={sampleFile} isSplitView={true} />
      </HostServicesProvider>,
    )

    expect(screen.getByTestId('split-diff-center-divider')).toBeInTheDocument()
    expect(container.textContent).toContain('const x = 1')
    expect(container.textContent).toContain('const y = 2')
    expect(container.textContent).toContain('const y = 3')
    expect(container.textContent).toContain('const z = 4')
  })

  it('syncs expansion state when defaultExpanded prop updates', () => {
    const { container, rerender } = render(
      <HostServicesProvider services={mockServices}>
        <DiffFileCard file={sampleFile} defaultExpanded={true} />
      </HostServicesProvider>,
    )

    expect(container.textContent).toContain('const x = 1')

    rerender(
      <HostServicesProvider services={mockServices}>
        <DiffFileCard file={sampleFile} defaultExpanded={false} />
      </HostServicesProvider>,
    )
    expect(container.textContent).not.toContain('const x = 1')

    rerender(
      <HostServicesProvider services={mockServices}>
        <DiffFileCard file={sampleFile} defaultExpanded={true} />
      </HostServicesProvider>,
    )
    expect(container.textContent).toContain('const x = 1')
  })

  it('renders banner for binary file', () => {
    const binaryFile: GitDiffFile = {
      oldPath: 'image.png',
      newPath: 'image.png',
      displayPath: 'image.png',
      status: 'modified',
      additions: 0,
      deletions: 0,
      isBinary: true,
      hunks: [],
    }

    render(
      <HostServicesProvider services={mockServices}>
        <DiffFileCard file={binaryFile} />
      </HostServicesProvider>,
    )
    expect(screen.getByText('Binary file changed')).toBeInTheDocument()
  })

  it('applies flashing animation and calls onFlashEnd when animation finishes', () => {
    const onFlashEnd = vi.fn()
    const { rerender } = render(
      <HostServicesProvider services={mockServices}>
        <DiffFileCard file={sampleFile} isFlashing={false} onFlashEnd={onFlashEnd} />
      </HostServicesProvider>,
    )

    expect(screen.getByTestId('diff-file-card-src/main.ts')).not.toHaveClass('animate-diff-card-flash')
    expect(screen.getByTestId('diff-file-card-src/main.ts')).not.toHaveAttribute('data-flashing')

    rerender(
      <HostServicesProvider services={mockServices}>
        <DiffFileCard file={sampleFile} isFlashing={true} onFlashEnd={onFlashEnd} />
      </HostServicesProvider>,
    )

    const flashingCard = screen.getByTestId('diff-file-card-src/main.ts')
    expect(flashingCard).toHaveClass('animate-diff-card-flash')
    expect(flashingCard).toHaveAttribute('data-flashing', 'true')

    fireEvent.animationEnd(flashingCard)
    expect(onFlashEnd).toHaveBeenCalledTimes(1)
  })
})
