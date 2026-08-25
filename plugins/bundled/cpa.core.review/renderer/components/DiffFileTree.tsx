import { useCallback, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Search,
  X,
  PanelResizeHandle,
  FileTypeIcon,
  useTranslation,
  cn,
} from '@cpa/plugin-ui'
import type { GitDiffFile } from '../utils/gitDiff.js'

export const DEFAULT_DIFF_TREE_WIDTH = 240
export const MIN_DIFF_TREE_WIDTH = 160
export const MAX_DIFF_TREE_WIDTH = 480

export interface DiffFileTreeProps {
  files: GitDiffFile[]
  selectedFilePath: string | null
  onSelectFile: (file: GitDiffFile) => void
  open?: boolean
  transition?: boolean
  className?: string
}

interface TreeNode {
  name: string
  fullPath: string
  isDir: boolean
  file?: GitDiffFile
  children: TreeNode[]
}

function buildTree(files: GitDiffFile[]): TreeNode[] {
  const root: TreeNode = {
    name: '',
    fullPath: '',
    isDir: true,
    children: [],
  }

  for (const file of files) {
    const parts = file.displayPath.split('/')
    let current = root

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]
      const isLast = i === parts.length - 1
      const currentPath = parts.slice(0, i + 1).join('/')

      let existing = current.children.find((c) => c.name === part)
      if (!existing) {
        existing = {
          name: part,
          fullPath: currentPath,
          isDir: !isLast,
          file: isLast ? file : undefined,
          children: [],
        }
        current.children.push(existing)
      }
      current = existing
    }
  }

  // Helper to compact single-child directories (e.g., runtime -> executor => runtime / executor)
  function compactDirectories(nodes: TreeNode[]): TreeNode[] {
    return nodes.map((node) => {
      if (node.isDir) {
        let compactedNode = { ...node }
        while (
          compactedNode.children.length === 1 &&
          compactedNode.children[0].isDir
        ) {
          const onlyChild = compactedNode.children[0]
          compactedNode = {
            name: `${compactedNode.name} / ${onlyChild.name}`,
            fullPath: onlyChild.fullPath,
            isDir: true,
            children: onlyChild.children,
          }
        }
        compactedNode.children = compactDirectories(compactedNode.children)
        return compactedNode
      }
      return node
    })
  }

  return compactDirectories(root.children)
}

export function DiffFileTree({
  files,
  selectedFilePath,
  onSelectFile,
  open = true,
  transition = false,
  className,
}: DiffFileTreeProps) {
  const { t } = useTranslation()
  const [filterText, setFilterText] = useState('')
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({})
  const [treeWidth, setTreeWidth] = useState(DEFAULT_DIFF_TREE_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const asideRef = useRef<HTMLElement>(null)

  const handleResize = useCallback((clientX: number) => {
    if (!asideRef.current) return
    const right = asideRef.current.getBoundingClientRect().right
    const newWidth = Math.min(MAX_DIFF_TREE_WIDTH, Math.max(MIN_DIFF_TREE_WIDTH, right - clientX))
    setTreeWidth(newWidth)
  }, [])

  const filteredFiles = useMemo(() => {
    if (!filterText.trim()) return files
    const query = filterText.toLowerCase()
    return files.filter((f) => f.displayPath.toLowerCase().includes(query))
  }, [files, filterText])

  const tree = useMemo(() => buildTree(filteredFiles), [filteredFiles])

  // By default expand all directory nodes
  const isDirExpanded = (path: string) => expandedDirs[path] ?? true

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => ({
      ...prev,
      [path]: !isDirExpanded(path),
    }))
  }

  return (
    <aside
      ref={asideRef}
      data-testid="diff-file-tree"
      data-state={open ? 'open' : 'closed'}
      aria-hidden={!open}
      inert={!open ? true : undefined}
      className={cn(
        'relative flex h-full shrink-0 flex-col overflow-hidden bg-[var(--bg-card)]',
        open && 'border-l border-[var(--border-subtle)]',
        // Keep open/close animation, but disable width transition while dragging
        // so the panel edge tracks the pointer instead of lagging behind content reflow.
        transition && !isResizing && 'transition-[width] duration-200 ease-out',
        className,
      )}
      style={{ width: open ? treeWidth : 0 }}
    >
      <div
        className="flex h-full min-h-0 shrink-0 flex-col bg-[var(--bg-card)] select-none"
        style={{ width: treeWidth }}
      >
        {/* Search / Filter Input */}
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] px-2.5">
          <Search className="size-3.5 shrink-0 text-[var(--text-muted)]" />
          <input
            type="text"
            data-testid="diff-tree-filter-input"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder={t('rightSidebar.files.searchPlaceholder')}
            className={cn(
              'min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text-primary)] outline-none',
              'placeholder:text-[var(--text-muted)]',
            )}
          />
          {filterText ? (
            <button
              type="button"
              onClick={() => setFilterText('')}
              className="flex size-4 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>

        {/* Tree Content */}
        <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-0.5">
          {tree.length === 0 ? (
            <div className="p-4 text-center text-[12px] text-[var(--text-muted)]">
              {t('rightSidebar.files.noFiles')}
            </div>
          ) : (
            tree.map((node) => (
              <TreeNodeItem
                key={node.fullPath}
                node={node}
                level={0}
                selectedFilePath={selectedFilePath}
                isDirExpanded={isDirExpanded}
                onToggleDir={toggleDir}
                onSelectFile={onSelectFile}
              />
            ))
          )}
        </div>

        {/* Summary Footer */}
        <div className="flex h-7 shrink-0 items-center justify-between border-t border-[var(--border-subtle)] px-3 text-[11px] text-[var(--text-muted)]">
          <span>{t('rightSidebar.review.filesChanged', { count: files.length })}</span>
        </div>
      </div>
      {open && (
        <PanelResizeHandle
          label={t('rightSidebar.review.resizeFileTree')}
          width={treeWidth}
          min={MIN_DIFF_TREE_WIDTH}
          max={MAX_DIFF_TREE_WIDTH}
          edge="left"
          onResize={handleResize}
          onDraggingChange={setIsResizing}
        />
      )}
    </aside>
  )
}

