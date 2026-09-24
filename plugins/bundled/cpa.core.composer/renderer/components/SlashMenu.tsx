import type { KeyboardEvent } from 'react'
import { cn, useTranslation } from '@cpa/plugin-ui'
import type { ActionContribution } from '@cpa/plugin-api'
import type { PromptTemplate, Skill } from '../types.js'
import {
    COMPACT_COMMAND_ALIASES,
    MODEL_COMMAND_ALIASES,
    matchSlashQuery,
} from '../utils/slashCommands.js'

export type SlashGroup = 'builtin' | 'skill' | 'template'

export interface SlashSuggestion {
    id: string
    group: SlashGroup
    command: string
    description: string
    insertText: string
    disabled?: boolean
    aliases?: readonly string[]
    action?: 'compact' | 'model' | (string & {})
}

export interface BuildSlashSuggestionsInput {
    query: string
    skills: readonly Pick<Skill, 'name' | 'description' | 'disableModelInvocation'>[]
    prompts: readonly Pick<PromptTemplate, 'name' | 'description'>[]
    compactDescription?: string
    compactName?: string
    modelDescription?: string
    modelName?: string
    actions?: readonly ActionContribution[]
}

export interface BuildSlashSuggestionsResult {
    suggestions: SlashSuggestion[]
    diagnostics: string[]
}

export const SLASH_MENU_LISTBOX_ID = 'composer-slash-menu'

export function sanitizeAriaId(value: string): string {
    const cleaned = String(value ?? '')
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
    return cleaned || 'id'
}

export function buildSlashSuggestions(
    input: BuildSlashSuggestionsInput,
): SlashSuggestion[] {
    return buildSlashSuggestionsWithDiagnostics(input).suggestions
}

export function buildSlashSuggestionsWithDiagnostics(
    input: BuildSlashSuggestionsInput,
): BuildSlashSuggestionsResult {
    const query = (input.query ?? '').toLowerCase()
    const items: SlashSuggestion[] = []
    const diagnostics: string[] = []
    const claimed = new Map<string, SlashGroup>()

    const claim = (
        commandBody: string,
        group: SlashGroup,
        suggestion: SlashSuggestion,
        extraKeys?: readonly string[],
    ): boolean => {
        const key = commandBody.toLowerCase()
        const existing = claimed.get(key)
        if (existing) {
            diagnostics.push(
                `slash collision: /${commandBody} (${group}) hidden; kept ${existing}`,
            )
            return false
        }
        claimed.set(key, group)
        if (extraKeys) {
            for (const extra of extraKeys) {
                const eKey = extra.toLowerCase()
                if (!claimed.has(eKey)) {
                    claimed.set(eKey, group)
                }
            }
        }
        items.push(suggestion)
        return true
    }

    let optionIndex = 0
    const slashActions = input.actions ?? []
    let hasCompact = false
    let hasModel = false

    for (const action of slashActions) {
        const rawName = action.id.startsWith('/') ? action.id.slice(1) : action.id
        const commandBody =
            rawName === 'composer.compact'
                ? 'compact'
                : rawName === 'open-model-selector'
                  ? 'model'
                  : rawName

        if (commandBody === 'compact') {
            hasCompact = true
        } else if (commandBody === 'model') {
            hasModel = true
        }

        const command = `/${commandBody}`
        const description =
            commandBody === 'compact' && input.compactDescription
                ? input.compactDescription
                : commandBody === 'model' && input.modelDescription
                  ? input.modelDescription
                  : (action.description ?? action.title)

        const aliases =
            commandBody === 'compact'
                ? COMPACT_COMMAND_ALIASES
                : commandBody === 'model'
                  ? MODEL_COMMAND_ALIASES
                  : undefined

        const suggestion: SlashSuggestion = {
            id: slashOptionId('builtin', commandBody, optionIndex),
            group: 'builtin',
            command,
            description,
            insertText: `${command} `,
            aliases,
            action: commandBody === 'compact' ? 'compact' : commandBody === 'model' ? 'model' : undefined,
        }

        if (matchesQuery(query, commandBody, description, aliases)) {
            if (claim(commandBody, 'builtin', suggestion, aliases)) optionIndex += 1
        }
    }

    // 1. Register builtin Compact command if not already registered via actions
    if (!hasCompact) {
        const compactName = (input.compactName || 'compact').trim()
        const compactDesc =
            input.compactDescription ?? 'Compact conversation context'
        const compactCmd = `/${compactName}`
        const compactAliases = Array.from(
            new Set([...COMPACT_COMMAND_ALIASES, compactName.toLowerCase()]),
        )

        const compact: SlashSuggestion = {
            id: slashOptionId('builtin', 'compact', optionIndex),
            group: 'builtin',
            command: compactCmd,
            description: compactDesc,
            insertText: `${compactCmd} `,
            aliases: compactAliases,
            action: 'compact',
        }
        if (matchesQuery(query, compactName, compactDesc, compactAliases)) {
            if (claim('compact', 'builtin', compact, [compactName, ...compactAliases])) {
                optionIndex += 1
            }
        }
    }

    // 2. Register builtin Model command if not already registered via actions
    if (!hasModel) {
        const modelName = (input.modelName || 'model').trim()
        const modelDesc = input.modelDescription ?? 'Open model selector'
        const modelCmd = `/${modelName}`
        const modelAliases = Array.from(
            new Set([...MODEL_COMMAND_ALIASES, modelName.toLowerCase()]),
        )

        const model: SlashSuggestion = {
            id: slashOptionId('builtin', 'model', optionIndex),
            group: 'builtin',
            command: modelCmd,
            description: modelDesc,
            insertText: `${modelCmd} `,
            aliases: modelAliases,
            action: 'model',
        }
        if (matchesQuery(query, modelName, modelDesc, modelAliases)) {
            if (claim('model', 'builtin', model, [modelName, ...modelAliases])) {
                optionIndex += 1
            }
        }
    }

    // 3. Register template commands
    const prompts = [...input.prompts].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
    for (const prompt of prompts) {
        const commandBody = prompt.name
        const command = `/${commandBody}`
        const suggestion: SlashSuggestion = {
            id: slashOptionId('template', prompt.name, optionIndex),
            group: 'template',
            command,
            description: prompt.description,
            insertText: `${command} `,
        }
        if (matchesQuery(query, commandBody, prompt.description)) {
            if (claim(commandBody, 'template', suggestion)) optionIndex += 1
        }
    }

    return { suggestions: items, diagnostics }
}

