/**
 * Canonical slash command definitions and aliases across languages.
 */
export const COMPACT_COMMAND_ALIASES = ['compact', '压缩', 'compress'] as const
export const MODEL_COMMAND_ALIASES = ['model', '模型', 'models'] as const

export interface ParsedSlashCommand {
    type: 'compact' | 'model' | 'unknown'
    focus: string
    commandToken: string
}

/**
 * Checks whether a given raw text begins with a known builtin slash command.
 */
export function isBuiltinSlashCommand(text: string): boolean {
    const trimmed = text.trim()
    if (!trimmed.startsWith('/')) return false

    const match = trimmed.match(/^\/([^\s\u3000]+)/)
    if (!match) return false

    const cmd = match[1]!.toLowerCase()
    return (
        COMPACT_COMMAND_ALIASES.includes(cmd as any) ||
        MODEL_COMMAND_ALIASES.includes(cmd as any) ||
        cmd.startsWith('skill:')
    )
}

/**
 * Parses user input into a recognized builtin slash command and any attached argument/focus.
 */
export function parseSlashCommand(
    text: string,
    extraAliases?: {
        compact?: string[]
        model?: string[]
    },
): ParsedSlashCommand {
    const trimmed = text.trim()
    if (!trimmed.startsWith('/')) {
        return { type: 'unknown', focus: '', commandToken: '' }
    }

    const match = trimmed.match(/^\/([^\s\u3000]+)(?:[\s\u3000]+([\s\S]*))?$/)
    if (!match) {
        return { type: 'unknown', focus: '', commandToken: '' }
    }

    const token = match[1]!.toLowerCase()
    const rest = (match[2] ?? '').trim()

    const compactSet = new Set<string>([
        ...COMPACT_COMMAND_ALIASES,
        ...(extraAliases?.compact?.map((c) => c.toLowerCase()) ?? []),
    ])
    if (compactSet.has(token)) {
        return { type: 'compact', focus: rest, commandToken: token }
    }

    const modelSet = new Set<string>([
        ...MODEL_COMMAND_ALIASES,
        ...(extraAliases?.model?.map((m) => m.toLowerCase()) ?? []),
    ])
    if (modelSet.has(token)) {
        return { type: 'model', focus: rest, commandToken: token }
    }

    return { type: 'unknown', focus: rest, commandToken: token }
}

/**
 * Matches a query against a slash command's body name and aliases.
 */
export function matchSlashQuery(
    query: string,
    commandBody: string,
    _description: string,
    aliases?: readonly string[],
): boolean {
    if (!query) return true
    const q = query.toLowerCase().trim()
    if (!q) return true

    // 1. Direct match on command name prefix
    const body = commandBody.toLowerCase()
    if (body.startsWith(q)) return true

    // 2. Match on any localized alias prefix
    if (aliases && aliases.length > 0) {
        for (const alias of aliases) {
            const a = alias.toLowerCase()
            if (a.startsWith(q)) return true
        }
    }

    return false
}
