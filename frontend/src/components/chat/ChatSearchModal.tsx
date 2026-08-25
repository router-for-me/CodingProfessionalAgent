import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Folder, GitFork, Search, SquarePen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import {
  executeNewChatAction,
  executeOpenFolderAction,
} from '@/features/shortcuts/useAppKeyboardShortcuts'
import {
  searchChats,
  splitHighlightSegments,
  type ChatSearchResultItem,
} from '@/features/search/searchChats'
import { useMessageStore } from '@/stores/messageStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useUiStore } from '@/stores/uiStore'

interface QuickActionItem {
  id: string
  icon: typeof SquarePen
  label: string
  shortcut: string
  action: () => void
}

/**
 * Command-palette style chat search modal.
 * Searches across session titles and message contents with title-matching prioritized.
 */
export function ChatSearchModal() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const searchOpen = useUiStore((s) => s.searchOpen)
  const setSearchOpen = useUiStore((s) => s.setSearchOpen)
  const pushToast = useUiStore((s) => s.pushToast)

  const sessions = useSessionStore((s) => s.sessions)
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession)
  const projects = useProjectStore((s) => s.projects)
  const entriesBySession = useMessageStore((s) => s.entriesBySession)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ChatSearchResultItem[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [searching, setSearching] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Map project names for quick lookup
  const projectMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const project of projects) {
      map.set(project.id, project.name)
    }
    return map
  }, [projects])

  // Quick actions available when query is empty
  const quickActions: QuickActionItem[] = useMemo(
    () => [
      {
        id: 'new-chat',
        icon: SquarePen,
        label: t('search.newChat', 'New chat'),
        shortcut: '⌘N',
        action: () => {
          setSearchOpen(false)
          executeNewChatAction(navigate)
        },
      },
      {
        id: 'open-folder',
        icon: Folder,
        label: t('search.openFolder', 'Open folder'),
        shortcut: '⌘O',
        action: () => {
          setSearchOpen(false)
          executeOpenFolderAction()
        },
      },
      {
        id: 'search-files',
        icon: Search,
        label: t('search.searchFiles', 'Search files'),
        shortcut: '⌘P',
        action: () => {
          setSearchOpen(false)
          pushToast(t('toast.comingSoon', 'Coming soon'))
        },
      },
    ],
    [navigate, pushToast, setSearchOpen, t],
  )

  // Execute search when query or sessions change
  useEffect(() => {
    if (!searchOpen) return

    let cancelled = false
    setSearching(true)

    void searchChats({
      query,
      sessions,
      entriesBySession,
      limit: 30,
    })
      .then((items) => {
        if (!cancelled) {
          setResults(items)
          setSelectedIndex(0)
          setSearching(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSearching(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [query, sessions, entriesBySession, searchOpen])

  // Focus input and reset state when opened
  useEffect(() => {
    if (searchOpen) {
      setQuery('')
      setSelectedIndex(0)
      requestAnimationFrame(() => {
        inputRef.current?.focus()
      })
    }
  }, [searchOpen])

  const isQueryEmpty = query.trim().length === 0
  const totalSelectableCount = isQueryEmpty
    ? results.length + quickActions.length
    : results.length

  // Navigate to selected session
  const selectSession = useCallback(
    (sessionId: string) => {
      setSearchOpen(false)
      setCurrentSession(sessionId)
      const targetSession = sessions.find((s) => s.id === sessionId)
      if (targetSession?.rightSidebar) {
        useUiStore.getState().restoreForSession(targetSession.rightSidebar)
      }
      void navigate({
        to: '/chat/$sessionId',
        params: { sessionId },
      } as any)
    },
    [navigate, setCurrentSession, setSearchOpen, sessions],
  )

  // Handle keyboard navigation and shortcuts
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setSearchOpen(false)
      return
    }

    // Direct Cmd+1 ~ Cmd+9 navigation
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      const num = parseInt(e.key, 10)
      if (num >= 1 && num <= 9) {
        const targetResult = results[num - 1]
        if (targetResult) {
          e.preventDefault()
          selectSession(targetResult.sessionId)
          return
        }
      }
      if (e.key.toLowerCase() === 'n') {
        e.preventDefault()
        quickActions[0]?.action()
        return
      }
      if (e.key.toLowerCase() === 'o') {
        e.preventDefault()
        quickActions[1]?.action()
        return
      }
      if (e.key.toLowerCase() === 'p') {
        e.preventDefault()
        quickActions[2]?.action()
        return
      }
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (totalSelectableCount === 0) return
      setSelectedIndex((prev) => (prev + 1) % totalSelectableCount)
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (totalSelectableCount === 0) return
      setSelectedIndex((prev) =>
        prev <= 0 ? totalSelectableCount - 1 : prev - 1,
      )
      return
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      if (selectedIndex < results.length) {
        const item = results[selectedIndex]
        if (item) {
          selectSession(item.sessionId)
        }
      } else if (isQueryEmpty) {
        const actionIndex = selectedIndex - results.length
        const action = quickActions[actionIndex]
        if (action) {
          action.action()
        }
      }
    }
  }

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return
    const activeEl = listRef.current.querySelector('[data-selected="true"]')
    if (activeEl && typeof activeEl.scrollIntoView === 'function') {
      activeEl.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  if (!searchOpen) {
    return null
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('search.placeholder', 'Search chats')}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-in fade-in duration-150"
      onClick={() => setSearchOpen(false)}
      onKeyDown={handleKeyDown}
    >
      <div
        className="relative flex w-full max-w-[600px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#1e1e20] p-3 text-[var(--text-primary)] shadow-2xl transition-all"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Top Input Bar */}
        <div className="flex items-center px-2 py-1">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search.placeholder', 'Search chats')}
            className="w-full bg-transparent text-[15px] font-normal text-white outline-none placeholder:text-neutral-500"
            aria-autocomplete="list"
          />
        </div>

        {/* Results & Actions List */}
        <div
          ref={listRef}
          className="mt-2 max-h-[460px] overflow-y-auto pr-0.5 space-y-3 select-none"
        >
          {/* Chats Group */}
          <div>
            <div className="px-2 pb-1 text-xs font-medium text-neutral-400">
              {t('search.chats', 'Chats')}
            </div>

            {results.length === 0 && !searching && (
              <div className="py-6 text-center text-xs text-neutral-500">
                {t('search.noResults', 'No matching chats found')}
              </div>
            )}

            <div className="space-y-0.5">
              {results.map((item, index) => {
                const isSelected = selectedIndex === index
                const projectName = item.projectId
                  ? projectMap.get(item.projectId)
                  : undefined
                const hasBranchOrFork = Boolean(item.branch)
                const shortcutKey = index < 9 ? `⌘${index + 1}` : undefined

                return (
                  <div
                    key={item.sessionId}
                    data-selected={isSelected}
                    role="button"
                    tabIndex={0}
                    onClick={() => selectSession(item.sessionId)}
                    className={cn(
                      'group flex flex-col rounded-lg px-2.5 py-1.5 transition-colors cursor-pointer',
                      isSelected
                        ? 'bg-white/10 text-white'
                        : 'text-neutral-300 hover:bg-white/5',
                    )}
                  >
                    {/* First line: Icon + Title + Project + Shortcut */}
                    <div className="flex items-center gap-2">
                      {hasBranchOrFork ? (
                        <GitFork
                          className="size-3.5 shrink-0 text-purple-400"
                          aria-hidden
                        />
                      ) : null}
                      <span className="min-w-0 flex-1 truncate text-[13px]">
                        {query.trim() ? (
                          <HighlightedText
                            text={item.title}
                            query={query.trim()}
                          />
                        ) : (
                          item.title
                        )}
                      </span>

                      {projectName ? (
                        <span className="max-w-[120px] truncate text-xs text-neutral-400">
                          {projectName}
                        </span>
                      ) : null}

                      {shortcutKey ? (
                        <kbd className="shrink-0 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-neutral-400">
                          {shortcutKey}
                        </kbd>
                      ) : null}
                    </div>

                    {/* Second line: Snippet when query matched content */}
                    {item.snippet && query.trim() ? (
                      <div className="mt-0.5 truncate pl-0.5 text-xs text-neutral-400">
                        <HighlightedText
                          text={item.snippet}
                          query={query.trim()}
                        />
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Quick Actions Group (shown when query is empty) */}
          {isQueryEmpty && (
            <div>
              <div className="px-2 pt-1 pb-1 text-xs font-medium text-neutral-400">
                {t('search.quickActions', 'Quick actions')}
              </div>
              <div className="space-y-0.5">
                {quickActions.map((action, index) => {
                  const actionIndex = results.length + index
                  const isSelected = selectedIndex === actionIndex
                  const Icon = action.icon

                  return (
                    <div
                      key={action.id}
                      data-selected={isSelected}
                      role="button"
                      tabIndex={0}
                      onClick={action.action}
                      className={cn(
                        'flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors cursor-pointer',
                        isSelected
                          ? 'bg-white/10 text-white'
                          : 'text-neutral-300 hover:bg-white/5',
                      )}
                    >
                      <Icon className="size-3.5 shrink-0 text-neutral-400" />
                      <span className="min-w-0 flex-1 truncate text-[13px]">
                        {action.label}
                      </span>
                      <kbd className="shrink-0 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-neutral-400">
                        {action.shortcut}
                      </kbd>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Highlights matched query segments in text.
 */
function HighlightedText({ text, query }: { text: string; query: string }) {
  const segments = useMemo(
    () => splitHighlightSegments(text, query),
    [text, query],
  )

  return (
    <>
      {segments.map((seg, i) =>
        seg.match ? (
          <span key={i} className="font-medium text-white underline underline-offset-2">
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  )
}
