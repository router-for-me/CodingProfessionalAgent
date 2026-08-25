import { X, Terminal, Shield, Sparkles, RefreshCw, useTranslation } from '@cpa/plugin-ui'
import { useHooksStore } from '../hooksStore.js'

export function HookLearnMoreModal() {
    const { t } = useTranslation()
    const open = useHooksStore((s: any) => s.learnMoreOpen)
    const setOpen = useHooksStore((s: any) => s.setLearnMoreOpen)

    if (!open) return null

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
        >
            <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-app)] shadow-2xl">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-6 py-4">
                    <div className="flex items-center gap-2.5">
                        <div className="flex size-8 items-center justify-center rounded-lg bg-[var(--accent-blue)]/10 text-[var(--accent-blue)]">
                            <Sparkles className="size-4" />
                        </div>
                        <div>
                            <h2 className="text-base font-semibold text-[var(--text-primary)]">
                                {t('settings.hooks.learnMore.title', {
                                    defaultValue: 'Lifecycle Hooks Guide',
                                })}
                            </h2>
                            <p className="text-[13px] text-[var(--text-muted)]">
                                {t('settings.hooks.learnMore.subtitle', {
                                    defaultValue: 'Extend and automate agent lifecycle behavior',
                                })}
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => setOpen(false)}
                        className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                    >
                        <X className="size-4" />
                    </button>
                </div>

                {/* Content */}
                <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 space-y-6 text-[13px]">
                    <section className="space-y-2">
                        <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
                            {t('settings.hooks.learnMore.whatAreHooks', {
                                defaultValue: 'What are lifecycle hooks?',
                            })}
                        </h3>
                        <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
                            {t('settings.hooks.learnMore.whatAreHooksDesc', {
                                defaultValue:
                                    'Hooks allow you to run custom scripts or commands at key points during agent execution. You can automate security reviews, inject dynamic context, modify tool arguments, intercept dangerous commands, or collect telemetry.',
                            })}
                        </p>
                    </section>

                    <section className="space-y-3">
                        <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
                            {t('settings.hooks.learnMore.eventsList', {
                                defaultValue: 'Supported 11 lifecycle events',
                            })}
                        </h3>

                        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] p-3">
                                <div className="flex items-center gap-2 font-mono text-[13px] font-semibold text-blue-400">
                                    <Shield className="size-4" />
                                    PreToolUse
                                </div>
                                <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                                    Fires before tool execution. Supports regex matching on tool names to prevent execution, modify parameters, or auto-approve.
                                </p>
                            </div>

                            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] p-3">
                                <div className="flex items-center gap-2 font-mono text-[13px] font-semibold text-emerald-400">
                                    <Terminal className="size-4" />
                                    PostToolUse
                                </div>
                                <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                                    Fires after tool execution completes. Can read tool results and append additional context for the model.
                                </p>
                            </div>

                            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] p-3">
                                <div className="flex items-center gap-2 font-mono text-[13px] font-semibold text-amber-400">
                                    <Shield className="size-4" />
                                    PermissionRequest
                                </div>
                                <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                                    Fires before tool requests user approval. Can automatically allow, deny, or ask.
                                </p>
                            </div>

                            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] p-3">
                                <div className="flex items-center gap-2 font-mono text-[13px] font-semibold text-purple-400">
                                    <RefreshCw className="size-4" />
                                    SessionStart
                                </div>
                                <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                                    Fires when a session starts or resumes. Supports matching by source (startup/resume) to inject environment prompts.
                                </p>
                            </div>

                            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] p-3">
                                <div className="flex items-center gap-2 font-mono text-[13px] font-semibold text-cyan-400">
                                    <Sparkles className="size-4" />
                                    UserPromptSubmit
                                </div>
                                <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                                    Fires when user submits a prompt. Can inject project rules or knowledge base information.
                                </p>
                            </div>

                            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] p-3">
                                <div className="flex items-center gap-2 font-mono text-[13px] font-semibold text-indigo-400">
                                    <Sparkles className="size-4" />
                                    PreCompact
                                </div>
                                <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                                    Fires before session context compaction. Can prevent compaction or save key memories before compacting.
                                </p>
                            </div>

                            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] p-3">
                                <div className="flex items-center gap-2 font-mono text-[13px] font-semibold text-violet-400">
                                    <Sparkles className="size-4" />
                                    PostCompact
                                </div>
                                <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                                    Fires after session context compaction. Can record compaction telemetry.
                                </p>
                            </div>

                            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] p-3">
                                <div className="flex items-center gap-2 font-mono text-[13px] font-semibold text-pink-400">
                                    <Terminal className="size-4" />
                                    SubagentStart
                                </div>
                                <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                                    Fires when a subagent is dispatched and started.
                                </p>
                            </div>

                            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] p-3">
                                <div className="flex items-center gap-2 font-mono text-[13px] font-semibold text-fuchsia-400">
                                    <Terminal className="size-4" />
                                    SubagentStop
                                </div>
                                <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                                    Fires when a subagent finishes or terminates.
                                </p>
                            </div>

                            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] p-3">
                                <div className="flex items-center gap-2 font-mono text-[13px] font-semibold text-red-400">
                                    <Shield className="size-4" />
                                    Stop
                                </div>
                                <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                                    Fires when a main agent turn completes or is stopped.
                                </p>
                            </div>

                            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] p-3 sm:col-span-2">
                                <div className="flex items-center gap-2 font-mono text-[13px] font-semibold text-rose-400">
                                    <RefreshCw className="size-4" />
                                    SessionEnd
                                </div>
                                <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                                    Fires asynchronously when a session ends or is destroyed. Useful for cleaning up temporary resources.
                                </p>
                            </div>
                        </div>
                    </section>

                    <section className="space-y-2">
                        <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
                            {t('settings.hooks.learnMore.format', {
                                defaultValue: 'Input and output format',
                            })}
                        </h3>
                        <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
                            Hook commands receive a JSON payload via standard input (stdin) and the <code className="rounded bg-[var(--bg-card)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--text-primary)]">CODEX_HOOK_PAYLOAD</code> environment variable. The command can output a JSON structure to control execution results, for example:
                        </p>
                        <pre className="overflow-x-auto rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] p-3 font-mono text-[12px] text-[var(--text-primary)]">
{`{
  "continue": true,
  "systemMessage": "Passed preflight checks",
  "hookSpecificOutput": {
    "permissionDecision": "allow",
    "additionalContext": "Additional environment context"
  }
}`}
                        </pre>
                    </section>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end border-t border-[var(--border-subtle)] px-6 py-4">
                    <button
                        type="button"
                        onClick={() => setOpen(false)}
                        className="rounded-lg bg-[var(--bg-sidebar)] px-4 py-2 text-[13px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-sidebar-hover)]"
                    >
                        {t('common.close', { defaultValue: 'Close' })}
                    </button>
                </div>
            </div>
        </div>
    )
}
