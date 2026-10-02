export type ToolMode = 'direct' | 'code' | 'code-only'

export interface ExecOptions {
    yieldTimeMs: number
    maxOutputTokens: number
}

export interface NestedToolSpecification {
    name: string
    description: string
    parameters: Record<string, unknown>
    exposure?: 'direct' | 'code-nested' | 'both'
}

export interface NamedNestedTool extends NestedToolSpecification {
    identifier: string
}

export const DEFAULT_EXEC_YIELD_MS = 30_000
export const DEFAULT_WAIT_YIELD_MS = 10_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000
export const DEFAULT_SCHEMA_BUDGET_BYTES = 16 * 1024

export const DEFAULT_EXEC_OPTIONS: Readonly<ExecOptions> = Object.freeze({
    yieldTimeMs: DEFAULT_EXEC_YIELD_MS,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
})

// These are ordinary Responses function parameters, not freeform or Lark tools.
export const EXEC_PARAMETERS: Readonly<Record<string, unknown>> = {
    type: 'object',
    properties: {
        source: {
            type: 'string',
            description: 'Raw JavaScript source. Optional first line: // @exec: {"yield_time_ms":10000,"max_output_tokens":1000}',
        },
        description: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            description: 'Short user-visible summary of this batch, shown in the activity line. One sentence describing what the code does, not the source itself.',
        },
    },
    required: ['source', 'description'],
    additionalProperties: false,
}

export function interfaceLanguage(locale?: string): string {
    return locale === 'en' ? 'English (en)' : 'Simplified Chinese (zh-CN)'
}

export function execParametersForLocale(locale?: string): Record<string, unknown> {
    const parameters = structuredClone(EXEC_PARAMETERS) as {
        properties: { description: { description: string } }
    }
    parameters.properties.description.description = `Short user-visible summary of this batch, shown in the activity line. One sentence describing what the code does, not the source itself. Write it in the current interface language: ${interfaceLanguage(locale)}.`
    return parameters
}

export const WAIT_PARAMETERS: Readonly<Record<string, unknown>> = {
    type: 'object',
    properties: {
        cell_id: { type: 'string', description: 'The stable cell_id returned by exec.' },
        yield_time_ms: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        max_tokens: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        terminate: { type: 'boolean', description: 'Terminate the cell instead of waiting.' },
    },
    required: ['cell_id'],
    additionalProperties: false,
}
