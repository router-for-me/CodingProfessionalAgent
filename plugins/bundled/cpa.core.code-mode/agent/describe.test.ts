import { describe, expect, it } from 'vitest'
import { codeModeBatchGuidance, renderExecDescription, schemaToTypeScript } from './describe'
import { selectNestedTools } from './names'
import { DEFAULT_SCHEMA_BUDGET_BYTES } from './protocol'

const bytes = (text: string): number => new TextEncoder().encode(text).length
const selected = selectNestedTools([{
    name: 'file-read', description: 'Read a file.', parameters: {
        type: 'object', properties: { path: { type: 'string' }, limit: { type: 'integer' } },
        required: ['path'], additionalProperties: false,
    },
}]).tools

describe('Code Mode schema to TypeScript', () => {
    it.each([
        [{ type: 'string' }, 'string'],
        [{ type: 'number' }, 'number'],
        [{ type: 'integer' }, 'number'],
        [{ type: 'boolean' }, 'boolean'],
        [{ type: 'null' }, 'null'],
        [true, 'unknown'],
        [false, 'never'],
        [{ enum: ['a', 1, false, null] }, '"a" | 1 | false | null'],
        [{ const: 'a"b' }, '"a\\"b"'],
        [{ enum: [] }, 'never'],
        [{ type: ['string', 'null'] }, 'string | null'],
        [{ type: 'array', items: { type: 'number' } }, 'Array<number>'],
        [{ type: 'array' }, 'Array<unknown>'],
    ])('renders %j', (schema, expected) => {
        expect(schemaToTypeScript(schema)).toEqual({ declaration: expected, omitted: false })
    })

    it('renders required and optional object properties with escaped names', () => {
        const schema = {
            type: 'object', properties: {
                path: { type: 'string' }, 'with-dash': { type: 'array', items: { type: 'boolean' } },
            }, required: ['path'], additionalProperties: false,
        }
        expect(schemaToTypeScript(schema).declaration).toBe('{ "path": string; "with-dash"?: Array<boolean>; }')
    })

    it('allows unknown extra properties by default', () => {
        expect(schemaToTypeScript({ type: 'object' }).declaration).toBe('{ [key: string]: unknown; }')
    })

    it('expands local refs including escaped JSON pointers', () => {
        const schema = {
            $defs: { 'a/b~c': { type: 'string' } }, type: 'object',
            properties: { value: { $ref: '#/$defs/a~1b~0c' } }, additionalProperties: false,
        }
        expect(schemaToTypeScript(schema)).toEqual({ declaration: '{ "value"?: string; }', omitted: false })
    })

    it('bounds cyclic, missing, and remote refs without resolving external resources', () => {
        for (const schema of [
            { $ref: '#/$defs/loop', $defs: { loop: { $ref: '#/$defs/loop' } } },
            { $ref: '#/$defs/missing' },
            { $ref: 'https://example.com/schema.json' },
        ]) {
            expect(schemaToTypeScript(schema)).toEqual({ declaration: 'unknown', omitted: true })
        }
    })

    it('renders unions and intersections', () => {
        expect(schemaToTypeScript({ anyOf: [{ type: 'string' }, { type: 'number' }] }).declaration).toBe('(string) | (number)')
        expect(schemaToTypeScript({ oneOf: [{ const: 1 }, { const: 2 }] }).declaration).toBe('(1) | (2)')
        expect(schemaToTypeScript({ allOf: [{ type: 'object', additionalProperties: false }, { type: 'object' }] }).declaration).toBe('({ }) & ({ [key: string]: unknown; })')
    })

    it('fails soft with a valid unknown type for oversized schemas', () => {
        const schema = { enum: ['界'.repeat(DEFAULT_SCHEMA_BUDGET_BYTES)] }
        const rendered = schemaToTypeScript(schema)
        expect(rendered).toEqual({ declaration: 'unknown', omitted: true })
        expect(bytes(rendered.declaration)).toBeLessThanOrEqual(DEFAULT_SCHEMA_BUDGET_BYTES)
    })

    it('bounds node count and depth, even with actual object cycles', () => {
        expect(schemaToTypeScript({ enum: Array.from({ length: 2000 }, (_, index) => index) }).omitted).toBe(true)
        const cyclic: Record<string, unknown> = { type: 'array' }
        cyclic.items = cyclic
        expect(schemaToTypeScript(cyclic).omitted).toBe(true)
    })

    it('marks unsupported schema details instead of inventing a type', () => {
        expect(schemaToTypeScript({ type: 'custom' })).toEqual({ declaration: 'unknown', omitted: true })
        expect(schemaToTypeScript({ enum: [{ foo: 'bar' }] })).toEqual({ declaration: 'unknown', omitted: true })
    })

    it.each([0, 6, -1, 1.5, Infinity])('rejects unsafe schema budget %s', (budget) => {
        expect(() => schemaToTypeScript({}, budget)).toThrow('Schema budget')
    })
})