export function slashOptionId(
    group: SlashGroup | string,
    name: string,
    index = 0,
    prefix = 'slash-option',
): string {
    const escaped = sanitizeAriaId(String(name).toLowerCase())
    return `${sanitizeAriaId(prefix)}-${sanitizeAriaId(String(group))}-${index}-${escaped}`
}

export function matchesQuery(
    query: string,
    commandBody: string,
    description: string,
    aliases?: readonly string[],
): boolean {
    return matchSlashQuery(query, commandBody, description, aliases)
}

export interface SlashMenuProps {
    suggestions: readonly SlashSuggestion[]
    activeIndex: number
    onActiveIndexChange: (index: number) => void
    onSelect: (suggestion: SlashSuggestion) => void
    onClose: () => void
    className?: string
    id?: string
}

export function SlashMenu({
    suggestions,
    activeIndex,
    onActiveIndexChange,
    onSelect,
    onClose,
    className,
    id = SLASH_MENU_LISTBOX_ID,
}: SlashMenuProps) {
    const { t } = useTranslation()

    if (suggestions.length === 0) return null

    const safeIndex =
        ((activeIndex % suggestions.length) + suggestions.length) %
        suggestions.length
    const active = suggestions[safeIndex]!

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault()
            onActiveIndexChange((safeIndex + 1) % suggestions.length)
            return
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault()
            onActiveIndexChange(
                (safeIndex - 1 + suggestions.length) % suggestions.length,
            )
            return
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault()
            onSelect(active)
            return
        }
        if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
        }
    }

    return (
        <div
            id={id}
            role="listbox"
            tabIndex={-1}
            aria-label={t('slash.menuLabel', { defaultValue: 'Commands' })}
            aria-activedescendant={active.id}
            onKeyDown={handleKeyDown}
            className={cn(
                'absolute bottom-full left-0 right-0 z-[60] mb-2 max-h-64 overflow-y-auto',
                'rounded-[var(--radius-card)] border border-[var(--border-subtle)]',
                'bg-[var(--bg-elevated)] py-1 shadow-lg',
                className,
            )}
        >
            {suggestions.map((item, index) => {
                const selected = index === safeIndex
                return (
                    <button
                        key={item.id}
                        id={item.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onMouseDown={(event) => {
                            event.preventDefault()
                            onSelect(item)
                        }}
                        onMouseEnter={() => onActiveIndexChange(index)}
                        className={cn(
                            'flex w-full items-center gap-3 px-3 py-1.5 text-left transition-colors',
                            selected
                                ? 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)]'
                                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                        )}
                    >
                        <span className="shrink-0 font-mono text-[13px]">{item.command}</span>
                        {item.description ? (
                            <span className="min-w-0 flex-1 truncate text-right text-[11px] text-[var(--text-muted)]">
                                {item.description}
                            </span>
                        ) : null}
                    </button>
                )
            })}
        </div>
    )
}

export function getSlashQuery(text: string): string | null {
    if (!text.startsWith('/')) return null
    if (/[\s\u3000]/.test(text)) return null
    return text.slice(1)
}
