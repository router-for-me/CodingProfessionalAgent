import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, FileEdit, Folder, GitBranch, GitFork, Monitor, Puzzle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { collectInvokedSkills } from '@/components/chat/skillPresentation'
import { useAgentStream } from '@/features/agent/useAgentStream'
import type { ConversationEntry } from '@/features/agent-runtime/session/types'
import { readGitRepoWithDefaultFs } from '@/lib/gitBranches'
import { getProjectPaths } from '@/lib/projectPaths'
import { useMessageStore } from '@/stores/messageStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import {
  useFileChangeStore,
  syncFileChangesFromEntries,
  EMPTY_SESSION_CHANGES,
} from '@/stores/fileChangeStore'
import { useUiStore } from '@/stores/uiStore'
import { useWorktreeSetupStore } from '@/stores/worktreeSetupStore'
import { usePanelTabs } from '@/plugins/registry/usePanelTabs'
import { ExtensionSlot } from '@/plugins/registry/ExtensionSlot'

export type TodoStatus = 'not-started' | 'in-progress' | 'completed'

export interface TodoItem {
  id: number
  title: string
  description: string
  status: TodoStatus
}

function extractTodosFromEntries(
  entries: readonly ConversationEntry[] | undefined | null
): TodoItem[] | null {
  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    return null
  }
  const errorToolCallIds = new Set<string>()
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as Record<string, unknown> | undefined
    if (!entry) continue
    if (entry.kind === 'toolResult') {
      const toolCallId = String(entry.toolCallId || '')
      if (entry.isError === true && toolCallId) {
        errorToolCallIds.add(toolCallId)
      }
    }
  }

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as Record<string, unknown> | undefined
    if (!entry || entry.status === 'streaming') continue

    const content = (entry.content ?? entry.parts) as unknown[] | undefined
    if (!Array.isArray(content)) continue

    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j] as Record<string, unknown> | undefined
      if (!block) continue

      const blockType = block.type
      const name = block.name ?? block.toolName
      const callId = String(block.id ?? '')

      if (callId && errorToolCallIds.has(callId)) continue
      if (
        (blockType === 'toolCall' || blockType === 'tool_call') &&
        (name === 'todo' || name === 'manage_todo_list')
      ) {
        let rawArgs = block.arguments ?? block.args
        if (typeof rawArgs === 'string') {
          try {
            rawArgs = JSON.parse(rawArgs)
          } catch {
            rawArgs = null
          }
        }
        if (rawArgs && typeof rawArgs === 'object') {
          const argsObj = rawArgs as Record<string, unknown>
          if (argsObj.operation === 'write' && Array.isArray(argsObj.todoList)) {
            const rawList = argsObj.todoList
            const validatedTodos: TodoItem[] = []
            for (let k = 0; k < rawList.length; k++) {
              const item = rawList[k]
              if (!item || typeof item !== 'object') continue
              const raw = item as Record<string, unknown>
              const id = typeof raw.id === 'number' ? raw.id : k + 1
              const title =
                typeof raw.title === 'string' && raw.title.trim().length > 0
                  ? raw.title.trim()
                  : `Task ${id}`
              const description =
                typeof raw.description === 'string' ? raw.description : ''
              const statusStr = String(raw.status ?? '').toLowerCase()
              const status: TodoStatus =
                statusStr === 'completed' ||
                statusStr === 'in-progress' ||
                statusStr === 'not-started'
                  ? statusStr
                  : 'not-started'
              validatedTodos.push({ id, title, description, status })
            }
            return validatedTodos
          }
        }
      }
    }
  }
  return null
}

const EMPTY_ENTRIES: ConversationEntry[] = []
const EMPTY_TODOS: TodoItem[] = []

function rectsOverlap(a: DOMRectReadOnly, b: DOMRectReadOnly): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

function isPinnedSummaryToggle(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest('[data-testid="pinned-summary-toggle"]'))
  )
}

