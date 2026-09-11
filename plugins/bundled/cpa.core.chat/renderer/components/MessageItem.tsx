import {
    memo,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
} from 'react'
import {
    AlertCircle,
    buildSkillSuggestions,
    Check,
    Copy,
    ExtensionSlot,
    getSkillQuery,
    insertSkillAtCaret,
    parseSkillDraft,
    Pencil,
    PluginMessageHost,
    PluginPartHost,
    ReactMarkdown,
    RotateCcw,
    Undo2,
    serializeSkillDraft,
    SkillChip,
    SkillDraftEditor,
    skillDraftHasChip,
    SkillMenu,
    type Components,
    type SkillSuggestion,
    cn,
    remarkGfm,
    useHostServices,
    useSkillUsageCounts,
    useAvailableSkills,
    useTranslation,
    useChatRenderers,
} from '@cpa/plugin-ui'
import type {
    DisplayChatMessage,
    DisplayMessagePart,
    ToolLiveOverlay,
} from '../types.js'
import {
    matchSkillPresentation,
    skillPresentationCommand,
} from '../utils/skillPresentation.js'
import {
    groupCompactActivityParts,
    hasVisibleTurnContent,
    trailingAssistantText,
} from '../utils/toolActivity.js'
import { ThinkingBlock } from './ThinkingBlock.js'
import { ToolActivityStack } from './ToolActivityStack.js'
import { ToolCard } from './ToolCard.js'
import { TurnHeader } from './TurnHeader.js'

export function ForkIcon({ className }: { className?: string }) {
    return (
        <svg
            viewBox="2.5 3.5 16 17"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            aria-hidden="true"
        >
            <path d="M4 12h5" />
            <path d="M9 12l8-7" />
            <path d="M13 5h4v4" />
            <path d="M9 12l8 7" />
            <path d="M13 19h4v-4" />
        </svg>
    )
}

export function HookIcon({ className }: { className?: string }) {
    return (
        <svg
            viewBox="3.5 1.5 17 18.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            aria-hidden="true"
        >
            <circle cx="12" cy="5" r="2.5" />
            <path d="M12 7.5V19" />
            <path d="M6 12v1a6 6 0 0 0 12 0v-1" />
        </svg>
    )
}

export interface MessageItemProps {
    message: DisplayChatMessage
    onApproveTool?: (toolId: string) => void
    onRejectTool?: (toolId: string) => void
    onEditMessage?: (messageId: string, text: string) => void | Promise<void>
    onRetry?: () => void | Promise<void>
    onFork?: () => void | Promise<void>
    onExecuteHook?: () => void | Promise<void>
    /** Ephemeral live overlays keyed by normalized toolCallId. */
    toolOverlays?: Readonly<Record<string, ToolLiveOverlay>>
    /** Main-agent CPA-style folded tools and turn header. */
    compactActivity?: boolean
    /** Override collapsed-turn body when multiple assistant stages are merged. */
    collapsedText?: string
    /** Hide the turn timer when a parent turn already rendered one. */
    suppressTurnHeader?: boolean
    /** Always show full compact history when a parent turn owns collapse. */
    forceExpanded?: boolean
    /** Suppress assistant message actions when rendered as an intermediate stage. */
    suppressActions?: boolean
    className?: string
}