function TreeNodeItem({
  node,
  level,
  selectedFilePath,
  isDirExpanded,
  onToggleDir,
  onSelectFile,
}: {
  node: TreeNode
  level: number
  selectedFilePath?: string | null
  isDirExpanded: (path: string) => boolean
  onToggleDir: (path: string) => void
  onSelectFile: (file: GitDiffFile) => void
}) {
  const isSelected = selectedFilePath === node.file?.displayPath
  const expanded = isDirExpanded(node.fullPath)

  if (node.isDir) {
    return (
      <div>
        <button
          type="button"
          data-testid={`diff-tree-dir-${node.fullPath}`}
          onClick={() => onToggleDir(node.fullPath)}
          style={{ paddingLeft: `${6 + level * 12}px` }}
          className={cn(
            'flex h-6.5 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12px] transition-colors',
            'text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
          )}
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-[var(--text-muted)]" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-[var(--text-muted)]" />
          )}
          <span className="truncate">{node.name}</span>
        </button>

        {expanded ? (
          <div className="space-y-0.5">
            {node.children.map((child) => (
              <TreeNodeItem
                key={child.fullPath}
                node={child}
                level={level + 1}
                selectedFilePath={selectedFilePath}
                isDirExpanded={isDirExpanded}
                onToggleDir={onToggleDir}
                onSelectFile={onSelectFile}
              />
            ))}
          </div>
        ) : null}
      </div>
    )
  }

  const file = node.file!
  const statusColor =
    file.status === 'added'
      ? 'bg-green-400'
      : file.status === 'deleted'
        ? 'bg-red-400'
        : file.status === 'renamed'
          ? 'bg-blue-400'
          : 'bg-amber-400'

  return (
    <button
      type="button"
      data-testid={`tree-file-${file.displayPath}`}
      onClick={() => onSelectFile(file)}
      style={{ paddingLeft: `${6 + level * 12}px` }}
      className={cn(
        'group flex h-6.5 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12px] transition-colors',
        isSelected
          ? 'bg-white/[0.08] text-[var(--text-primary)] font-medium'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      <FileTypeIcon name={node.name} className="size-3.5" />
      <span className="truncate flex-1 font-mono text-[11.5px]">{node.name}</span>

      {/* Changed status dot / badge */}
      <span
        title={file.status}
        className={cn('size-1.5 shrink-0 rounded-full', statusColor)}
      />
    </button>
  )
}
