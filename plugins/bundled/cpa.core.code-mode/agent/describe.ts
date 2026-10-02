import {
    DEFAULT_EXEC_OPTIONS,
    DEFAULT_SCHEMA_BUDGET_BYTES,
    interfaceLanguage,
    type ExecOptions,
    type NamedNestedTool,
    type ToolMode,
} from './protocol'

function byteLength(value: string): number {
    return new TextEncoder().encode(value).length
}

function clipUtf8(value: string, budget: number): string {
    let bytes = 0
    let result = ''
    for (const character of value) {
        const size = byteLength(character)
        if (bytes + size > budget) break
        result += character
        bytes += size
    }
    return result
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
}

export interface RenderedSchema {
    declaration: string
    omitted: boolean
}

export function schemaToTypeScript(
    schema: unknown,
    budgetBytes = DEFAULT_SCHEMA_BUDGET_BYTES,
): RenderedSchema {
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 7) {
        throw new Error('Schema budget must be a safe integer of at least 7 bytes')
    }
    let nodes = 0
    let omitted = false
    const limit = new Error('Schema rendering budget exceeded')
    const root = schema
    const checked = (value: string): string => {
        if (byteLength(value) > budgetBytes) throw limit
        return value
    }
    const unknown = (): string => {
        omitted = true
        return 'unknown'
    }
    const literal = (value: unknown): string => {
        if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) {
            return checked(JSON.stringify(value))
        }
        return unknown()
    }
    const render = (value: unknown, refs: ReadonlySet<string>, depth: number): string => {
        if (++nodes > 512 || depth > 12) return unknown()
        if (value === true) return 'unknown'
        if (value === false) return 'never'
        const obj = objectOf(value)
        if (!obj) return unknown()
        if (typeof obj.$ref === 'string') {
            if (!obj.$ref.startsWith('#/') || refs.has(obj.$ref)) return unknown()
            let target: unknown = root
            for (const part of obj.$ref.slice(2).split('/')) {
                const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
                const parent = objectOf(target)
                target = parent && Object.prototype.hasOwnProperty.call(parent, key) ? parent[key] : undefined
            }
            return render(target, new Set([...refs, obj.$ref]), depth + 1)
        }
        if (Object.prototype.hasOwnProperty.call(obj, 'const')) return literal(obj.const)
        if (Array.isArray(obj.enum)) {
            if (!obj.enum.length) return 'never'
            let result = ''
            for (const value of obj.enum) {
                if (++nodes > 512) return unknown()
                result = checked(result + (result ? ' | ' : '') + literal(value))
            }
            return result
        }
        const alternatives = obj.anyOf ?? obj.oneOf ?? obj.allOf
        if (Array.isArray(alternatives)) {
            if (!alternatives.length) return unknown()
            const separator = obj.allOf === alternatives ? ' & ' : ' | '
            let result = ''
            for (const alternative of alternatives) {
                if (nodes > 512) return unknown()
                result = checked(result + (result ? separator : '') + `(${render(alternative, refs, depth + 1)})`)
            }
            return result
        }
        if (Array.isArray(obj.type)) {
            let result = ''
            for (const type of obj.type) {
                if (nodes > 512) return unknown()
                result = checked(result + (result ? ' | ' : '') + render({ ...obj, type }, refs, depth + 1))
            }
            return result || unknown()
        }
        switch (obj.type) {
            case 'string': return 'string'
            case 'integer':
            case 'number': return 'number'
            case 'boolean': return 'boolean'
            case 'null': return 'null'
            case 'array': return checked(`Array<${render(obj.items ?? true, refs, depth + 1)}>`)
            case 'object':
            case undefined: {
                const properties = objectOf(obj.properties)
                if (!properties && obj.type !== 'object') return unknown()
                const required = new Set(Array.isArray(obj.required) ? obj.required : [])
                let result = '{ '
                for (const [key, property] of Object.entries(properties ?? {})) {
                    if (nodes > 512) return unknown()
                    result = checked(`${result}${JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${render(property, refs, depth + 1)}; `)
                }
                if (obj.additionalProperties !== false) {
                    // Unknown index signatures avoid conflicts with explicitly typed optional properties.
                    result = checked(`${result}[key: string]: unknown; `)
                }
                return checked(`${result}}`)
            }
            default: return unknown()
        }
    }
    try {
        return { declaration: render(schema, new Set(), 0), omitted }
    } catch (error) {
        if (error !== limit) throw error
        return { declaration: 'unknown', omitted: true }
    }
}