const markdownComponents: Components = {
    p: ({ children }) => (
        <p className="mb-3 last:mb-0 leading-relaxed text-[var(--text-primary)]">
            {children}
        </p>
    ),
    h1: ({ children }) => (
        <h1 className="mb-3 text-xl font-semibold tracking-tight text-[var(--text-primary)]">
            {children}
        </h1>
    ),
    h2: ({ children }) => (
        <h2 className="mb-2.5 text-lg font-semibold tracking-tight text-[var(--text-primary)]">
            {children}
        </h2>
    ),
    h3: ({ children }) => (
        <h3 className="mb-2 text-base font-semibold text-[var(--text-primary)]">
            {children}
        </h3>
    ),
    ul: ({ children }) => (
        <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0 text-[var(--text-primary)]">
            {children}
        </ul>
    ),
    ol: ({ children }) => (
        <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0 text-[var(--text-primary)]">
            {children}
        </ol>
    ),
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    a: ({ href, children }) => (
        <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--accent-blue)] underline-offset-2 hover:underline"
        >
            {children}
        </a>
    ),
    blockquote: ({ children }) => (
        <blockquote className="mb-3 border-l-2 border-[var(--border-subtle)] pl-3 text-[var(--text-secondary)] last:mb-0">
            {children}
        </blockquote>
    ),
    table: ({ children }) => (
        <div className="mb-3 overflow-x-auto last:mb-0">
            <table className="w-full border-collapse text-left text-[13px]">
                {children}
            </table>
        </div>
    ),
    th: ({ children }) => (
        <th className="border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-1.5 font-medium">
            {children}
        </th>
    ),
    td: ({ children }) => (
        <td className="border border-[var(--border-subtle)] px-2 py-1.5 align-top">
            {children}
        </td>
    ),
    pre: ({ children }) => (
        <pre
            className={cn(
                'my-3 overflow-x-auto rounded-lg border border-[var(--border-subtle)]',
                'bg-[#0b0b0b] p-3 leading-relaxed text-[var(--text-primary)]',
                'last:mb-0',
            )}
            style={{ fontSize: 'var(--code-font-size, 12px)' }}
        >
            {children}
        </pre>
    ),
    code: ({ className, children }) => {
        const isBlock = Boolean(className)
        if (isBlock) {
            return (
                <code
                    className={cn('font-mono', className)}
                    style={{ fontSize: 'var(--code-font-size, 12px)' }}
                >
                    {children}
                </code>
            )
        }
        return (
            <code className="rounded bg-[var(--bg-sidebar-hover)] px-1 py-0.5 font-mono text-[0.9em] text-[var(--text-primary)]">
                {children}
            </code>
        )
    },
    hr: () => <hr className="my-4 border-[var(--border-subtle)]" />,
}

/**
 * Renders a user message bubble with inline skill support, editing capabilities, and message slots.
 */
