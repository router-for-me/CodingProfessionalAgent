import { isBuiltinSlashCommand } from './slashCommands.js'
import type { PromptTemplate } from '../types.js'

export function parseCommandArgs(argsString: string): string[] {
    const input = typeof argsString === 'string' ? argsString : ''
    const args: string[] = []
    let current = ''
    let inQuote: '"' | "'" | null = null
    let sawQuoted = false

    for (let i = 0; i < input.length; i += 1) {
        const char = input[i]!

        if (inQuote) {
            if (char === '\\') {
                const next = input[i + 1]
                if (next === undefined) {
                    current += '\\'
                    continue
                }
                current += next
                i += 1
                continue
            }
            if (char === inQuote) {
                inQuote = null
                sawQuoted = true
                continue
            }
            current += char
            continue
        }

        if (char === '\\') {
            const next = input[i + 1]
            if (next === undefined) {
                current += '\\'
                continue
            }
            current += next
            i += 1
            continue
        }

        if (char === '"' || char === "'") {
            inQuote = char
            sawQuoted = true
            continue
        }

        if (/\s/.test(char)) {
            if (current.length > 0 || sawQuoted) {
                args.push(current)
                current = ''
                sawQuoted = false
            }
            continue
        }

        current += char
    }

    if (inQuote) {
        throw new Error(`unclosed ${inQuote === '"' ? 'double' : 'single'} quote in command arguments`)
    }

    if (current.length > 0 || sawQuoted) {
        args.push(current)
    }

    return args
}

export function substituteArgs(content: string, args: string[]): string {
    const allArgs = args.join(' ')
    const source = typeof content === 'string' ? content : ''

    return source.replace(
        /\$\{(\d+):-([^}]*)\}|\$\{(ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
        (
            _match,
            defaultNum: string | undefined,
            defaultValue: string | undefined,
            allDefaultKind: string | undefined,
            allDefaultValue: string | undefined,
            sliceStart: string | undefined,
            sliceLength: string | undefined,
            simple: string | undefined,
        ) => {
            if (defaultNum !== undefined) {
                const index = parseInt(defaultNum, 10) - 1
                if (!Number.isFinite(index) || index < 0) {
                    return defaultValue ?? ''
                }
                const value = args[index]
                return value ? value : (defaultValue ?? '')
            }

            if (allDefaultKind !== undefined) {
                if (args.length === 0 || allArgs === '') {
                    return allDefaultValue ?? ''
                }
                const hasNonEmpty = args.some((arg) => arg.length > 0)
                if (!hasNonEmpty) {
                    return allDefaultValue ?? ''
                }
                return allArgs
            }

            if (sliceStart !== undefined) {
                let start = parseInt(sliceStart, 10) - 1
                if (!Number.isFinite(start)) {
                    return ''
                }
                if (start < 0) {
                    start = 0
                }
                if (start >= args.length) {
                    return ''
                }
                if (sliceLength !== undefined) {
                    const length = parseInt(sliceLength, 10)
                    if (!Number.isFinite(length) || length <= 0) {
                        return ''
                    }
                    return args.slice(start, start + length).join(' ')
                }
                return args.slice(start).join(' ')
            }

            if (simple === 'ARGUMENTS' || simple === '@') {
                return allArgs
            }

            if (simple !== undefined) {
                const index = parseInt(simple, 10) - 1
                if (!Number.isFinite(index) || index < 0) {
                    return ''
                }
                return args[index] ?? ''
            }

            return ''
        },
    )
}

export function expandPromptTemplate(text: string, templates: readonly PromptTemplate[] = []): string {
    if (typeof text !== 'string' || !text.startsWith('/')) {
        return text
    }

    if (text.startsWith('/skill:') || isBuiltinSlashCommand(text)) {
        return text
    }

    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
    if (!match) {
        return text
    }

    const templateName = match[1]!
    const argsString = match[2] ?? ''
    const template = templates.find((entry) => entry.name === templateName)
    if (!template) {
        return text
    }

    try {
        const args = parseCommandArgs(argsString)
        return substituteArgs(template.content, args)
    } catch {
        return text
    }
}