export interface ExecDescriptionOptions {
    defaults?: Readonly<ExecOptions>
    schemaBudgetBytes?: number
    locale?: string
}

export function renderExecDescription(
    mode: Exclude<ToolMode, 'direct'>,
    tools: readonly NamedNestedTool[],
    options: ExecDescriptionOptions = {},
): string {
    const defaults = options.defaults ?? DEFAULT_EXEC_OPTIONS
    const rules = [
        'Execute the source string as an async JavaScript function in a backend QuickJS-ng WASM cell with guest promises.',
        'No Node, filesystem, network, console, Atomics, SharedArrayBuffer, WebAssembly, or imports.',
        'Await tools.<name>(input) to call approved tools; every nested call keeps its own approval and hooks.',
        `Also pass description: one short user-visible sentence about what this batch does, written in ${interfaceLanguage(options.locale)}. It is the activity label, not a copy of the source.`,
        'Put every tool call you can already plan into the same exec. Do not spend one exec on one tool.',
        'Start independent calls together with Promise.all. If a later call needs an earlier result, await them in order inside that same exec.',
        'Start another exec only after you must read the combined result and decide the next step yourself.',
        'Example: const [a, b] = await Promise.all([tools.tool_a({ path: "a" }), tools.tool_b({ path: "b" })]); text({ a, b });',
        'Use text(value) or image(value) for output; the return value and raw nested tool output are not shown automatically.',
        'store(key, value) and load(key) share JSON only within this session (256KB per value, 4MB total).',
        'notify(value) emits incremental output. await yield_control() yields an observation while async work continues.',
        'exit() ends successfully. setTimeout/clearTimeout do not keep a cell alive; unawaited work is discarded.',
        `The default yield deadline is ${defaults.yieldTimeMs}ms. Synchronous deadline overruns terminate, never resume.`,
        'An async yield returns a stable cell_id; use wait to observe only new output or terminate the cell.',
        `Output budget defaults to ${defaults.maxOutputTokens} tokens, approximated by characters rather than an exact tokenizer.`,
        'Optional first line: // @exec: {"yield_time_ms":10000,"max_output_tokens":1000}',
        'ALL_TOOLS lists { name, description } with normalized JavaScript names for lookup on tools.',
        'exec and wait are never nested tools.',
    ].join('\n')
    if (mode === 'code') return rules

    const budget = options.schemaBudgetBytes ?? DEFAULT_SCHEMA_BUDGET_BYTES
    if (!Number.isSafeInteger(budget) || budget < 128) {
        throw new Error('Description schema budget must be a safe integer of at least 128 bytes')
    }
    const marker = '\n[Additional tool declarations omitted due to the schema budget.]'
    let declarations = ''
    for (const tool of tools) {
        const rendered = schemaToTypeScript(tool.parameters, budget)
        const section = [
            `\nTool tools.${tool.identifier} (original name: ${JSON.stringify(tool.name)})`,
            clipUtf8(tool.description, 1024),
            '```typescript',
            `declare const tools: { ${JSON.stringify(tool.identifier)}: (input: ${rendered.declaration}) => Promise<unknown> };`,
            '```',
            ...(rendered.omitted ? ['[Schema details omitted; unknown types may require the original tool schema.]'] : []),
        ].join('\n')
        if (byteLength(declarations) + byteLength(section) + byteLength(marker) > budget) {
            declarations += marker
            break
        }
        declarations += section
    }
    return `${rules}\n\nNested tool TypeScript declarations (approximate JSON Schema rendering):\n${declarations}`
}
