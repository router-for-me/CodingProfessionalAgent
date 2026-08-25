/**
 * YAML frontmatter extraction for CPA markdown resources.
 * Browser-safe: no Node fs/path/Buffer.
 * Uses a hardened yaml parseDocument + recursive plain-value sanitize.
 */

import { parseDocument } from 'yaml'

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const YAML_PARSE_OPTIONS = {
    schema: 'core' as const,
    uniqueKeys: true,
    strict: true,
    merge: false,
    resolveKnownTags: false,
    prettyErrors: true,
}

export interface ParseFrontmatterResult {
    frontmatter: Record<string, unknown>
    body: string
}

export class FrontmatterError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'FrontmatterError'
    }
}

export function parseFrontmatter(markdown: string): ParseFrontmatterResult {
    const withoutBom = stripBom(typeof markdown === 'string' ? markdown : '')
    const normalized = normalizeNewlines(withoutBom)
    const extracted = extractFrontmatter(normalized)
    if (extracted.yamlString === null) {
        return { frontmatter: {}, body: extracted.body }
    }

    return {
        frontmatter: parseYamlMapping(extracted.yamlString),
        body: extracted.body,
    }
}

export function stripFrontmatter(markdown: string): string {
    return parseFrontmatter(markdown).body
}

function parseYamlMapping(yamlString: string): Record<string, unknown> {
    if (yamlString.trim() === '') {
        return {}
    }

    const doc = parseDocument(yamlString, YAML_PARSE_OPTIONS)

    if (doc.errors.length > 0) {
        throw new FrontmatterError(
            `invalid frontmatter YAML: ${doc.errors.map((error: any) => error.message).join('; ')}`,
        )
    }
    if (doc.warnings.length > 0) {
        throw new FrontmatterError(
            `invalid frontmatter YAML warning: ${doc.warnings
                .map((warning: any) => warning.message)
                .join('; ')}`,
        )
    }

    let parsed: unknown
    try {
        parsed = doc.toJS({ maxAliasCount: 0 })
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new FrontmatterError(`invalid frontmatter YAML: ${detail}`)
    }

    if (parsed === null || parsed === undefined) {
        return {}
    }

    if (typeof parsed !== 'object' || Array.isArray(parsed) || !isPlainObject(parsed)) {
        const kind = Array.isArray(parsed)
            ? 'array'
            : parsed === null
              ? 'null'
              : typeof parsed
        throw new FrontmatterError(
            `frontmatter YAML root must be a mapping object, got ${kind}`,
        )
    }

    const sanitized = sanitizeValue(parsed, new Set<object>())
    if (!isPlainObject(sanitized) || sanitized === null) {
        throw new FrontmatterError('frontmatter YAML root must be a plain mapping object')
    }
    return sanitized as Record<string, unknown>
}

function extractFrontmatter(normalized: string): { yamlString: string | null; body: string } {
    if (!isOpeningDelimiter(normalized)) {
        return { yamlString: null, body: normalized }
    }

    const afterOpen = normalized.startsWith('---\n')
        ? normalized.slice(4)
        : normalized.slice(3)

    const closeMatch = afterOpen.match(/(?:^|\n)---(?:\r?\n|$)/)
    if (!closeMatch || closeMatch.index === undefined) {
        return { yamlString: null, body: normalized }
    }

    const yamlString = afterOpen.slice(0, closeMatch.index)
    const afterClose = afterOpen.slice(closeMatch.index + closeMatch[0].length)

    return { yamlString, body: afterClose.trim() }
}

function isOpeningDelimiter(normalized: string): boolean {
    return normalized === '---' || normalized.startsWith('---\n')
}

function stripBom(text: string): string {
    if (text.charCodeAt(0) === 0xfeff) {
        return text.slice(1)
    }
    return text
}

function normalizeNewlines(text: string): string {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null) {
        return false
    }
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
}

function sanitizeValue(value: unknown, seen: Set<object>): unknown {
    if (value === null || typeof value !== 'object') {
        return value
    }

    if (seen.has(value)) {
        throw new FrontmatterError('circular reference detected in frontmatter YAML')
    }
    seen.add(value)

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeValue(item, seen))
    }

    if (!isPlainObject(value)) {
        throw new FrontmatterError('non-plain object detected in frontmatter YAML')
    }

    const clean: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(key)) {
            continue
        }
        clean[key] = sanitizeValue(val, seen)
    }
    return clean
}