describe('Code Mode batch guidance', () => {
    it('reserves code mode for multi-tool work and stays silent otherwise', () => {
        const guidance = codeModeBatchGuidance('code')
        expect(guidance).toContain('Do not use `code mode` for single or standalone tool invocations')
        expect(guidance).toContain('Call the specific native tool directly (e.g., `bash`)')
        expect(guidance).toContain('Reserve `code mode` strictly for multi-tool parallel orchestration')
        expect(guidance).toContain('Promise.all')
        expect(codeModeBatchGuidance('code-only')).toBeUndefined()
        expect(codeModeBatchGuidance('direct')).toBeUndefined()
    })
})

describe('Code Mode exec descriptions', () => {
    it('includes normalized names, original names, descriptions, and declarations in code-only', () => {
        const description = renderExecDescription('code-only', selected)
        expect(description).toContain('tools.file_read')
        expect(description).toContain('original name: "file-read"')
        expect(description).toContain('Read a file.')
        expect(description).toContain('"path": string; "limit"?: number;')
        expect(description).toContain('ALL_TOOLS')
        expect(description).toContain('Do not spend one exec on one tool')
        expect(description).toContain('Also pass description')
        expect(description).toContain('Simplified Chinese (zh-CN)')
        expect(description).toContain('Promise.all')
        expect(description).toContain('tools.tool_a')
        expect(description).toContain('unawaited work is discarded')
        expect(description).toContain('No Node, filesystem, network, console')
        expect(description).toContain('Synchronous deadline overruns terminate, never resume')
        expect(description).toContain('approximated by characters')
    })

    it('does not repeat nested tool declarations in code', () => {
        const description = renderExecDescription('code', selected)
        expect(description).not.toContain('Read a file.')
        expect(description).not.toContain('declare const tools')
        expect(description).not.toContain('file_read')
        expect(description).toContain('Promise.all')
    })

    it('uses configured defaults in model instructions', () => {
        expect(renderExecDescription('code', [], { defaults: { yieldTimeMs: 12, maxOutputTokens: 34 } })).toContain('12ms')
        expect(renderExecDescription('code', [], { defaults: { yieldTimeMs: 12, maxOutputTokens: 34 } })).toContain('34 tokens')
        expect(renderExecDescription('code', [], { locale: 'en' })).toContain('English (en)')
        expect(renderExecDescription('code', [], { locale: 'zh-CN' })).toContain('Simplified Chinese (zh-CN)')
    })

    it('omits entire declarations at the shared 16KB UTF-8 budget', () => {
        const tools = Array.from({ length: 100 }, (_, index) => ({ ...selected[0], name: `tool_${index}`, identifier: `tool_${index}`, description: '界'.repeat(1000) }))
        const description = renderExecDescription('code-only', tools)
        const declarations = description.split('rendering):\n')[1]
        expect(bytes(declarations)).toBeLessThanOrEqual(DEFAULT_SCHEMA_BUDGET_BYTES)
        expect(declarations).toContain('Additional tool declarations omitted')
        expect(declarations.match(/```/g)!.length % 2).toBe(0)
        expect(declarations).not.toContain('\uFFFD')
    })

    it('marks oversized schemas as omitted without truncating TypeScript syntax', () => {
        const description = renderExecDescription('code-only', [{ ...selected[0], parameters: { enum: ['x'.repeat(20_000)] } }])
        expect(description).toContain('(input: unknown)')
        expect(description).toContain('Schema details omitted')
    })

    it('handles an oversized tool name without exceeding the declaration budget', () => {
        const description = renderExecDescription('code-only', [{ ...selected[0], name: 'x'.repeat(20_000) }])
        expect(bytes(description.split('rendering):\n')[1])).toBeLessThanOrEqual(DEFAULT_SCHEMA_BUDGET_BYTES)
        expect(description).toContain('Additional tool declarations omitted')
    })

    it.each([0, 127, -1, 128.5, Infinity])('rejects unsafe description budget %s', (budget) => {
        expect(() => renderExecDescription('code-only', selected, { schemaBudgetBytes: budget })).toThrow('Description schema budget')
    })
})


it.each(['code', 'code-only'] as const)('limits batching guidance to eligible tools in %s', (mode) => {
    const description = renderExecDescription(mode, selected)
    expect(description).toContain('always call them at the top level, never inside exec')
    expect(description).toContain('not to poll subagents')
    expect(description).toContain('Batch eligible nested tool calls')
    expect(description).not.toContain('Put every tool call')
    if (mode === 'code') expect(codeModeBatchGuidance(mode)).toContain('direct-only')
})
