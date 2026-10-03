import { isMandatoryDirectTool } from '../shared/toolPolicy'
import type { NamedNestedTool, NestedToolSpecification } from './protocol'

export function normalizeToolIdentifier(name: string): string {
    const normalized = name.replace(/[^A-Za-z0-9_$]/gu, '_')
    if (!normalized) return '_'
    return normalized.replace(/^[^A-Za-z_$]/, '_')
}

export interface NestedToolSelectionOptions {
    excludedToolNames?: readonly string[]
    directOnlyToolNames?: readonly string[]
    warn?: (message: string) => void
}

export interface NestedToolSelection {
    tools: NamedNestedTool[]
    warnings: string[]
}

export function selectNestedTools(
    tools: readonly NestedToolSpecification[],
    options: NestedToolSelectionOptions = {},
): NestedToolSelection {
    const excluded = new Set([
        ...options.excludedToolNames ?? [],
        ...options.directOnlyToolNames ?? [],
    ])
    const identifiers = new Set<string>()
    const selected: NamedNestedTool[] = []
    const warnings: string[] = []
    for (const tool of tools) {
        if (isMandatoryDirectTool(tool.name) || excluded.has(tool.name) || tool.exposure === 'direct') continue
        const identifier = normalizeToolIdentifier(tool.name)
        if (identifiers.has(identifier)) {
            const message = `Skipped nested tool ${JSON.stringify(tool.name)}: duplicate JavaScript identifier ${JSON.stringify(identifier)}`
            warnings.push(message)
            options.warn?.(message)
            continue
        }
        identifiers.add(identifier)
        selected.push({ ...tool, identifier })
    }
    return { tools: selected, warnings }
}
