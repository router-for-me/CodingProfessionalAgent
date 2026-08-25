import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  RefreshCw,
  FileTypeIcon,
  useTranslation,
  useHostServices,
  cn,
} from '@cpa/plugin-ui'
import type { GitDiffFile, GitDiffLine } from '../utils/gitDiff.js'
import { detectLanguage, highlightCodeLine } from '../utils/diffHighlighter.js'

export interface DiffFileCardProps {
  file: GitDiffFile
  projectPath?: string
  defaultExpanded?: boolean
  isSplitView?: boolean
  className?: string
  id?: string
  isFlashing?: boolean
  onFlashEnd?: () => void
}

function base64ToUtf8(b64: string): string {
  if (!b64) return ''
  try {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

async function loadFileLines(
  projectPath: string,
  filePath: string,
  services?: any,
): Promise<string[]> {
  const fullPath = `${projectPath.replace(/\/+$/, '')}/${filePath.replace(/^\/+/, '')}`
  try {
    if (services?.fileSystem?.readFile) {
      const res = await services.fileSystem.readFile(fullPath)
      if (typeof res === 'string') {
        return (res as string).split(/\r?\n/)
      }
      if (res?.dataBase64) {
        return base64ToUtf8(res.dataBase64).split(/\r?\n/)
      }
    }
  } catch {
    // Fallback to git show
  }

  try {
    if (services?.process?.run) {
      const gitRes = await services.process.run({
        command: 'git',
        args: ['show', `HEAD:${filePath}`],
        cwd: projectPath,
      })
      if (gitRes.exitCode === 0 && gitRes.stdout) {
        return gitRes.stdout.split(/\r?\n/)
      }
    }
  } catch {
    // Fallback
  }

  return []
}

const SPLIT_EMPTY_STRIPES_STYLE: React.CSSProperties = {
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='11' height='11' fill='none'%3E%3Cpath d='M0 11L11 0M-2 2L2 -2M9 13L13 9' stroke='rgba(255,255,255,0.06)' stroke-width='1.2'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'repeat',
  backgroundSize: '11px 11px',
}

interface SplitDiffRow {
  left: GitDiffLine | null
  right: GitDiffLine | null
}

function buildSplitRows(lines: GitDiffLine[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.type === 'normal') {
      rows.push({ left: line, right: line })
      i += 1
    } else {
      const deletes: GitDiffLine[] = []
      const adds: GitDiffLine[] = []
      while (i < lines.length && (lines[i].type === 'delete' || lines[i].type === 'add')) {
        if (lines[i].type === 'delete') {
          deletes.push(lines[i])
        } else {
          adds.push(lines[i])
        }
        i += 1
      }
      const maxLen = Math.max(deletes.length, adds.length)
      for (let k = 0; k < maxLen; k += 1) {
        rows.push({
          left: deletes[k] ?? null,
          right: adds[k] ?? null,
        })
      }
    }
  }
  return rows
}

export function DiffFileCard({
  file,
  projectPath,
  defaultExpanded = true,
  isSplitView = false,
  className,
  id,
  isFlashing = false,
  onFlashEnd,
}: DiffFileCardProps) {
  const { t } = useTranslation()
  const services = useHostServices()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [copied, setCopied] = useState(false)

  const [fileLines, setFileLines] = useState<string[] | null>(null)
  const [isLoadingLines, setIsLoadingLines] = useState(false)
  const [expandedBanners, setExpandedBanners] = useState<Record<string, boolean>>({})

  const cardRef = useRef<HTMLDivElement>(null)
  const leftPaneRef = useRef<HTMLDivElement>(null)
  const rightPaneRef = useRef<HTMLDivElement>(null)
  const isSyncingRef = useRef<boolean>(false)

  const language = useMemo(
    () => detectLanguage(file.displayPath),
    [file.displayPath],
  )

  useEffect(() => {
    if (!isFlashing) return
    const el = cardRef.current
    if (!el) return

    const handleAnimEnd = (e: Event) => {
      if (e.target === el) {
        onFlashEnd?.()
      }
    }

    el.addEventListener('animationend', handleAnimEnd)
    return () => {
      el.removeEventListener('animationend', handleAnimEnd)
    }
  }, [isFlashing, onFlashEnd])

  useEffect(() => {
    setExpanded(defaultExpanded)
  }, [defaultExpanded])

  const fetchFileContent = useCallback(async () => {
    if (!projectPath || fileLines !== null || isLoadingLines) return
    setIsLoadingLines(true)
    try {
      const lines = await loadFileLines(projectPath, file.displayPath, services)
      setFileLines(lines)
    } finally {
      setIsLoadingLines(false)
    }
  }, [projectPath, file.displayPath, fileLines, isLoadingLines, services])

  // Automatically fetch file lines when card is mounted to support line inspection
  useEffect(() => {
    if (projectPath && fileLines === null) {
      void fetchFileContent()
    }
  }, [projectPath, fileLines, fetchFileContent])

  const handleCopyPath = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (services?.ui?.writeClipboard) {
      void services.ui.writeClipboard(file.displayPath)
    } else if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(file.displayPath)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const toggleBanner = async (bannerKey: string) => {
    if (fileLines === null && projectPath) {
      void fetchFileContent()
    }
    setExpandedBanners((prev) => ({
      ...prev,
      [bannerKey]: !prev[bannerKey],
    }))
  }

  // Synchronized horizontal scrolling between left and right split panes across the whole card
  const handleLeftScroll = useCallback(() => {
    if (isSyncingRef.current) return
    isSyncingRef.current = true
    if (leftPaneRef.current && rightPaneRef.current) {
      rightPaneRef.current.scrollLeft = leftPaneRef.current.scrollLeft
    }
    requestAnimationFrame(() => {
      isSyncingRef.current = false
    })
  }, [])

  const handleRightScroll = useCallback(() => {
    if (isSyncingRef.current) return
    isSyncingRef.current = true
    if (leftPaneRef.current && rightPaneRef.current) {
      leftPaneRef.current.scrollLeft = rightPaneRef.current.scrollLeft
    }
    requestAnimationFrame(() => {
      isSyncingRef.current = false
    })
  }, [])

  const handleSplitWheel = useCallback((e: React.WheelEvent) => {
    if (Math.abs(e.deltaX) > 0) {
      if (leftPaneRef.current && rightPaneRef.current) {
        const nextLeft = leftPaneRef.current.scrollLeft + e.deltaX
        leftPaneRef.current.scrollLeft = nextLeft
        rightPaneRef.current.scrollLeft = nextLeft
      }
    }
  }, [])

  // Calculate trailing unmodified lines after the last hunk
  const lastHunk = file.hunks[file.hunks.length - 1]
  const lastHunkEnd = lastHunk ? lastHunk.newStart + lastHunk.newLines - 1 : 0
  const trailingUnmodifiedCount =
    fileLines && fileLines.length > lastHunkEnd ? fileLines.length - lastHunkEnd : 0

  return (
    <div
      ref={cardRef}
      id={id}
      data-testid={`diff-file-card-${file.displayPath}`}
      data-flashing={isFlashing ? 'true' : undefined}
      onAnimationEnd={onFlashEnd}
      className={cn(
        'group/card rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] overflow-hidden transition-all duration-150',
        isFlashing && 'animate-diff-card-flash transition-none z-10',
        className,
      )}
    >
      {/* File Header */}
      <div
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'flex h-10 w-full items-center justify-between px-3.5 select-none cursor-pointer',
          'bg-[var(--bg-card)] transition-colors',
          expanded && 'border-b border-[var(--border-subtle)]',
          'hover:bg-[var(--bg-sidebar-hover)]',
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <FileTypeIcon name={file.displayPath} className="size-4" />
          <span className="truncate font-mono text-[12.5px] font-medium text-[var(--text-primary)]">
            {file.displayPath}
          </span>

          {file.status === 'added' || file.status === 'untracked' ? (
            <span className="rounded bg-green-500/15 px-1.5 py-0.5 text-[10.5px] font-medium text-green-400">
              NEW
            </span>
          ) : file.status === 'deleted' ? (
            <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10.5px] font-medium text-red-400">
              DELETED
            </span>
          ) : file.status === 'renamed' ? (
            <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[10.5px] font-medium text-blue-400">
              RENAMED
            </span>
          ) : null}

          {/* Additions / Deletions count */}
          <div className="flex items-center gap-1.5 font-mono text-[11px] font-medium">
            {file.additions > 0 ? (
              <span className="text-[var(--accent-green)]">+{file.additions}</span>
            ) : null}
            {file.deletions > 0 ? (
              <span className="text-[#f87171]">-{file.deletions}</span>
            ) : null}
            {file.additions === 0 && file.deletions === 0 && !file.isBinary ? (
              <span className="text-[var(--text-muted)]">0</span>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleCopyPath}
            title={t('rightSidebar.files.copyPath')}
            className="flex size-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-white/10 hover:text-[var(--text-primary)]"
          >
            {copied ? (
              <Check className="size-3.5 text-green-400" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </button>

          <button
            type="button"
            aria-label={expanded ? t('rightSidebar.review.collapseAll') : t('rightSidebar.review.expandAll')}
            className="flex size-6 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            {expanded ? (
              <ChevronUp className="size-4" />
            ) : (
              <ChevronDown className="size-4" />
            )}
          </button>
        </div>
      </div>

      {/* File Diff Content */}
      {expanded ? (
        <div className="text-[12px] font-mono leading-5">
          {file.isBinary ? (
            <div className="p-6 text-center text-[var(--text-muted)]">
              {t('rightSidebar.review.binaryFile')}
            </div>
          ) : file.hunks.length === 0 ? (
            <div className="p-4 text-center text-[var(--text-muted)]">
              {file.status === 'added' || file.status === 'untracked'
                ? t('rightSidebar.review.empty')
                : t('rightSidebar.review.noChanges')}
            </div>
          ) : isSplitView ? (
            /* ================= SPLIT VIEW ================= */
            <div
              className="relative flex w-full overflow-hidden select-text"
              onWheel={handleSplitWheel}
            >
              {/* Left Pane (Old / Base Version) */}
              <div
                ref={leftPaneRef}
                onScroll={handleLeftScroll}
                className="w-1/2 min-w-0 overflow-x-auto scrollbar-thin"
              >
                <div className="min-w-full w-max">
                  {file.hunks.map((hunk, hunkIdx) => {
                    const showLeadingContext = hunkIdx === 0 && hunk.oldStart > 1
                    const leadingUnmodifiedCount = hunk.oldStart - 1
                    const leadingKey = `leading-${hunkIdx}`
                    const isLeadingExpanded = Boolean(expandedBanners[leadingKey])

                    let betweenUnmodifiedCount = 0
                    let betweenStartLine = 0
                    let betweenEndLine = 0
                    if (hunkIdx > 0) {
                      const prevHunk = file.hunks[hunkIdx - 1]
                      const prevEnd = prevHunk.oldStart + prevHunk.oldLines
                      if (hunk.oldStart > prevEnd) {
                        betweenUnmodifiedCount = hunk.oldStart - prevEnd
                        betweenStartLine = prevEnd
                        betweenEndLine = hunk.oldStart - 1
                      }
                    }
                    const betweenKey = `between-${hunkIdx}`
                    const isBetweenExpanded = Boolean(expandedBanners[betweenKey])
                    const splitRows = buildSplitRows(hunk.lines)

                    return (
                      <div key={hunkIdx}>
                        {/* Leading unmodified lines banner */}
                        {showLeadingContext ? (
                          <div>
                            <UnmodifiedBanner
                              count={leadingUnmodifiedCount}
                              isExpanded={isLeadingExpanded}
                              onClick={() => toggleBanner(leadingKey)}
                            />
                            {isLeadingExpanded ? (
                              <SplitSingleSideUnmodifiedLines
                                startLine={1}
                                endLine={leadingUnmodifiedCount}
                                fileLines={fileLines}
                                isLoading={isLoadingLines}
                                language={language}
                              />
                            ) : null}
                          </div>
                        ) : null}

                        {/* Between hunks unmodified lines banner */}
                        {betweenUnmodifiedCount > 0 ? (
                          <div>
                            <UnmodifiedBanner
                              count={betweenUnmodifiedCount}
                              isExpanded={isBetweenExpanded}
                              onClick={() => toggleBanner(betweenKey)}
                            />
                            {isBetweenExpanded ? (
                              <SplitSingleSideUnmodifiedLines
                                startLine={betweenStartLine}
                                endLine={betweenEndLine}
                                fileLines={fileLines}
                                isLoading={isLoadingLines}
                                language={language}
                              />
                            ) : null}
                          </div>
                        ) : null}

                        {/* Hunk Lines (Left Side) */}
                        <div className="w-full">
                          {splitRows.map((row, rowIdx) => {
                            const line = row.left
                            const isDel = line?.type === 'delete'

                            if (!line) {
                              return (
                                <div
                                  key={rowIdx}
                                  className="flex h-5.5 min-h-[22px] w-full items-center select-none bg-[var(--bg-app)]"
                                >
                                  <span className="w-11 shrink-0 px-2 py-0.5 text-right text-[11px] select-none border-r border-[var(--border-subtle)] opacity-30" />
                                  <span
                                    style={SPLIT_EMPTY_STRIPES_STYLE}
                                    className="h-full flex-1 min-w-full"
                                  />
                                </div>
                              )
                            }

                            return (
                              <div
                                key={rowIdx}
                                className={cn(
                                  'flex h-5.5 min-h-[22px] w-full items-center font-mono transition-colors',
                                  isDel && 'bg-[#3e1b1b]/50 text-red-200 hover:bg-[#3e1b1b]/70',
                                  !isDel && 'text-[var(--text-secondary)] hover:bg-white/[0.02]',
                                )}
                              >
                                <span
                                  className={cn(
                                    'w-11 shrink-0 px-2 py-0.5 text-right text-[11px] select-none border-r border-[var(--border-subtle)]',
                                    isDel ? 'text-red-400/80' : 'text-[var(--text-muted)] opacity-60',
                                  )}
                                >
                                  {line.oldLineNumber ?? ''}
                                </span>
                                <span
                                  className={cn(
                                    'w-5 shrink-0 text-center select-none font-bold text-[12px]',
                                    isDel ? 'text-red-400' : 'text-transparent',
                                  )}
                                >
                                  {isDel ? '-' : ' '}
                                </span>
                                <span
                                  className="flex-1 py-0.5 pr-3 pl-1 font-mono whitespace-pre overflow-hidden"
                                  dangerouslySetInnerHTML={{
                                    __html: highlightCodeLine(line.content, language),
                                  }}
                                />
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}

                  {/* Trailing unmodified lines (Left side) */}
                  {trailingUnmodifiedCount > 0 ? (
                    <div>
                      <UnmodifiedBanner
                        count={trailingUnmodifiedCount}
                        isExpanded={Boolean(expandedBanners['trailing'])}
                        onClick={() => toggleBanner('trailing')}
                      />
                      {expandedBanners['trailing'] ? (
                        <SplitSingleSideUnmodifiedLines
                          startLine={lastHunkEnd + 1}
                          endLine={fileLines?.length ?? lastHunkEnd + trailingUnmodifiedCount}
                          fileLines={fileLines}
                          isLoading={isLoadingLines}
                          language={language}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>

              {/* Fixed Distinct Vertical Divider */}
              <div
                data-testid="split-diff-center-divider"
                className="w-[1px] shrink-0 bg-[var(--border-subtle)] border-r border-[var(--border-subtle)] z-10 select-none"
              />

              {/* Right Pane (New / Head Version) */}
              <div
                ref={rightPaneRef}
                onScroll={handleRightScroll}
                className="w-1/2 min-w-0 overflow-x-auto scrollbar-thin"
              >
                <div className="min-w-full w-max">
                  {file.hunks.map((hunk, hunkIdx) => {
                    const showLeadingContext = hunkIdx === 0 && hunk.oldStart > 1
                    const leadingUnmodifiedCount = hunk.oldStart - 1
                    const leadingKey = `leading-${hunkIdx}`
                    const isLeadingExpanded = Boolean(expandedBanners[leadingKey])

                    let betweenUnmodifiedCount = 0
                    let betweenStartLine = 0
                    let betweenEndLine = 0
                    if (hunkIdx > 0) {
                      const prevHunk = file.hunks[hunkIdx - 1]
                      const prevEnd = prevHunk.oldStart + prevHunk.oldLines
                      if (hunk.oldStart > prevEnd) {
                        betweenUnmodifiedCount = hunk.oldStart - prevEnd
                        betweenStartLine = prevEnd
                        betweenEndLine = hunk.oldStart - 1
                      }
                    }
                    const betweenKey = `between-${hunkIdx}`
                    const isBetweenExpanded = Boolean(expandedBanners[betweenKey])
                    const splitRows = buildSplitRows(hunk.lines)

                    return (
                      <div key={hunkIdx}>
                        {/* Leading unmodified lines banner */}
                        {showLeadingContext ? (
                          <div>
                            <UnmodifiedBanner
                              count={leadingUnmodifiedCount}
                              isExpanded={isLeadingExpanded}
                              onClick={() => toggleBanner(leadingKey)}
                            />
                            {isLeadingExpanded ? (
                              <SplitSingleSideUnmodifiedLines
                                startLine={1}
                                endLine={leadingUnmodifiedCount}
                                fileLines={fileLines}
                                isLoading={isLoadingLines}
                                language={language}
                              />
                            ) : null}
                          </div>
                        ) : null}

                        {/* Between hunks unmodified lines banner */}
                        {betweenUnmodifiedCount > 0 ? (
                          <div>
                            <UnmodifiedBanner
                              count={betweenUnmodifiedCount}
                              isExpanded={isBetweenExpanded}
                              onClick={() => toggleBanner(betweenKey)}
                            />
                            {isBetweenExpanded ? (
                              <SplitSingleSideUnmodifiedLines
                                startLine={betweenStartLine}
                                endLine={betweenEndLine}
                                fileLines={fileLines}
                                isLoading={isLoadingLines}
                                language={language}
                              />
                            ) : null}
                          </div>
                        ) : null}

                        {/* Hunk Lines (Right Side) */}
                        <div className="w-full">
                          {splitRows.map((row, rowIdx) => {
                            const line = row.right
                            const isAdd = line?.type === 'add'

                            if (!line) {
                              return (
                                <div
                                  key={rowIdx}
                                  className="flex h-5.5 min-h-[22px] w-full items-center select-none bg-[var(--bg-app)]"
                                >
                                  <span className="w-11 shrink-0 px-2 py-0.5 text-right text-[11px] select-none border-r border-[var(--border-subtle)] opacity-30" />
                                  <span
                                    style={SPLIT_EMPTY_STRIPES_STYLE}
                                    className="h-full flex-1 min-w-full"
                                  />
                                </div>
                              )
                            }

                            return (
                              <div
                                key={rowIdx}
                                className={cn(
                                  'flex h-5.5 min-h-[22px] w-full items-center font-mono transition-colors',
                                  isAdd && 'bg-[#103823]/50 text-green-200 hover:bg-[#103823]/70',
                                  !isAdd && 'text-[var(--text-secondary)] hover:bg-white/[0.02]',
                                )}
                              >
                                <span
                                  className={cn(
                                    'w-11 shrink-0 px-2 py-0.5 text-right text-[11px] select-none border-r border-[var(--border-subtle)]',
                                    isAdd ? 'text-green-400/80' : 'text-[var(--text-muted)] opacity-60',
                                  )}
                                >
                                  {line.newLineNumber ?? ''}
                                </span>
                                <span
                                  className={cn(
                                    'w-5 shrink-0 text-center select-none font-bold text-[12px]',
                                    isAdd ? 'text-green-400' : 'text-transparent',
                                  )}
                                >
                                  {isAdd ? '+' : ' '}
                                </span>
                                <span
                                  className="flex-1 py-0.5 pr-3 pl-1 font-mono whitespace-pre overflow-hidden"
                                  dangerouslySetInnerHTML={{
                                    __html: highlightCodeLine(line.content, language),
                                  }}
                                />
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}

                  {/* Trailing unmodified lines (Right side) */}
                  {trailingUnmodifiedCount > 0 ? (
                    <div>
                      <UnmodifiedBanner
                        count={trailingUnmodifiedCount}
                        isExpanded={Boolean(expandedBanners['trailing'])}
                        onClick={() => toggleBanner('trailing')}
                      />
                      {expandedBanners['trailing'] ? (
                        <SplitSingleSideUnmodifiedLines
                          startLine={lastHunkEnd + 1}
                          endLine={fileLines?.length ?? lastHunkEnd + trailingUnmodifiedCount}
                          fileLines={fileLines}
                          isLoading={isLoadingLines}
                          language={language}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            /* ================= UNIFIED VIEW ================= */
            <div className="overflow-x-auto">
              <div className="min-w-full w-max">
                {file.hunks.map((hunk, hunkIdx) => {
                  const showLeadingContext = hunkIdx === 0 && hunk.oldStart > 1
                  const leadingUnmodifiedCount = hunk.oldStart - 1
                  const leadingKey = `leading-${hunkIdx}`
                  const isLeadingExpanded = Boolean(expandedBanners[leadingKey])

                  let betweenUnmodifiedCount = 0
                  let betweenStartLine = 0
                  let betweenEndLine = 0
                  if (hunkIdx > 0) {
                    const prevHunk = file.hunks[hunkIdx - 1]
                    const prevEnd = prevHunk.oldStart + prevHunk.oldLines
                    if (hunk.oldStart > prevEnd) {
                      betweenUnmodifiedCount = hunk.oldStart - prevEnd
                      betweenStartLine = prevEnd
                      betweenEndLine = hunk.oldStart - 1
                    }
                  }
                  const betweenKey = `between-${hunkIdx}`
                  const isBetweenExpanded = Boolean(expandedBanners[betweenKey])

                  return (
                    <div key={hunkIdx} className="group/hunk">
                      {showLeadingContext ? (
                        <div>
                          <UnmodifiedBanner
                            count={leadingUnmodifiedCount}
                            isExpanded={isLeadingExpanded}
                            onClick={() => toggleBanner(leadingKey)}
                          />
                          {isLeadingExpanded ? (
                            <ExpandedUnmodifiedLines
                              startLine={1}
                              endLine={leadingUnmodifiedCount}
                              fileLines={fileLines}
                              isLoading={isLoadingLines}
                              language={language}
                            />
                          ) : null}
                        </div>
                      ) : null}

                      {betweenUnmodifiedCount > 0 ? (
                        <div>
                          <UnmodifiedBanner
                            count={betweenUnmodifiedCount}
                            isExpanded={isBetweenExpanded}
                            onClick={() => toggleBanner(betweenKey)}
                          />
                          {isBetweenExpanded ? (
                            <ExpandedUnmodifiedLines
                              startLine={betweenStartLine}
                              endLine={betweenEndLine}
                              fileLines={fileLines}
                              isLoading={isLoadingLines}
                              language={language}
                            />
                          ) : null}
                        </div>
                      ) : null}

                      {/* Unified lines */}
                      <div className="w-full">
                        {hunk.lines.map((line, lineIdx) => {
                          const isAdd = line.type === 'add'
                          const isDelete = line.type === 'delete'

                          return (
                            <div
                              key={lineIdx}
                              className={cn(
                                'flex h-5.5 min-h-[22px] w-full items-center font-mono select-text transition-colors',
                                isAdd && 'bg-[#103823]/50 text-green-200 hover:bg-[#103823]/70',
                                isDelete && 'bg-[#3e1b1b]/50 text-red-200 hover:bg-[#3e1b1b]/70',
                                !isAdd && !isDelete && 'text-[var(--text-secondary)] hover:bg-white/[0.02]',
                              )}
                            >
                              {/* Old Line Number */}
                              <span
                                className={cn(
                                  'w-11 shrink-0 px-2 py-0.5 text-right text-[11px] select-none',
                                  isDelete ? 'text-red-400/80' : 'text-[var(--text-muted)] opacity-60',
                                )}
                              >
                                {line.oldLineNumber ?? ''}
                              </span>

                              {/* New Line Number */}
                              <span
                                className={cn(
                                  'w-11 shrink-0 px-2 py-0.5 text-right text-[11px] select-none border-r border-[var(--border-subtle)]',
                                  isAdd ? 'text-green-400/80' : 'text-[var(--text-muted)] opacity-60',
                                )}
                              >
                                {line.newLineNumber ?? ''}
                              </span>

                              {/* Sign / Gutter prefix */}
                              <span
                                className={cn(
                                  'w-5 shrink-0 text-center select-none font-bold text-[12px]',
                                  isAdd && 'text-green-400',
                                  isDelete && 'text-red-400',
                                  !isAdd && !isDelete && 'text-transparent',
                                )}
                              >
                                {isAdd ? '+' : isDelete ? '-' : ' '}
                              </span>

                              {/* Code content with syntax highlighting */}
                              <span
                                className="flex-1 py-0.5 pr-4 pl-1 font-mono whitespace-pre overflow-hidden"
                                dangerouslySetInnerHTML={{
                                  __html: highlightCodeLine(line.content, language),
                                }}
                              />
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}

                {/* Trailing unmodified lines (Unified) */}
                {trailingUnmodifiedCount > 0 ? (
                  <div>
                    <UnmodifiedBanner
                      count={trailingUnmodifiedCount}
                      isExpanded={Boolean(expandedBanners['trailing'])}
                      onClick={() => toggleBanner('trailing')}
                    />
                    {expandedBanners['trailing'] ? (
                      <ExpandedUnmodifiedLines
                        startLine={lastHunkEnd + 1}
                        endLine={fileLines?.length ?? lastHunkEnd + trailingUnmodifiedCount}
                        fileLines={fileLines}
                        isLoading={isLoadingLines}
                        language={language}
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Sticky centered unmodified banner.
 */
function UnmodifiedBanner({
  count,
  isExpanded = false,
  onClick,
}: {
  count: number
  isExpanded?: boolean
  onClick?: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      className={cn(
        'sticky left-0 flex h-7 w-full items-center justify-center gap-2 select-none cursor-pointer',
        'bg-[var(--bg-app)] border-b border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)]',
        'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] transition-colors z-20',
      )}
    >
      {isExpanded ? (
        <>
          <ChevronDown className="size-3 shrink-0" />
          <span>{t('rightSidebar.review.collapseUnmodifiedLines', { count })}</span>
        </>
      ) : (
        <>
          <ChevronUp className="size-3 shrink-0" />
          <span>{t('rightSidebar.review.unmodifiedLines', { count })}</span>
        </>
      )}
    </div>
  )
}

/**
 * Single-side Unmodified Code Lines in Split View.
 */
function SplitSingleSideUnmodifiedLines({
  startLine,
  endLine,
  fileLines,
  isLoading,
  language,
}: {
  startLine: number
  endLine: number
  fileLines: string[] | null
  isLoading: boolean
  language: string | null
}) {
  if (isLoading && !fileLines) {
    return (
      <div className="flex h-10 items-center justify-center gap-2 border-b border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)]">
        <RefreshCw className="size-3 animate-spin" />
        <span>Loading...</span>
      </div>
    )
  }

  const linesToRender: Array<{ lineNum: number; content: string }> = []
  for (let l = startLine; l <= endLine; l += 1) {
    const content = fileLines && l - 1 < fileLines.length ? fileLines[l - 1] : ''
    linesToRender.push({ lineNum: l, content })
  }

  return (
    <div className="w-full min-w-full bg-[var(--bg-app)] border-b border-[var(--border-subtle)]">
      {linesToRender.map(({ lineNum, content }) => (
        <div
          key={lineNum}
          className="flex h-5.5 min-h-[22px] w-full items-center font-mono select-text transition-colors text-[var(--text-secondary)] hover:bg-white/[0.02]"
        >
          <span className="w-11 shrink-0 px-2 py-0.5 text-right text-[11px] select-none border-r border-[var(--border-subtle)] text-[var(--text-muted)] opacity-60">
            {lineNum}
          </span>
          <span className="w-5 shrink-0 text-center select-none font-bold text-[12px] text-transparent">
            {' '}
          </span>
          <span
            className="flex-1 py-0.5 pr-3 pl-1 font-mono whitespace-pre overflow-hidden"
            dangerouslySetInnerHTML={{
              __html: highlightCodeLine(content, language),
            }}
          />
        </div>
      ))}
    </div>
  )
}

/**
 * Expanded Unmodified Code Lines in Unified View.
 */
function ExpandedUnmodifiedLines({
  startLine,
  endLine,
  fileLines,
  isLoading,
  language,
}: {
  startLine: number
  endLine: number
  fileLines: string[] | null
  isLoading: boolean
  language: string | null
}) {
  if (isLoading && !fileLines) {
    return (
      <div className="flex h-10 items-center justify-center gap-2 border-b border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)]">
        <RefreshCw className="size-3 animate-spin" />
        <span>Loading...</span>
      </div>
    )
  }

  const linesToRender: Array<{ lineNum: number; content: string }> = []
  for (let l = startLine; l <= endLine; l += 1) {
    const content = fileLines && l - 1 < fileLines.length ? fileLines[l - 1] : ''
    linesToRender.push({ lineNum: l, content })
  }

  return (
    <div className="w-full min-w-full bg-[var(--bg-app)] border-b border-[var(--border-subtle)]">
      {linesToRender.map(({ lineNum, content }) => (
        <div
          key={lineNum}
          className="flex h-5.5 min-h-[22px] w-full items-center font-mono select-text transition-colors text-[var(--text-secondary)] hover:bg-white/[0.02]"
        >
          {/* Old Line Number */}
          <span className="w-11 shrink-0 px-2 py-0.5 text-right text-[11px] select-none text-[var(--text-muted)] opacity-60">
            {lineNum}
          </span>

          {/* New Line Number */}
          <span className="w-11 shrink-0 px-2 py-0.5 text-right text-[11px] select-none border-r border-[var(--border-subtle)] text-[var(--text-muted)] opacity-60">
            {lineNum}
          </span>

          {/* Sign / Gutter prefix */}
          <span className="w-5 shrink-0 text-center select-none font-bold text-[12px] text-transparent">
            {' '}
          </span>

          {/* Code content with syntax highlighting */}
          <span
            className="flex-1 py-0.5 pr-4 pl-1 font-mono whitespace-pre overflow-hidden"
            dangerouslySetInnerHTML={{
              __html: highlightCodeLine(content, language),
            }}
          />
        </div>
      ))}
    </div>
  )
}
