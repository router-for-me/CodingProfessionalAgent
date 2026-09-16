/**
 * Parser and stripper for OpenAI-style `<oai-mem-citation>` memory citation blocks.
 * Extracts structured citation entries and rollout IDs while stripping raw XML from displayed markdown text.
 */

import type { MemoryCitation, MemoryCitationEntry } from '@cpa/plugin-api'

const OAI_MEM_CITATION_REGEX = /<oai-mem-citation>([\s\S]*?)(?:<\/oai-mem-citation>|$)/gi
const CITATION_ENTRIES_REGEX = /<citation_entries>([\s\S]*?)(?:<\/citation_entries>|$)/i
const ROLLOUT_IDS_REGEX = /<rollout_ids>([\s\S]*?)(?:<\/rollout_ids>|$)/i
const NOTE_REGEX = /\|note=\[(.*?)\]$/
const LINE_RANGE_REGEX = /:(\d+(?:-\d+)?)$/

export interface ExtractedMemoryCitations {
    cleanText: string
    citations?: MemoryCitation
}

/**
 * Extracts and strips `<oai-mem-citation>` blocks from text.
 * Returns the cleaned text alongside structured memory citation records.
 */
export function extractMemoryCitations(text: string): ExtractedMemoryCitations {
    if (!text || !text.includes('<oai-mem-citation')) {
        return { cleanText: text }
    }

    const allEntries: MemoryCitationEntry[] = []
    const allRolloutIds: string[] = []

    OAI_MEM_CITATION_REGEX.lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = OAI_MEM_CITATION_REGEX.exec(text)) !== null) {
        const innerContent = match[1] ?? ''

        // Parse citation_entries
        const entriesMatch = CITATION_ENTRIES_REGEX.exec(innerContent)
        if (entriesMatch?.[1]) {
            const lines = entriesMatch[1].split(/\r?\n/)
            for (const rawLine of lines) {
                const trimmed = rawLine.trim()
                if (!trimmed) continue

                let line = trimmed
                let note: string | undefined

                const noteMatch = NOTE_REGEX.exec(line)
                if (noteMatch) {
                    note = noteMatch[1].trim()
                    line = line.slice(0, noteMatch.index).trim()
                }

                let lineRange: string | undefined
                const rangeMatch = LINE_RANGE_REGEX.exec(line)
                if (rangeMatch) {
                    lineRange = rangeMatch[1]
                    line = line.slice(0, rangeMatch.index).trim()
                }

                allEntries.push({
                    file: line,
                    ...(lineRange !== undefined ? { lineRange } : {}),
                    ...(note !== undefined ? { note } : {}),
                })
            }
        }

        // Parse rollout_ids
        const rolloutMatch = ROLLOUT_IDS_REGEX.exec(innerContent)
        if (rolloutMatch?.[1]) {
            const lines = rolloutMatch[1].split(/\r?\n/)
            for (const rawLine of lines) {
                const trimmed = rawLine.trim()
                if (trimmed && !allRolloutIds.includes(trimmed)) {
                    allRolloutIds.push(trimmed)
                }
            }
        }
    }

    const cleanText = text.replace(OAI_MEM_CITATION_REGEX, '').trimEnd()

    if (allEntries.length === 0 && allRolloutIds.length === 0) {
        return { cleanText }
    }

    return {
        cleanText,
        citations: {
            entries: allEntries,
            ...(allRolloutIds.length > 0 ? { rolloutIds: allRolloutIds } : {}),
        },
    }
}

/**
 * Strips `<oai-mem-citation>` blocks from text without parsing.
 */
export function stripMemoryCitations(text: string): string {
    if (!text || !text.includes('<oai-mem-citation')) {
        return text
    }
    return text.replace(OAI_MEM_CITATION_REGEX, '').trimEnd()
}