export const UserMessageRenderer = memo(function UserMessageRenderer(
    props: MessageItemProps & { value?: DisplayChatMessage },
) {
    const message = props.value ?? props.message
    const { onEditMessage, className } = props
    const { t, i18n } = useTranslation()
    const services = useHostServices()
    const editTextareaRef = useRef<HTMLDivElement>(null)
    const reactId = useId()
    const skillListboxId = `skill-menu-${reactId.replace(/:/g, '')}`
    const [isEditing, setIsEditing] = useState(false)
    const [editText, setEditText] = useState('')
    const [editCursor, setEditCursor] = useState(0)
    const [skillMenuOpen, setSkillMenuOpen] = useState(false)
    const [activeSkillIndex, setActiveSkillIndex] = useState(0)
    const [isSubmittingEdit, setIsSubmittingEdit] = useState(false)
    const usageCounts = useSkillUsageCounts()

    const isPending = Boolean(message.pendingStatus)

    const handleRecallAndEdit = async () => {
        if (services?.chatMessages?.dequeueMessage) {
            const res = await services.chatMessages.dequeueMessage(message.sessionId, message.id)
            if (res) {
                services?.ui?.setComposerDraft?.(message.sessionId, res.text)
                services?.ui?.pushToast(t('message.recalledToComposer', { defaultValue: 'Recalled to composer' }))
            }
        }
    }

    const composerSkills = useAvailableSkills()

    const skillQuery = getSkillQuery(editText, editCursor)
    const skillSuggestions = useMemo(() => {
        if (skillQuery === null) return [] as SkillSuggestion[]
        return buildSkillSuggestions({
            query: skillQuery,
            skills: composerSkills,
            usageCounts,
        }).map((item, index) => ({
            ...item,
            id: `${skillListboxId}-opt-${index}-${item.name}`,
        }))
    }, [composerSkills, skillListboxId, skillQuery, usageCounts])
    const showSkillMenu =
        isEditing && skillMenuOpen && skillQuery !== null && skillSuggestions.length > 0
    const activeSkillOptionId = showSkillMenu
        ? skillSuggestions[
              ((activeSkillIndex % skillSuggestions.length) +
                  skillSuggestions.length) %
                  skillSuggestions.length
          ]?.id
        : undefined

    useEffect(() => {
        if (!isEditing) return
        editTextareaRef.current?.focus()
    }, [isEditing])

    useEffect(() => {
        if (!isEditing) return
        setActiveSkillIndex(0)
        if (skillQuery !== null) {
            setSkillMenuOpen(true)
            return
        }
        setSkillMenuOpen(false)
    }, [isEditing, skillQuery])

    const copyUserText = async (copyContent: string) => {
        try {
            await copyTextToClipboard(copyContent, services)
            services?.ui?.pushToast(t('message.copySuccess'))
        } catch {
            services?.ui?.pushToast(t('message.copyFailed'))
        }
    }

    const startEditing = () => {
        const stored = userText(message)
        const presentation = matchSkillPresentation(stored, composerSkills)
        const next = presentation ? skillPresentationCommand(presentation) : stored
        setEditText(next)
        setEditCursor(next.length)
        setSkillMenuOpen(false)
        setActiveSkillIndex(0)
        setIsEditing(true)
    }

    const resetEditing = () => {
        setIsEditing(false)
        setEditText('')
        setEditCursor(0)
        setSkillMenuOpen(false)
        setActiveSkillIndex(0)
    }

    const cancelEditing = () => {
        if (isSubmittingEdit) return
        resetEditing()
    }

    const selectSkill = (suggestion: SkillSuggestion | string) => {
        const skillName = typeof suggestion === 'string' ? suggestion : suggestion.name
        const inserted = insertSkillAtCaret(editText, skillName, editCursor)
        setEditText(inserted.text)
        setEditCursor(inserted.cursor)
        setSkillMenuOpen(false)
        setActiveSkillIndex(0)
    }

    const submitEditing = async () => {
        if (!onEditMessage || isSubmittingEdit || !editText.trim()) return
        setIsSubmittingEdit(true)
        try {
            await onEditMessage(message.id, editText)
            resetEditing()
        } catch (error) {
            services?.ui?.pushToast(
                error instanceof Error ? error.message : t('composer.sendFailed'),
            )
        } finally {
            setIsSubmittingEdit(false)
        }
    }

    const text = userText(message)
    const draftParts = parseSkillDraft(text, composerSkills)
    const hasInlineSkills = skillDraftHasChip(draftParts)
    const wholeSkill = hasInlineSkills ? null : matchSkillPresentation(text, composerSkills)
    const copyText = hasInlineSkills
        ? serializeSkillDraft(draftParts)
        : wholeSkill
            ? skillPresentationCommand(wholeSkill)
            : text

    return (
        <div
            className={cn(
                'group flex w-full flex-col items-end',
                isPending && 'pt-1.5 pb-0.5 overflow-visible',
                className,
            )}
        >
            <ExtensionSlot name="chat.message.before" props={{ message }} />
            <div className="flex w-full max-w-[85%] min-w-0 flex-col items-end overflow-visible">
                {isEditing ? (
                    <div className="relative w-full">
                        <div
                            className={cn(
                                'w-full overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-subtle)]',
                                'bg-[var(--bg-elevated)] text-[14px] text-[var(--text-primary)]',
                            )}
                        >
                            <div className="flex w-full items-start gap-1.5 px-3.5 pt-3">
                                <SkillDraftEditor
                                    editorRef={editTextareaRef}
                                    value={editText}
                                    cursor={editCursor}
                                    skills={composerSkills}
                                    disabled={isSubmittingEdit}
                                    ariaLabel={t('message.editInput')}
                                    testId="message-edit-input"
                                    className="min-h-24"
                                    ariaControls={showSkillMenu ? skillListboxId : undefined}
                                    ariaExpanded={showSkillMenu}
                                    ariaActivedescendant={activeSkillOptionId}
                                    ariaAutocomplete={showSkillMenu ? 'list' : undefined}
                                    role={showSkillMenu ? 'combobox' : undefined}
                                    onChange={(next, cursor) => {
                                        setEditText(next)
                                        setEditCursor(typeof cursor === 'number' ? cursor : next.length)
                                    }}
                                    onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                                        if (showSkillMenu) {
                                            if (event.key === 'ArrowDown') {
                                                event.preventDefault()
                                                setActiveSkillIndex(
                                                    (index) =>
                                                        (index + 1) % skillSuggestions.length,
                                                )
                                                return
                                            }
                                            if (event.key === 'ArrowUp') {
                                                event.preventDefault()
                                                setActiveSkillIndex(
                                                    (index) =>
                                                        (index - 1 + skillSuggestions.length) %
                                                        skillSuggestions.length,
                                                )
                                                return
                                            }
                                            if (event.key === 'Enter' || event.key === 'Tab') {
                                                event.preventDefault()
                                                const active = skillSuggestions[activeSkillIndex]
                                                if (active) {
                                                    selectSkill(active)
                                                }
                                                return
                                            }
                                            if (event.key === 'Escape') {
                                                event.preventDefault()
                                                setSkillMenuOpen(false)
                                                return
                                            }
                                        }
                                        if (event.key === 'Escape') {
                                            event.preventDefault()
                                            cancelEditing()
                                            return
                                        }
                                        if (
                                            event.key === 'Enter' &&
                                            (event.metaKey || event.ctrlKey)
                                        ) {
                                            event.preventDefault()
                                            void submitEditing()
                                        }
                                    }}
                                />
                            </div>
                            <div className="flex justify-end gap-2 px-3 pb-3 pt-2">
                                <button
                                    type="button"
                                    disabled={isSubmittingEdit}
                                    onClick={cancelEditing}
                                    className={cn(
                                        'rounded-lg px-3 py-1.5 text-[13px] text-[var(--text-secondary)]',
                                        'transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                                        'disabled:pointer-events-none disabled:opacity-50',
                                    )}
                                >
                                    {t('message.cancel')}
                                </button>
                                <button
                                    type="button"
                                    disabled={isSubmittingEdit || !editText.trim()}
                                    onClick={() => void submitEditing()}
                                    className={cn(
                                        'rounded-lg bg-[var(--text-primary)] px-3 py-1.5 text-[13px] font-medium',
                                        'text-[var(--bg-app)] transition-opacity hover:opacity-90',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                                        'disabled:pointer-events-none disabled:opacity-50',
                                    )}
                                >
                                    {t('message.send')}
                                </button>
                            </div>
                        </div>
                        {showSkillMenu ? (
                            <SkillMenu
                                id={skillListboxId}
                                testId="message-edit-skill-menu"
                                suggestions={skillSuggestions}
                                activeIndex={activeSkillIndex}
                                onActiveIndexChange={setActiveSkillIndex}
                                onSelect={selectSkill}
                                onClose={() => setSkillMenuOpen(false)}
                            />
                        ) : null}
                    </div>
                ) : (
                    <div
                        tabIndex={0}
                        className={cn(
                            'max-w-full min-w-0 rounded-[var(--radius-card)] border border-[var(--border-subtle)]',
                            'bg-[var(--bg-elevated)] px-3.5 py-2.5 text-[14px] leading-[22px]',
                            'text-[var(--text-primary)] whitespace-pre-wrap [overflow-wrap:anywhere]',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                            isPending && 'border-dashed border-[var(--accent-blue)]/50 opacity-80 shadow-[0_0_12px_rgba(59,130,246,0.2)] ring-1 ring-[var(--accent-blue)]/20 animate-pulse my-1',
                        )}
                        data-testid={
                            hasInlineSkills || wholeSkill ? 'user-skill-chip' : 'user-message-bubble'
                        }
                    >
                        {hasInlineSkills ? (
                            <div className="flex flex-wrap items-baseline gap-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
                                {draftParts.map((part, index) =>
                                    part.type === 'skill' ? (
                                        <span
                                            key={`skill-${part.name}-${index}`}
                                            className="whitespace-pre-wrap"
                                        >
                                            <SkillChip
                                                name={part.name}
                                                displayName={part.displayName}
                                            />
                                        </span>
                                    ) : (
                                        <span key={`text-${index}`}>{part.text}</span>
                                    ),
                                )}
                            </div>
                        ) : wholeSkill ? (
                            <div className="flex flex-wrap items-baseline gap-1 [overflow-wrap:anywhere]">
                                <span className="whitespace-pre-wrap">
                                    <SkillChip
                                        name={wholeSkill.name}
                                        displayName={wholeSkill.displayName}
                                    />
                                </span>
                                {wholeSkill.args ? (
                                    <span className="whitespace-pre-wrap">
                                        {` ${wholeSkill.args}`}
                                    </span>
                                ) : null}
                            </div>
                        ) : (
                            <div className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                                {text}
                            </div>
                        )}
                    </div>
                )}
                {!isEditing ? (
                    <div
                        className={cn(
                            'mt-0.5 flex min-h-6 items-center gap-1 text-[11px] text-[var(--text-muted)]',
                            isPending
                                ? 'opacity-80 transition-opacity hover:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100'
                                : 'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
                        )}
                    >
                        <time dateTime={toDateTime(message.createdAt)}>
                            {formatMessageTime(message.createdAt, i18n.resolvedLanguage)}
                        </time>
                        <span aria-hidden="true">·</span>
                        {isPending ? (
                            <button
                                type="button"
                                title={t('message.recallAndEdit', { defaultValue: 'Recall and edit' })}
                                aria-label={t('message.recallAndEdit', { defaultValue: 'Recall and edit' })}
                                onClick={() => void handleRecallAndEdit()}
                                className={cn(
                                    'rounded p-1 text-[var(--text-muted)] transition-colors',
                                    'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40 cursor-pointer',
                                )}
                            >
                                <Undo2 className="size-3.5" />
                            </button>
                        ) : (
                            <>
                                <button
                                    type="button"
                                    title={t('message.copy')}
                                    aria-label={t('message.copy')}
                                    onClick={() => {
                                        void copyUserText(copyText)
                                    }}
                                    className={cn(
                                        'rounded p-1 text-[var(--text-muted)] transition-colors',
                                        'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                                    )}
                                >
                                    <Copy className="size-3.5" />
                                </button>
                                {onEditMessage ? (
                                    <button
                                        type="button"
                                        title={t('message.edit')}
                                        aria-label={t('message.edit')}
                                        onClick={startEditing}
                                        className={cn(
                                            'rounded p-1 text-[var(--text-muted)] transition-colors',
                                            'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                                        )}
                                    >
                                        <Pencil className="size-3.5" />
                                    </button>
                                ) : null}
                            </>
                        )}
                        <ExtensionSlot name="chat.message.actions" props={{ message }} />
                    </div>
                ) : null}
            </div>
            <ExtensionSlot name="chat.message.after" props={{ message }} />
        </div>
    )
})

/**
 * Renders an assistant message with markdown text, tool parts, thinking blocks, turn headers, and actions.
 */
export const AssistantMessageRenderer = memo(function AssistantMessageRenderer(
    props: MessageItemProps & { value?: DisplayChatMessage },
) {
    const message = props.value ?? props.message
    const {
        onApproveTool,
        onRejectTool,
        onRetry,
        onFork,
        onExecuteHook: _onExecuteHook,
        toolOverlays,
        compactActivity = false,
        collapsedText,
        suppressTurnHeader = false,
        forceExpanded = false,
        suppressActions = false,
        className,
    } = props
    const { t, i18n } = useTranslation()
    const services = useHostServices()
    const chatRenderers = useChatRenderers()
    const [isRetrying, setIsRetrying] = useState(false)
    const [hasCopiedResult, setHasCopiedResult] = useState(false)
    const [historyOpen, setHistoryOpen] = useState(
        () => forceExpanded || message.status === 'streaming',
    )
    const completedTimestamp = (message as any).completedAt ?? message.createdAt
    const completedTimeText = useMemo(
        () => formatSessionCompletionTime(completedTimestamp, i18n.language),
        [completedTimestamp, i18n.language],
    )

    useEffect(() => {
        if (message.role !== 'assistant') return
        if (forceExpanded || message.status === 'streaming') {
            setHistoryOpen(true)
            return
        }
        if (
            message.status === 'done' ||
            message.status === 'error' ||
            message.status === 'aborted'
        ) {
            setHistoryOpen(false)
        }
    }, [forceExpanded, message.role, message.status])

    const handleRetry = async () => {
        if (!onRetry || isRetrying) return
        setIsRetrying(true)
        try {
            await onRetry()
        } catch (error) {
            services?.ui?.pushToast(
                error instanceof Error ? error.message : t('composer.sendFailed'),
            )
        } finally {
            setIsRetrying(false)
        }
    }

    const copyAssistantText = async (copyContent: string) => {
        if (!copyContent) return
        try {
            await copyTextToClipboard(copyContent, services)
            setHasCopiedResult(true)
            setTimeout(() => setHasCopiedResult(false), 2000)
            services?.ui?.pushToast(t('message.copySuccess'))
        } catch {
            services?.ui?.pushToast(t('message.copyFailed'))
        }
    }

    const handleForkSession = async () => {
        try {
            if (onFork) {
                await onFork()
                return
            }
            if (services?.chatMessages?.forkSession) {
                const forkedId = await services.chatMessages.forkSession(message.sessionId, message.id)
                if (forkedId && services.navigation?.navigate) {
                    await services.navigation.navigate(`/chat/${forkedId}`)
                }
            }
        } catch {
            services?.ui?.pushToast(t('message.forkFailed'))
        }
    }

    const parts = message.parts ?? []
    const hasParts = parts.length > 0
    const streaming = message.status === 'streaming'
    const terminal =
        message.status === 'done' ||
        message.status === 'error' ||
        message.status === 'aborted'
    const visible = hasVisibleTurnContent(parts, message.content)

    if (compactActivity && streaming && !visible) {
        if (suppressTurnHeader) return null
        return (
            <div className={cn('w-full text-[14px]', className)}>
                <ExtensionSlot name="chat.message.before" props={{ message }} />
                <ExtensionSlot
                    name="chat.message.header"
                    props={{
                        startedAt: message.createdAt,
                        completedAt: (message as any).completedAt,
                        streaming: true,
                        expanded: historyOpen,
                        pausedMs: (message as any).pausedMs,
                    }}
                    fallback={
                        <TurnHeader
                            startedAt={message.createdAt}
                            completedAt={(message as any).completedAt}
                            streaming
                            expanded={historyOpen}
                            pausedMs={(message as any).pausedMs}
                        />
                    }
                />
                <ExtensionSlot name="chat.message.after" props={{ message }} />
            </div>
        )
    }

    const isInterrupted =
        !streaming &&
        (message.status === 'aborted' ||
            message.status === 'error' ||
            (message as any).interrupted === true)

    const showFullTurn =
        !compactActivity || forceExpanded || streaming || historyOpen
    const showAssistantActions =
        !suppressActions &&
        !streaming &&
        message.status !== 'error' &&
        message.status !== 'aborted' &&
        (visible || Boolean(message.content) || (parts && parts.length > 0) || Boolean(collapsedText))
    const assistantContent = collapsedText ?? assistantText(message)

    return (
        <div className={cn('w-full text-[14px]', className)}>
            <ExtensionSlot name="chat.message.before" props={{ message }} />
            {compactActivity && !suppressTurnHeader && (visible || terminal) ? (
                <ExtensionSlot
                    name="chat.message.header"
                    props={{
                        startedAt: message.createdAt,
                        completedAt: (message as any).completedAt,
                        streaming,
                        status: message.status,
                        interrupted: isInterrupted,
                        expanded: historyOpen,
                        pausedMs: (message as any).pausedMs,
                        onToggle: terminal ? () => setHistoryOpen((open) => !open) : undefined,
                    }}
                    fallback={
                        <TurnHeader
                            startedAt={message.createdAt}
                            completedAt={(message as any).completedAt}
                            streaming={streaming}
                            status={message.status}
                            interrupted={isInterrupted}
                            expanded={historyOpen}
                            pausedMs={(message as any).pausedMs}
                            onToggle={terminal ? () => setHistoryOpen((open) => !open) : undefined}
                        />
                    }
                />
            ) : null}
            <ExtensionSlot name="chat.message.body" props={{ message }} />
            {showFullTurn
                ? hasParts
                    ? renderParts(parts, {
                        sessionId: message.sessionId,
                        streaming,
                        onApproveTool: onApproveTool ?? (() => {}),
                        onRejectTool: onRejectTool ?? (() => {}),
                        toolOverlays,
                        compactActivity,
                        chatRenderers,
                    })
                    : (
                        <AssistantText
                            text={message.content}
                        />
                    )
                : (
                    <AssistantText
                        text={collapsedText ?? trailingAssistantText(parts, message.content)}
                    />
                )}
            {message.status === 'error' ? (
                <div
                    data-testid="message-error-card"
                    className="mt-3 flex flex-col gap-2 rounded-lg border border-[var(--accent-orange)]/30 bg-[var(--accent-orange)]/10 p-3 text-[13px]"
                >
                    <div className="flex items-start gap-2 text-[var(--accent-orange)]">
                        <AlertCircle className="mt-0.5 size-4 shrink-0" />
                        <span className="flex-1 whitespace-pre-wrap [overflow-wrap:anywhere] leading-relaxed">
                            {(message as any).errorMessage || t('message.error')}
                        </span>
                    </div>
                    {onRetry ? (
                        <div className="flex justify-end">
                            <button
                                type="button"
                                disabled={isRetrying}
                                onClick={() => {
                                    void handleRetry()
                                }}
                                className={cn(
                                    'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium',
                                    'border border-[var(--accent-orange)]/40 bg-[var(--bg-elevated)] text-[var(--text-primary)]',
                                    'transition-colors hover:bg-[var(--bg-sidebar-hover)]',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                                    'disabled:pointer-events-none disabled:opacity-50',
                                )}
                            >
                                <RotateCcw
                                    className={cn(
                                        'size-3 text-[var(--accent-orange)]',
                                        isRetrying && 'animate-spin',
                                    )}
                                />
                                <span>{t('message.retry')}</span>
                            </button>
                        </div>
                    ) : null}
                </div>
            ) : null}
            {showAssistantActions ? (
                <div
                    data-testid="assistant-message-actions"
                    className="group/actions mt-2 flex min-h-6 items-center gap-1 text-[var(--text-muted)]"
                >
                    <button
                        type="button"
                        title={t('message.copyResult')}
                        aria-label={t('message.copyResult')}
                        onClick={() => void copyAssistantText(assistantContent)}
                        className={cn(
                            'rounded p-1 text-[var(--text-muted)] transition-colors',
                            'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                        )}
                        data-testid="message-copy-result-btn"
                    >
                        {hasCopiedResult ? (
                            <Check className="size-3.5 text-[var(--accent-green)]" />
                        ) : (
                            <Copy className="size-3.5" />
                        )}
                    </button>
                    <button
                        type="button"
                        title={t('message.forkChat')}
                        aria-label={t('message.forkChat')}
                        onClick={() => void handleForkSession()}
                        className={cn(
                            'rounded p-1 text-[var(--text-muted)] transition-colors',
                            'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                        )}
                        data-testid="message-fork-btn"
                    >
                        <ForkIcon className="size-3.5" />
                    </button>
                    <div
                        title={t('message.sessionHook')}
                        aria-label={t('message.sessionHook')}
                        className="inline-flex items-center gap-2 rounded px-1 py-1 text-[var(--text-muted)] select-none"
                        data-testid="message-hook-indicator"
                    >
                        <HookIcon className="size-3.5" />
                        {completedTimeText ? (
                            <span
                                className="text-[11px] text-[var(--text-muted)] opacity-0 transition-opacity duration-150 group-hover/actions:opacity-100 font-mono select-none"
                                title={toDateTime(completedTimestamp)}
                                data-testid="message-completion-time"
                            >
                                {completedTimeText}
                            </span>
                        ) : null}
                    </div>
                    <ExtensionSlot name="chat.message.actions" props={{ message }} />
                </div>
            ) : !suppressActions ? (
                <ExtensionSlot name="chat.message.actions" props={{ message }} />
            ) : null}
            <ExtensionSlot name="chat.message.after" props={{ message }} />
        </div>
    )
})

function DefaultMessageFallback(props: MessageItemProps) {
    const message = props.message
    if (message.role === 'user') {
        return <UserMessageRenderer {...props} />
    }
    return <AssistantMessageRenderer {...props} />
}

export const MessageItem = memo(function MessageItem(props: MessageItemProps) {
    return (
        <PluginMessageHost
            fallback={<DefaultMessageFallback {...props} />}
            {...props}
        />
    )
})

export function AssistantText(props: {
    text?: string
    part?: any
    value?: any
    className?: string
}) {
    const text = props.text ?? props.part?.text ?? props.value?.text ?? ''
    if (!text) return null
    return (
        <div
            className={cn(
                'markdown-body prose prose-invert max-w-none min-w-0 [overflow-wrap:anywhere]',
                props.className,
            )}
        >
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={markdownComponents}
            >
                {text}
            </ReactMarkdown>
        </div>
    )
}

async function copyTextToClipboard(text: string, services?: any): Promise<void> {
    if (services?.ui?.writeClipboard) {
        try {
            await services.ui.writeClipboard(text)
            return
        } catch {
            // fallback
        }
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text)
            return
        } catch {
            // fallback
        }
    }
    const input = document.createElement('textarea')
    input.value = text
    input.setAttribute('readonly', '')
    input.style.position = 'fixed'
    input.style.opacity = '0'
    document.body.appendChild(input)
    input.select()
    try {
        if (!document.execCommand('copy')) {
            throw new Error('Clipboard is unavailable')
        }
    } finally {
        input.remove()
    }
}

const dateTimeFormatCache = new Map<string, Intl.DateTimeFormat>()

function getDateTimeFormatter(
    locale: string,
    options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
    const key = `${locale}:${JSON.stringify(options)}`
    let formatter = dateTimeFormatCache.get(key)
    if (!formatter) {
        formatter = new Intl.DateTimeFormat(locale, options)
        dateTimeFormatCache.set(key, formatter)
    }
    return formatter
}

function formatMessageTime(timestamp: number, language?: string): string {
    if (!Number.isFinite(timestamp)) return ''
    const locale = language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
    return getDateTimeFormatter(locale, {
        month: locale === 'zh-CN' ? 'numeric' : 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: locale === 'zh-CN' ? false : undefined,
    }).format(new Date(timestamp))
}

function formatSessionCompletionTime(timestamp: number, language?: string): string {
    if (!Number.isFinite(timestamp)) return ''
    const locale = language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
    const date = new Date(timestamp)
    const now = new Date()
    const isSameDay =
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate()

    if (isSameDay) {
        return getDateTimeFormatter(locale, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        }).format(date)
    }

    return getDateTimeFormatter(locale, {
        month: locale === 'zh-CN' ? 'numeric' : 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).format(date)
}

function toDateTime(timestamp: number): string | undefined {
    if (!Number.isFinite(timestamp)) return undefined
    return new Date(timestamp).toISOString()
}

function userText(message: DisplayChatMessage): string {
    const textPart = message.parts?.find((part) => part.type === 'text')
    if (textPart && textPart.type === 'text') return textPart.text
    return message.content
}

function assistantText(message: DisplayChatMessage): string {
    if (message.content) return message.content
    const textParts = message.parts?.filter((p) => p.type === 'text')
    if (textParts && textParts.length > 0) {
        return textParts.map((p) => (p as { text: string }).text).join('\n\n')
    }
    return ''
}

function renderParts(
    parts: DisplayMessagePart[],
    opts: {
        sessionId: string
        streaming: boolean
        onApproveTool: (toolId: string) => void
        onRejectTool: (toolId: string) => void
        toolOverlays?: Readonly<Record<string, ToolLiveOverlay>>
        compactActivity?: boolean
        chatRenderers?: readonly any[]
        message?: DisplayChatMessage
    },
) {
    if (opts.compactActivity) {
        const segments = groupCompactActivityParts(parts, {
            renderers: opts.chatRenderers,
        })
        return segments.map((segment, index) => {
            const isLastSegment = index === segments.length - 1
            if (segment.type === 'text') {
                return (
                    <AssistantText
                        key={`text-${index}`}
                        text={segment.text}
                    />
                )
            }
            if (segment.type === 'spawns') {
                return (
                    <ExtensionSlot
                        key={segment.parts[0]?.id ?? `spawn-${index}`}
                        name="chat.message.subagents"
                        props={{
                            sessionId: opts.sessionId,
                            parts: segment.parts,
                        }}
                    />
                )
            }
            return (
                <ToolActivityStack
                    key={`tools-${segment.parts[0]?.id ?? index}`}
                    parts={segment.parts}
                    streaming={opts.streaming && isLastSegment}
                    toolOverlays={opts.toolOverlays}
                    onApproveTool={opts.onApproveTool}
                    onRejectTool={opts.onRejectTool}
                />
            )
        })
    }

    return parts.map((part, index) => {
        const isLast = index === parts.length - 1
        const fallbackNode =
            part.type === 'tool_call' ? (
                <ToolCard
                    key={part.id}
                    part={part as any}
                    onApprove={opts.onApproveTool}
                    onReject={opts.onRejectTool}
                    toolOverlays={opts.toolOverlays}
                />
            ) : part.type === 'thinking' ? (
                <ThinkingBlock
                    key={`thinking-${index}`}
                    thinking={(part as any).thinking}
                    streaming={opts.streaming && isLast}
                />
            ) : part.type === 'text' ? (
                <AssistantText key={`text-${index}`} text={(part as any).text} />
            ) : undefined

        return (
            <PluginPartHost
                key={part.type === 'tool_call' ? part.id : `part-${index}`}
                part={part}
                message={opts.message}
                streaming={opts.streaming}
                isLast={isLast}
                onApproveTool={opts.onApproveTool}
                onRejectTool={opts.onRejectTool}
                toolOverlays={opts.toolOverlays}
                fallback={fallbackNode}
            />
        )
    })
}
