import { describe, expect, it, vi } from 'vitest'
import { normalizeToolIdentifier, selectNestedTools } from './names'
import type { NestedToolSpecification } from './protocol'

const tool = (name: string, exposure?: NestedToolSpecification['exposure']): NestedToolSpecification => ({
    name, description: `Description for ${name}`, parameters: { type: 'object' }, exposure,
})

describe('Code Mode nested tool names', () => {
    it.each([
        ['read', 'read'],
        ['mcp__server__foo', 'mcp__server__foo'],
        ['file-read.v2', 'file_read_v2'],
        ['3abc', '_abc'],
        ['123', '_23'],
        ['$thing_2', '$thing_2'],
        ['', '_'],
        ['读取', '__'],
        ['🌊tool', '_tool'],
        ['a/b:c', 'a_b_c'],
    ])('normalizes %s to %s using Codex code-point semantics', (name, expected) => {
        expect(normalizeToolIdentifier(name)).toBe(expected)
    })

    it('keeps the first colliding tool and reports a warning', () => {
        const warn = vi.fn()
        const selection = selectNestedTools([tool('file-read'), tool('file.read'), tool('file_read'), tool('read')], { warn })
        expect(selection.tools.map((entry) => entry.name)).toEqual(['file-read', 'read'])
        expect(selection.warnings).toHaveLength(2)
        expect(warn).toHaveBeenCalledTimes(2)
        expect(selection.warnings[0]).toContain('file_read')
    })

    it('excludes orchestration tools and exact configured names, not prefixes', () => {
        const selection = selectNestedTools([
            tool('exec'), tool('wait'), tool('read'), tool('read_more'), tool('bash'), tool('edit'), tool('network', 'direct'),
        ], { excludedToolNames: ['read'], directOnlyToolNames: ['bash'] })
        expect(selection.tools.map((entry) => entry.name)).toEqual(['read_more', 'edit'])
    })

    it('allows both/default and code-nested exposure without changing original objects', () => {
        const entries = [tool('read'), tool('write', 'both'), tool('foo', 'code-nested')]
        const snapshot = structuredClone(entries)
        expect(selectNestedTools(entries).tools.map((entry) => entry.identifier)).toEqual(['read', 'write', 'foo'])
        expect(entries).toEqual(snapshot)
        expect(entries[0]).not.toHaveProperty('identifier')
    })

    it('does not let prototype names interfere with collision tracking', () => {
        expect(selectNestedTools([tool('__proto__'), tool('constructor'), tool('toString')]).tools).toHaveLength(3)
    })

    it('does not reserve identifiers for excluded tools', () => {
        const result = selectNestedTools([tool('file-read', 'direct'), tool('file.read')])
        expect(result.tools.map((entry) => entry.name)).toEqual(['file.read'])
        expect(result.warnings).toEqual([])
    })
})


it.each([undefined, 'both', 'code-nested', 'direct'] as const)('never selects subagents with exposure %s and empty settings', (exposure) => {
    const selection = selectNestedTools(['spawn_agent', 'send_message', 'send_input', 'stop_agent', 'read'].map((name) => tool(name, exposure)), { directOnlyToolNames: [], excludedToolNames: [] })
    expect(selection.tools.map((entry) => entry.name)).toEqual(exposure === 'direct' ? [] : ['read'])
})
