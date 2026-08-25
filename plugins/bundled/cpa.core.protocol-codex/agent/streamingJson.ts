/**
 * Tolerant JSON helpers for streaming tool-call argument previews.
 * Final tool arguments must use strict JSON.parse elsewhere.
 */

const VALID_JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u'])

function isControlCharacter(char: string): boolean {
    const codePoint = char.codePointAt(0)
    return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f
}

function escapeControlCharacter(char: string): string {
    switch (char) {
        case '\b':
            return '\\b'
        case '\f':
            return '\\f'
        case '\n':
            return '\\n'
        case '\r':
            return '\\r'
        case '\t':
            return '\\t'
        default:
            return `\\u${char.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`
    }
}

/**
 * Repair malformed JSON string literals by escaping raw control characters
 * and doubling backslashes before invalid escape sequences.
 */
export function repairJson(json: string): string {
    let repaired = ''
    let inString = false
    for (let index = 0; index < json.length; index += 1) {
        const char = json[index]!
        if (!inString) {
            repaired += char
            if (char === '"') {
                inString = true
            }
            continue
        }
        if (char === '"') {
            repaired += char
            inString = false
            continue
        }
        if (char === '\\') {
            const nextChar = json[index + 1]
            if (nextChar === undefined) {
                repaired += '\\\\'
                continue
            }
            if (nextChar === 'u') {
                const unicodeDigits = json.slice(index + 2, index + 6)
                if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
                    repaired += `\\u${unicodeDigits}`
                    index += 5
                    continue
                }
            }
            if (VALID_JSON_ESCAPES.has(nextChar)) {
                repaired += `\\${nextChar}`
                index += 1
                continue
            }
            repaired += '\\\\'
            continue
        }
        repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char
    }
    return repaired
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Close open braces / brackets / strings so partial streaming JSON can parse.
 * Not a full JSON grammar repair — good enough for tool-arg UI previews.
 */
function closePartialJson(partial: string): string {
    let inString = false
    let escaped = false
    const stack: string[] = []

    for (let i = 0; i < partial.length; i += 1) {
        const ch = partial[i]!
        if (inString) {
            if (escaped) {
                escaped = false
                continue
            }
            if (ch === '\\') {
                escaped = true
                continue
            }
            if (ch === '"') {
                inString = false
            }
            continue
        }
        if (ch === '"') {
            inString = true
            continue
        }
        if (ch === '{' || ch === '[') {
            stack.push(ch)
            continue
        }
        if (ch === '}' || ch === ']') {
            const open = stack[stack.length - 1]
            if ((ch === '}' && open === '{') || (ch === ']' && open === '[')) {
                stack.pop()
            }
        }
    }

    let result = partial
    if (inString) {
        // If the last character is a dangling escape, complete it harmlessly.
        if (result.endsWith('\\') && !result.endsWith('\\\\')) {
            result += 'u0000'
        }
        result += '"'
    }

    // Drop trailing colon / comma so `{"a":` or `{"a":1,` can close.
    result = result.replace(/,\s*$/, '')
    if (/:\s*$/.test(result)) {
        result += 'null'
    }

    for (let i = stack.length - 1; i >= 0; i -= 1) {
        result += stack[i] === '{' ? '}' : ']'
    }
    return result
}

function asObjectOrEmpty(value: unknown): Record<string, unknown> {
    return isPlainObject(value) ? value : {}
}

/**
 * Parse potentially incomplete JSON for streaming previews.
 * Always returns a plain object (never throws).
 */
export function parseStreamingJson(
    partialJson: string | undefined | null,
): Record<string, unknown> {
    if (partialJson == null || partialJson.trim() === '') {
        return {}
    }

    const tryParse = (raw: string): Record<string, unknown> | undefined => {
        try {
            return asObjectOrEmpty(JSON.parse(raw))
        } catch {
            return undefined
        }
    }

    const direct = tryParse(partialJson)
    if (direct) return direct

    const repaired = repairJson(partialJson)
    const repairedParsed = tryParse(repaired)
    if (repairedParsed) return repairedParsed

    const closed = tryParse(closePartialJson(partialJson))
    if (closed) return closed

    const closedRepaired = tryParse(closePartialJson(repaired))
    if (closedRepaired) return closedRepaired

    return {}
}
