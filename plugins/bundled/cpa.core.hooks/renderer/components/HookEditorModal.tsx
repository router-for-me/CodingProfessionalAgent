import { useState, useEffect } from 'react'
import {
    CustomSelect,
    ToggleSwitch,
    X,
    cn,
    useHostServices,
    useTranslation,
} from '@cpa/plugin-ui'
import { useHooksStore } from '../hooksStore.js'
import { saveEditingHook } from '../hooksActions.js'
import { validateMatcherPattern } from '../../agent/matcher.js'
import {
    HOOK_EVENT_NAMES,
    HOOK_EVENT_NAMES_WITH_MATCHERS,
    type HookEventName,
} from '../../agent/types.js'

export function HookEditorModal() {
    const { t } = useTranslation()
    const services = useHostServices()
    const open = useHooksStore((s: any) => s.editorOpen)
    const editing = useHooksStore((s: any) => s.editingHook)
    const close = useHooksStore((s: any) => s.closeEditor)
    const projectConfigs = useHooksStore((s: any) => s.projectConfigs)

    const [eventName, setEventName] = useState<HookEventName>('PreToolUse')
    const [matcher, setMatcher] = useState('')
    const [command, setCommand] = useState('')
    const [timeout, setTimeoutSec] = useState(30)
    const [isAsync, setIsAsync] = useState(false)
    const [statusMessage, setStatusMessage] = useState('')
    const [contextLimit, setContextLimit] = useState<number | undefined>(undefined)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (editing) {
            setEventName(editing.eventName)
            setMatcher(editing.matcher || '')
            if (editing.handler.type === 'command') {
                setCommand(editing.handler.command || '')
                setTimeoutSec(editing.handler.timeout ?? 30)
                setIsAsync(Boolean(editing.handler.async))
                setStatusMessage(editing.handler.statusMessage || '')
                setContextLimit(editing.handler.additionalContextLimit)
            }
            setError(null)
        }
    }, [editing])

    if (!open || !editing) return null

    const supportsMatcher = HOOK_EVENT_NAMES_WITH_MATCHERS.includes(eventName)

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError(null)

        if (!command.trim()) {
            setError(t('settings.hooks.editor.error.commandRequired', { defaultValue: 'Please enter a command' }))
            return
        }

        if (supportsMatcher && matcher.trim()) {
            const val = validateMatcherPattern(matcher.trim())
            if (!val.valid) {
                setError(t('settings.hooks.editor.error.invalidMatcher', { defaultValue: `Invalid matcher regex: ${val.error}` }))
                return
            }
        }

        if (!services) {
            setError(t('settings.hooks.editor.error.servicesUnavailable', { defaultValue: 'Platform services unavailable' }))
            return
        }

        setSaving(true)
        try {
            await saveEditingHook(
                services,
                {
                    source: editing.source,
                    eventName,
                    matcher: supportsMatcher ? matcher.trim() : '',
                    handler: {
                        type: 'command',
                        command: command.trim(),
                        timeout: timeout > 0 ? timeout : 30,
                        async: isAsync,
                        statusMessage: statusMessage.trim() || undefined,
                        additionalContextLimit: contextLimit !== undefined && contextLimit > 0 ? contextLimit : undefined,
                    },
                },
                Object.keys(projectConfigs),
            )
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setSaving(false)
        }
    }

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
        >
            <div className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-app)] shadow-2xl">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-6 py-4">
                    <h2 className="text-base font-semibold text-[var(--text-primary)]">
                        {editing.handlerIndex !== undefined
                            ? t('settings.hooks.editor.editTitle', { defaultValue: 'Edit Hook' })
                            : t('settings.hooks.editor.addTitle', { defaultValue: 'Add Hook' })}
                    </h2>
                    <button
                        type="button"
                        onClick={close}
                        className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                    >
                        <X className="size-4" />
                    </button>
                </div>

                {/* Form */}
                <form onSubmit={handleSubmit} className="min-h-0 flex-1 overflow-y-auto px-6 py-5 space-y-4 text-[13px]">
                    {error && (
                        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-red-400 text-[13px]">
                            {error}
                        </div>
                    )}

                    {/* Event Type */}
                    <div>
                        <label className="block text-[13px] font-medium text-[var(--text-primary)] mb-1.5">
                            {t('settings.hooks.editor.eventName', { defaultValue: 'Lifecycle Event' })}
                        </label>
                        <CustomSelect<HookEventName>
                            value={eventName}
                            onChange={(val) => setEventName(val)}
                            ariaLabel={t('settings.hooks.editor.eventName', { defaultValue: 'Lifecycle Event' })}
                            fullWidth
                            options={HOOK_EVENT_NAMES.map((name) => ({
                                value: name,
                                label: name,
                            }))}
                            triggerClassName="w-full justify-between bg-[var(--bg-sidebar)] px-3.5 py-2 text-[13px] text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-lg hover:bg-[var(--bg-sidebar-hover)]"
                        />
                    </div>

                    {/* Matcher */}
                    {supportsMatcher && (
                        <div>
                            <label className="block text-[13px] font-medium text-[var(--text-primary)] mb-1.5">
                                {t('settings.hooks.editor.matcher', { defaultValue: 'Matcher (Regex)' })}
                            </label>
                            <input
                                type="text"
                                value={matcher}
                                onChange={(e) => setMatcher(e.target.value)}
                                placeholder="e.g. bash|edit or startup (leave blank to match all)"
                                className={cn(
                                    'w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] px-3.5 py-2 text-[13px] font-mono',
                                    'text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent-blue)]',
                                )}
                            />
                            <p className="mt-1.5 text-[12px] text-[var(--text-muted)]">
                                {eventName === 'PreToolUse' || eventName === 'PostToolUse' || eventName === 'PermissionRequest'
                                    ? 'Matches invoked tool name (e.g. bash, edit, write, read)'
                                    : eventName === 'SessionStart'
                                    ? 'Matches session start source (e.g. startup, resume, compact)'
                                    : eventName === 'SubagentStart' || eventName === 'SubagentStop'
                                    ? 'Matches subagent type (e.g. general-purpose, Explore)'
                                    : 'Matches trigger condition'}
                            </p>
                        </div>
                    )}

                    {/* Command */}
                    <div>
                        <label className="block text-[13px] font-medium text-[var(--text-primary)] mb-1.5">
                            {t('settings.hooks.editor.command', { defaultValue: 'Command' })}
                        </label>
                        <textarea
                            rows={3}
                            value={command}
                            onChange={(e) => setCommand(e.target.value)}
                            placeholder="e.g. python3 scripts/validate.py or ./hooks/pre-tool.sh"
                            className={cn(
                                'w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] px-3.5 py-2 text-[13px] font-mono',
                                'text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent-blue)]',
                            )}
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-3 pt-1">
                        {/* Timeout */}
                        <div>
                            <label className="block text-[13px] font-medium text-[var(--text-primary)] mb-1.5">
                                {t('settings.hooks.editor.timeout', { defaultValue: 'Timeout (seconds)' })}
                            </label>
                            <input
                                type="number"
                                min={1}
                                max={3600}
                                value={timeout}
                                onChange={(e) => setTimeoutSec(Number(e.target.value))}
                                className={cn(
                                    'w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] px-3.5 py-2 text-[13px]',
                                    'text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue)]',
                                )}
                            />
                        </div>

                        {/* Additional Context Limit */}
                        <div>
                            <label className="block text-[13px] font-medium text-[var(--text-primary)] mb-1.5">
                                {t('settings.hooks.editor.contextLimit', { defaultValue: 'Context Limit (Tokens)' })}
                            </label>
                            <input
                                type="number"
                                min={0}
                                max={100000}
                                placeholder="Default 2500"
                                value={contextLimit ?? ''}
                                onChange={(e) => setContextLimit(e.target.value ? Number(e.target.value) : undefined)}
                                className={cn(
                                    'w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] px-3.5 py-2 text-[13px]',
                                    'text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue)]',
                                )}
                            />
                        </div>
                    </div>

                    {/* Status Message */}
                    <div>
                        <label className="block text-[13px] font-medium text-[var(--text-primary)] mb-1.5">
                            {t('settings.hooks.editor.statusMessage', { defaultValue: 'Status Message (Optional)' })}
                        </label>
                        <input
                            type="text"
                            value={statusMessage}
                            onChange={(e) => setStatusMessage(e.target.value)}
                            placeholder="e.g. Running security check…"
                            className={cn(
                                'w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] px-3.5 py-2 text-[13px]',
                                'text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent-blue)]',
                            )}
                        />
                    </div>

                    {/* Async Execution */}
                    <div className="flex items-center justify-between rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] p-3">
                        <div className="space-y-0.5">
                            <div className="font-medium text-[13px] text-[var(--text-primary)]">
                                {t('settings.hooks.editor.async', { defaultValue: 'Async Non-blocking Execution' })}
                            </div>
                            <div className="text-[12px] text-[var(--text-muted)]">
                                {t('settings.hooks.editor.asyncDesc', { defaultValue: 'Run hook in background without blocking agent execution' })}
                            </div>
                        </div>
                        <ToggleSwitch
                            checked={isAsync}
                            onChange={setIsAsync}
                            label="Async"
                        />
                    </div>

                    {/* Actions */}
                    <div className="flex items-center justify-end gap-2.5 pt-4">
                        <button
                            type="button"
                            onClick={close}
                            className="rounded-lg px-4 py-2 text-[13px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)]"
                        >
                            {t('common.cancel', { defaultValue: 'Cancel' })}
                        </button>
                        <button
                            type="submit"
                            disabled={saving}
                            className="rounded-lg bg-[var(--accent-blue)] px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                            {saving
                                ? t('common.saving', { defaultValue: 'Saving…' })
                                : t('common.save', { defaultValue: 'Save Hook' })}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    )
}