export function PinnedSummary({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation()
  const sessions = useSessionStore((state) => state.sessions)
  const projects = useProjectStore((state) => state.projects)
  const pending = useUiStore((state) => state.pendingSessionContext)
  const setRightSidebarCollapsed = useUiStore(
    (state) => state.setRightSidebarCollapsed,
  )
  const openRightPanelTab = useUiStore((state) => state.openRightPanelTab)
  const panelTabs = usePanelTabs()
  const setPinnedSummaryVisible = useUiStore(
    (state) => state.setPinnedSummaryVisible,
  )
  const rootRef = useRef<HTMLElement>(null)
  const { skills } = useAgentStream()
  const entries = useMessageStore((state) =>
    sessionId
      ? (state.entriesBySession[sessionId] ?? EMPTY_ENTRIES)
      : EMPTY_ENTRIES,
  )
  const invokedSkills = useMemo(
    () => collectInvokedSkills(entries, skills),
    [entries, skills],
  )

  const session = useMemo(
    () => sessions.find((item) => item.id === sessionId) ?? null,
    [sessions, sessionId],
  )
  const worktreeSetup = useWorktreeSetupStore((state) =>
    sessionId ? state.setups[sessionId] : undefined,
  )
  const isWorktree = session
    ? session.workLocation === 'worktree' ||
      Boolean(session.worktreePath) ||
      Boolean(worktreeSetup)
    : pending.workLocation === 'worktree'
  const worktreePath =
    session?.worktreePath ||
    session?.worktreeSetup?.worktreePath ||
    worktreeSetup?.worktreePath
  const worktreeBranch =
    session?.branch ||
    session?.worktreeSetup?.branch ||
    worktreeSetup?.branch ||
    pending.branch

  const projectId = session?.projectId ?? pending.projectId
  const branch = session?.branch ?? pending.branch
  const project = useMemo(
    () => projects.find((item) => item.id === projectId) ?? null,
    [projects, projectId],
  )
  const projectPath = project ? (getProjectPaths(project)[0] ?? '') : ''

  const [projectRepoBranch, setProjectRepoBranch] = useState<string | null>(null)
  const [envOpen, setEnvOpen] = useState(true)
  const [todosOpen, setTodosOpen] = useState(true)
  const [sourcesOpen, setSourcesOpen] = useState(true)

  useEffect(() => {
    if (!projectPath) {
      setProjectRepoBranch(null)
      return
    }
    let cancelled = false
    void readGitRepoWithDefaultFs([projectPath])
      .then((info) => {
        if (!cancelled) {
          setProjectRepoBranch(info?.current ?? null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectRepoBranch(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  const originBranch =
    session?.baseBranch ||
    session?.worktreeSetup?.baseBranch ||
    worktreeSetup?.baseBranch ||
    projectRepoBranch ||
    t('pinnedSummary.noBranch')

  const workingBranch = branch || projectRepoBranch || t('pinnedSummary.noBranch')

  const fileChanges = useFileChangeStore((state) =>
    sessionId
      ? (state.changesBySession[sessionId] ?? EMPTY_SESSION_CHANGES)
      : EMPTY_SESSION_CHANGES,
  )
  const todos = useMemo(() => extractTodosFromEntries(entries) ?? EMPTY_TODOS, [entries])
  const currentStep = useMemo(() => {
    const totalCount = todos.length
    if (totalCount === 0) return 0
    const completedCount = todos.filter((item) => item.status === 'completed').length
    const inProgressIndex = todos.findIndex((item) => item.status === 'in-progress')

    if (inProgressIndex !== -1) {
      return inProgressIndex + 1
    }
    if (completedCount === totalCount) {
      return totalCount
    }
    return Math.min(completedCount + 1, totalCount)
  }, [todos])

  useEffect(() => {
    if (!sessionId) return
    const currentChanges = useFileChangeStore.getState().changesBySession[sessionId]
    if (!currentChanges) {
      const currentEntries = useMessageStore.getState().getEntries(sessionId)
      if (currentEntries && currentEntries.length > 0) {
        syncFileChangesFromEntries(sessionId, currentEntries)
      }
    }
  }, [sessionId])

  // When the floating card covers the transcript, treat it as a popover:
  // any later click dismisses it and restores the toggle pressed style.
  // The toggle owns open/close so its own click must not dismiss the card.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const onClick = (event: MouseEvent) => {
      if (isPinnedSummaryToggle(event.target)) return
      const messageList = document.querySelector(
        '[data-testid="message-list-content"]',
      )
      if (!(messageList instanceof HTMLElement)) return
      if (
        !rectsOverlap(
          root.getBoundingClientRect(),
          messageList.getBoundingClientRect(),
        )
      ) {
        return
      }
      setPinnedSummaryVisible(false)
    }

    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [setPinnedSummaryVisible])

  return (
    <aside
      ref={rootRef}
      data-testid="pinned-summary"
      className={cn(
        'pointer-events-auto w-[280px] overflow-hidden rounded-2xl',
        'border border-[var(--border-subtle)] bg-[var(--bg-elevated)]',
        'shadow-[0_12px_40px_rgba(0,0,0,0.35)]',
      )}
    >
      <section className="px-3 pt-2.5 pb-2">
        <h2 className="mb-1">
          <button
            type="button"
            onClick={() => setEnvOpen((open) => !open)}
            aria-expanded={envOpen}
            aria-controls="pinned-summary-env-content"
            className="flex w-full cursor-pointer items-center justify-between px-1 py-0.5 text-left text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] select-none rounded"
          >
            <span>{t('pinnedSummary.environment')}</span>
            <ChevronDown
              className={cn(
                'size-3.5 shrink-0 text-[var(--text-muted)] transition-transform duration-150',
                !envOpen && '-rotate-90',
              )}
              aria-hidden
            />
          </button>
        </h2>
        {envOpen ? (
          <div id="pinned-summary-env-content">
            <SummaryRow
              icon={FileEdit}
              label={t('pinnedSummary.changes', 'Changes')}
              data-testid="pinned-summary-changes-row"
              onClick={() => {
                const changesTabId = panelTabs.find((p) => p.id.includes('review') || p.id.includes('changes') || p.id.includes('diff'))?.id ?? 'review'
                openRightPanelTab(changesTabId, { activate: true })
                setRightSidebarCollapsed(false)
              }}
              detail={
                fileChanges.totalAdditions > 0 || fileChanges.totalDeletions > 0 ? (
                  <span
                    data-testid="pinned-summary-changes-stats"
                    className="inline-flex items-center gap-1 font-mono text-[11.5px] font-semibold"
                  >
                    {fileChanges.totalAdditions > 0 ? (
                      <span className="text-[var(--accent-green)]">
                        +{fileChanges.totalAdditions}
                      </span>
                    ) : null}
                    {fileChanges.totalDeletions > 0 ? (
                      <span className="text-[#f87171]">
                        -{fileChanges.totalDeletions}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span
                    data-testid="pinned-summary-changes-stats"
                    className="font-mono text-[11.5px] text-[var(--text-muted)] font-normal"
                  >
                    +0 -0
                  </span>
                )
              }
            />
            <SummaryRow
              icon={Monitor}
              label={
                isWorktree
                  ? t('pinnedSummary.worktree', 'Worktree')
                  : t('pinnedSummary.local')
              }
              detail={project?.name ?? t('pinnedSummary.noProject')}
            />
            {projectPath ? <SummaryRow icon={Folder} label={projectPath} /> : null}
            <SummaryRow
              icon={GitBranch}
              label={isWorktree ? originBranch : workingBranch}
            />
            {isWorktree ? (
              <SummaryRow
                icon={GitFork}
                label={worktreeBranch || t('pinnedSummary.noBranch')}
                title={worktreePath || undefined}
              />
            ) : null}
          </div>
        ) : null}
      </section>

      <ExtensionSlot
        name="pinned.summary.subagents"
        props={{ sessionId }}
      />

      {todos.length > 0 && sessionId ? (
        <section
          data-testid="pinned-summary-todos"
          className="border-t border-[var(--border-subtle)] px-3 pt-2 pb-2.5"
        >
          <div className="mb-1">
            <h2>
              <button
                type="button"
                onClick={() => setTodosOpen((open) => !open)}
                aria-expanded={todosOpen}
                aria-controls="pinned-summary-todos-content"
                className="flex w-full cursor-pointer items-center justify-between px-1 py-0.5 text-left text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] select-none rounded"
              >
                <span>{t('pinnedSummary.todos')}</span>
                <div className="flex items-center gap-1.5">
                  <span
                    data-testid="pinned-summary-todo-progress"
                    className="text-[11px] text-[var(--text-muted)] font-normal"
                  >
                    {currentStep}/{todos.length}
                  </span>
                  <ChevronDown
                    className={cn(
                      'size-3.5 shrink-0 text-[var(--text-muted)] transition-transform duration-150',
                      !todosOpen && '-rotate-90',
                    )}
                    aria-hidden
                  />
                </div>
              </button>
            </h2>
          </div>
          {todosOpen ? (
            <ul id="pinned-summary-todos-content" className="flex flex-col gap-1">
              {todos.map((todo) => (
                <li
                  key={todo.id}
                  data-testid={`pinned-summary-todo-${todo.id}`}
                  className="flex items-center gap-2 rounded-lg px-1 py-0.5 text-[13px]"
                >
                  <TodoStatusIcon status={todo.status} />
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate',
                      todo.status === 'completed' &&
                        'text-[var(--text-muted)]',
                      todo.status === 'in-progress' &&
                        'font-medium text-[var(--text-primary)]',
                      todo.status === 'not-started' &&
                        'text-[var(--text-secondary)]',
                    )}
                    title={
                      todo.description
                        ? `${todo.title} - ${todo.description}`
                        : todo.title
                    }
                  >
                    {todo.title}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {invokedSkills.length > 0 ? (
        <section className="border-t border-[var(--border-subtle)] px-3 pt-2 pb-2.5">
          <h2 className="mb-1">
            <button
              type="button"
              onClick={() => setSourcesOpen((open) => !open)}
              aria-expanded={sourcesOpen}
              aria-controls="pinned-summary-sources-content"
              className="flex w-full cursor-pointer items-center justify-between px-1 py-0.5 text-left text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] select-none rounded"
            >
              <span>{t('pinnedSummary.sources')}</span>
              <ChevronDown
                className={cn(
                  'size-3.5 shrink-0 text-[var(--text-muted)] transition-transform duration-150',
                  !sourcesOpen && '-rotate-90',
                )}
                aria-hidden
              />
            </button>
          </h2>
          {sourcesOpen ? (
            <ul id="pinned-summary-sources-content" className="flex flex-col gap-0.5">
              {invokedSkills.map((skill) => (
                <li
                  key={skill.name}
                  className="flex items-center gap-2 rounded-lg px-1 py-1 text-[13px] text-[var(--text-primary)]"
                >
                  <Puzzle
                    className="size-3.5 shrink-0 text-[var(--text-muted)]"
                    strokeWidth={1.75}
                    aria-hidden
                  />
                  <span className="truncate">{skill.displayName}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </aside>
  )
}

function TodoStatusIcon({ status }: { status: TodoStatus }) {
  if (status === 'completed') {
    return (
      <span
        data-testid="todo-status-completed"
        className="flex size-3.5 shrink-0 items-center justify-center rounded-full border border-neutral-500/60 bg-neutral-700/40 text-[9px] font-bold text-neutral-300 select-none"
      >
        ✓
      </span>
    )
  }
  if (status === 'in-progress') {
    return (
      <span
        data-testid="todo-status-in-progress"
        className="flex size-3.5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-neutral-200 bg-transparent select-none"
      />
    )
  }
  return (
    <span
      data-testid="todo-status-not-started"
      className="flex size-3.5 shrink-0 items-center justify-center rounded-full border border-neutral-600 bg-transparent select-none"
    />
  )
}

function SummaryRow({
  icon: Icon,
  label,
  detail,
  title,
  onClick,
  'data-testid': testId,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean | 'true' | 'false' }>
  label: string
  detail?: React.ReactNode
  title?: string
  onClick?: () => void
  'data-testid'?: string
}) {
  const isClickable = Boolean(onClick)
  return (
    <div
      title={title}
      data-testid={testId}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        isClickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick?.()
              }
            }
          : undefined
      }
      className={cn(
        'flex items-center gap-2 rounded-lg px-1 py-1 text-[13px] text-[var(--text-primary)]',
        isClickable &&
          'cursor-pointer transition-colors hover:bg-[var(--bg-sidebar-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-blue)]/40',
      )}
    >
      <Icon
        className="size-3.5 shrink-0 text-[var(--text-muted)]"
        strokeWidth={1.75}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail ? (
        <div className="max-w-[46%] truncate text-[12px] text-[var(--text-muted)]">
          {detail}
        </div>
      ) : null}
    </div>
  )
}
