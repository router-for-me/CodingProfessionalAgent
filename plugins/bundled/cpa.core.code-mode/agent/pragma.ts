import { DEFAULT_EXEC_OPTIONS, type ExecOptions } from './protocol'

export interface ParsedExecSource extends ExecOptions {
    source: string
}

function safeInteger(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${field} must be a non-negative safe integer`)
    }
    return value
}

export function parseExecSource(
    input: unknown,
    defaults: Readonly<ExecOptions> = DEFAULT_EXEC_OPTIONS,
): ParsedExecSource {
    if (typeof input !== 'string' || !input.trim()) {
        throw new Error('exec source must be a non-empty JavaScript string')
    }
    const options: ExecOptions = {
        yieldTimeMs: safeInteger(defaults.yieldTimeMs, 'defaultExecYieldMs'),
        maxOutputTokens: safeInteger(defaults.maxOutputTokens, 'maxOutputTokens'),
    }
    const newline = input.indexOf('\n')
    const firstLine = (newline < 0 ? input : input.slice(0, newline)).trim()
    const match = /^\/\/\s*@exec:\s*(.*)$/.exec(firstLine)
    if (!match) return { source: input, ...options }

    let pragma: unknown
    try {
        pragma = JSON.parse(match[1])
    } catch {
        throw new Error('Invalid // @exec: pragma: expected a JSON object')
    }
    if (!pragma || typeof pragma !== 'object' || Array.isArray(pragma)) {
        throw new Error('Invalid // @exec: pragma: expected a JSON object')
    }
    for (const [field, value] of Object.entries(pragma)) {
        if (field === 'yield_time_ms') {
            options.yieldTimeMs = safeInteger(value, field)
        } else if (field === 'max_output_tokens') {
            options.maxOutputTokens = safeInteger(value, field)
        } else {
            throw new Error(`Unknown // @exec: pragma field: ${field}`)
        }
    }
    const source = newline < 0 ? '' : input.slice(newline + 1)
    if (!source.trim()) throw new Error('exec source must contain code after the // @exec: pragma')
    return { source, ...options }
}
