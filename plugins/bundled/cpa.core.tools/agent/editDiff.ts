/**
 * Browser-safe exact/fuzzy multi-edit + diff helpers.
 * Algorithm semantics ported independently (no Pi runtime / Node fs/path/Buffer).
 */

import * as Diff from 'diff'

export type TextEdit = {
    oldText: string
    newText: string
}

export type FuzzyFindResult = {
    found: boolean
    index: number
    matchLength: number
    usedFuzzyMatch: boolean
    contentForReplacement: string
}

export type ApplyEditsResult = {
    baseContent: string
    newContent: string
}

export type DiffStringResult = {
    diff: string
    firstChangedLine?: number
}

export type Replacement = {
    matchIndex: number
    matchLength: number
    newText: string
}

export type MatchedEdits = {
    usedFuzzyMatch: boolean
    replacementBaseContent: string
    replacements: readonly Replacement[]
}

type MatchedEdit = Replacement & {
    editIndex: number
}

export function detectLineEnding(content: string): '\n' | '\r\n' {
    const crlfIdx = content.indexOf('\r\n')
    const lfIdx = content.indexOf('\n')
    if (lfIdx === -1) {
        return '\n'
    }
    if (crlfIdx === -1) {
        return '\n'
    }
    return crlfIdx < lfIdx ? '\r\n' : '\n'
}

export function normalizeToLF(text: string): string {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function restoreLineEndings(text: string, ending: '\n' | '\r\n'): string {
    return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text
}

/**
 * Normalize text for fuzzy matching:
 * NFKC, trim trailing whitespace per line, map smart quotes/dashes/spaces.
 */
export function normalizeForFuzzyMatch(text: string): string {
    return (
        text
            .normalize('NFKC')
            .split('\n')
            .map((line) => line.trimEnd())
            .join('\n')
            // Smart single quotes → '
            .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
            // Smart double quotes → "
            .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
            // Various dashes/hyphens → -
            .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
            // Special spaces → regular space
            .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
    )
}

export function fuzzyFindText(content: string, oldText: string): FuzzyFindResult {
    const exactIndex = content.indexOf(oldText)
    if (exactIndex !== -1) {
        return {
            found: true,
            index: exactIndex,
            matchLength: oldText.length,
            usedFuzzyMatch: false,
            contentForReplacement: content,
        }
    }

    const fuzzyContent = normalizeForFuzzyMatch(content)
    const fuzzyOldText = normalizeForFuzzyMatch(oldText)
    if (fuzzyOldText.length === 0) {
        return {
            found: false,
            index: -1,
            matchLength: 0,
            usedFuzzyMatch: false,
            contentForReplacement: content,
        }
    }
    const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText)
    if (fuzzyIndex === -1) {
        return {
            found: false,
            index: -1,
            matchLength: 0,
            usedFuzzyMatch: false,
            contentForReplacement: content,
        }
    }

    return {
        found: true,
        index: fuzzyIndex,
        matchLength: fuzzyOldText.length,
        usedFuzzyMatch: true,
        contentForReplacement: fuzzyContent,
    }
}

/** Split LF content into lines that retain their trailing `\n` when present. */
function splitLinesWithEndings(content: string): string[] {
    return content.match(/[^\n]*\n|[^\n]+/g) ?? []
}

/**
 * Split mixed-EOL content into logical lines, preserving each line's original
 * ending bytes (`\n`, `\r\n`, `\r`, or empty for a final line without newline).
 */
export function splitLogicalLines(
    content: string,
): Array<{ text: string; ending: '' | '\n' | '\r\n' | '\r' }> {
    const lines: Array<{ text: string; ending: '' | '\n' | '\r\n' | '\r' }> = []
    let start = 0
    let i = 0
    while (i < content.length) {
        const ch = content[i]
        if (ch === '\r' && content[i + 1] === '\n') {
            lines.push({ text: content.slice(start, i), ending: '\r\n' })
            i += 2
            start = i
            continue
        }
        if (ch === '\n') {
            lines.push({ text: content.slice(start, i), ending: '\n' })
            i += 1
            start = i
            continue
        }
        if (ch === '\r') {
            lines.push({ text: content.slice(start, i), ending: '\r' })
            i += 1
            start = i
            continue
        }
        i += 1
    }
    if (start < content.length) {
        lines.push({ text: content.slice(start), ending: '' })
    } else if (content.length === 0) {
        // Empty file: zero lines.
    }
    return lines
}

function getLineSpans(content: string): Array<{ start: number; end: number }> {
    let offset = 0
    return splitLinesWithEndings(content).map((line) => {
        const span = { start: offset, end: offset + line.length }
        offset = span.end
        return span
    })
}

function getReplacementLineRange(
    lines: Array<{ start: number; end: number }>,
    replacement: Replacement,
): { startLine: number; endLine: number } {
    const replacementStart = replacement.matchIndex
    const replacementEnd = replacement.matchIndex + replacement.matchLength
    let startLine = -1
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (replacementStart >= line.start && replacementStart < line.end) {
            startLine = i
            break
        }
    }
    if (startLine === -1) {
        throw new Error('Replacement range is outside the base content.')
    }

    let endLine = startLine
    while (endLine < lines.length && lines[endLine].end < replacementEnd) {
        endLine++
    }
    if (endLine >= lines.length) {
        throw new Error('Replacement range is outside the base content.')
    }
    return { startLine, endLine: endLine + 1 }
}

function applyReplacements(
    content: string,
    replacements: readonly Replacement[],
    offset = 0,
): string {
    let result = content
    for (let i = replacements.length - 1; i >= 0; i--) {
        const replacement = replacements[i]
        const matchIndex = replacement.matchIndex - offset
        result =
            result.substring(0, matchIndex) +
            replacement.newText +
            result.substring(matchIndex + replacement.matchLength)
    }
    return result
}

function groupReplacementsByLines(
    baseLines: Array<{ start: number; end: number }>,
    replacements: readonly Replacement[],
): Array<{ startLine: number; endLine: number; replacements: Replacement[] }> {
    const groups: Array<{
        startLine: number
        endLine: number
        replacements: Replacement[]
    }> = []
    const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)
    for (const replacement of sortedReplacements) {
        const range = getReplacementLineRange(baseLines, replacement)
        const current = groups[groups.length - 1]
        if (current && range.startLine < current.endLine) {
            current.endLine = Math.max(current.endLine, range.endLine)
            current.replacements.push(replacement)
            continue
        }
        groups.push({ ...range, replacements: [replacement] })
    }
    return groups
}

/**
 * Apply replacements matched against `baseContent` to `originalContent` while
 * preserving unchanged line blocks from the original (LF form).
 */
export function applyReplacementsPreservingUnchangedLines(
    originalContent: string,
    baseContent: string,
    replacements: readonly Replacement[],
): string {
    const originalLines = splitLinesWithEndings(originalContent)
    const baseLines = getLineSpans(baseContent)
    if (originalLines.length !== baseLines.length) {
        throw new Error(
            'Cannot preserve unchanged lines because the base content has a different line count.',
        )
    }

    const groups = groupReplacementsByLines(baseLines, replacements)
    let originalLineIndex = 0
    let result = ''
    for (const group of groups) {
        result += originalLines.slice(originalLineIndex, group.startLine).join('')
        const groupStartOffset = baseLines[group.startLine].start
        const groupEndOffset = baseLines[group.endLine - 1].end
        result += applyReplacements(
            baseContent.slice(groupStartOffset, groupEndOffset),
            group.replacements,
            groupStartOffset,
        )
        originalLineIndex = group.endLine
    }
    result += originalLines.slice(originalLineIndex).join('')
    return result
}

/**
 * Apply matched replacements onto the original mixed-EOL content.
 * Untouched lines keep their exact original ending bytes; touched line groups
 * are rebuilt from the match-base slice and only those lines use preferredEnding.
 * Reuses the already-matched replacement ranges (no re-search by text).
 */
export function applyMatchedEditsToOriginalContent(
    originalContent: string,
    matched: MatchedEdits,
    preferredEnding: '\n' | '\r\n',
): string {
    const originalLines = splitLogicalLines(originalContent)
    const baseLines = getLineSpans(matched.replacementBaseContent)
    if (originalLines.length !== baseLines.length) {
        throw new Error(
            'Cannot preserve mixed EOL lines because the base content has a different line count.',
        )
    }

    const groups = groupReplacementsByLines(baseLines, matched.replacements)
    let originalLineIndex = 0
    let result = ''
    for (const group of groups) {
        for (let i = originalLineIndex; i < group.startLine; i++) {
            result += originalLines[i].text + originalLines[i].ending
        }
        const groupStartOffset = baseLines[group.startLine].start
        const groupEndOffset = baseLines[group.endLine - 1].end
        const replaced = applyReplacements(
            matched.replacementBaseContent.slice(groupStartOffset, groupEndOffset),
            group.replacements,
            groupStartOffset,
        )
        // Only touched/new lines adopt the preferred ending style.
        result += restoreLineEndings(replaced, preferredEnding)
        originalLineIndex = group.endLine
    }
    for (let i = originalLineIndex; i < originalLines.length; i++) {
        result += originalLines[i].text + originalLines[i].ending
    }
    return result
}

/**
 * Count occurrences with overlapping matches (advance by 1 after each hit).
 * `aaa` contains two overlapping occurrences of `aa`.
 */
export function countOccurrences(content: string, needle: string): number {
    if (needle.length === 0) {
        return 0
    }
    let count = 0
    let pos = 0
    while (pos <= content.length - needle.length) {
        const idx = content.indexOf(needle, pos)
        if (idx === -1) {
            break
        }
        count++
        pos = idx + 1
    }
    return count
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
    if (totalEdits === 1) {
        return new Error(
            `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
        )
    }
    return new Error(
        `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
    )
}

function getDuplicateError(
    path: string,
    editIndex: number,
    totalEdits: number,
    occurrences: number,
): Error {
    if (totalEdits === 1) {
        return new Error(
            `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
        )
    }
    return new Error(
        `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
    )
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
    if (totalEdits === 1) {
        return new Error(`oldText must not be empty in ${path}.`)
    }
    return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`)
}

function getNoChangeError(path: string, totalEdits: number): Error {
    if (totalEdits === 1) {
        return new Error(
            `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
        )
    }
    return new Error(`No changes made to ${path}. The replacements produced identical content.`)
}

/**
 * Match every edit against the same original LF-normalized snapshot.
 * Returns replacement ranges for both the normalized apply path and the
 * mixed-EOL write path (no re-search by text later).
 */
export function matchEditsAgainstContent(
    normalizedContent: string,
    edits: readonly TextEdit[],
    path: string,
): MatchedEdits {
    const normalizedEdits = edits.map((edit) => ({
        oldText: normalizeToLF(edit.oldText),
        newText: normalizeToLF(edit.newText),
    }))

    for (let i = 0; i < normalizedEdits.length; i++) {
        if (normalizedEdits[i].oldText.length === 0) {
            throw getEmptyOldTextError(path, i, normalizedEdits.length)
        }
        // Reject oldText that collapses to empty under fuzzy normalize so we
        // never perform a zero-length insert via fuzzy matching.
        if (normalizeForFuzzyMatch(normalizedEdits[i].oldText) === '') {
            throw getEmptyOldTextError(path, i, normalizedEdits.length)
        }
    }

    const initialMatches = normalizedEdits.map((edit) =>
        fuzzyFindText(normalizedContent, edit.oldText),
    )
    const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch)
    const replacementBaseContent = usedFuzzyMatch
        ? normalizeForFuzzyMatch(normalizedContent)
        : normalizedContent

    const matchedEdits: MatchedEdit[] = []
    for (let i = 0; i < normalizedEdits.length; i++) {
        const edit = normalizedEdits[i]
        const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText)
        if (!matchResult.found) {
            throw getNotFoundError(path, i, normalizedEdits.length)
        }
        const needle = usedFuzzyMatch
            ? normalizeForFuzzyMatch(edit.oldText)
            : edit.oldText
        const occurrences = countOccurrences(replacementBaseContent, needle)
        if (occurrences > 1) {
            throw getDuplicateError(path, i, normalizedEdits.length, occurrences)
        }
        matchedEdits.push({
            editIndex: i,
            matchIndex: matchResult.index,
            matchLength: matchResult.matchLength,
            newText: edit.newText,
        })
    }

    matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex)
    for (let i = 1; i < matchedEdits.length; i++) {
        const previous = matchedEdits[i - 1]
        const current = matchedEdits[i]
        if (previous.matchIndex + previous.matchLength > current.matchIndex) {
            throw new Error(
                `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
            )
        }
    }

    // Drop editIndex from the public replacement list (not part of Replacement).
    const replacements: Replacement[] = matchedEdits.map(({ matchIndex, matchLength, newText }) => ({
        matchIndex,
        matchLength,
        newText,
    }))

    return {
        usedFuzzyMatch,
        replacementBaseContent,
        replacements,
    }
}

/**
 * Apply already-matched replacements onto LF-normalized original content.
 * Public apply result shape stays `{ baseContent, newContent }` only.
 */
export function applyMatchedEditsToNormalizedContent(
    normalizedContent: string,
    matched: MatchedEdits,
): string {
    return matched.usedFuzzyMatch
        ? applyReplacementsPreservingUnchangedLines(
              normalizedContent,
              matched.replacementBaseContent,
              matched.replacements,
          )
        : applyReplacements(matched.replacementBaseContent, matched.replacements)
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. If any edit needs
 * fuzzy matching, the operation runs in fuzzy-normalized content space and then
 * overlays those line-level changes onto the original content so unchanged line
 * blocks keep their original bytes.
 */
export function applyEditsToNormalizedContent(
    normalizedContent: string,
    edits: readonly TextEdit[],
    path: string,
): ApplyEditsResult {
    const matched = matchEditsAgainstContent(normalizedContent, edits, path)
    const baseContent = normalizedContent
    const newContent = applyMatchedEditsToNormalizedContent(normalizedContent, matched)

    if (baseContent === newContent) {
        throw getNoChangeError(path, edits.length)
    }

    return { baseContent, newContent }
}

/** Generate a standard unified patch without undefined timestamps. */
export function generateUnifiedPatch(
    path: string,
    oldContent: string,
    newContent: string,
    contextLines = 4,
): string {
    return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
        context: contextLines,
        headerOptions: Diff.FILE_HEADERS_ONLY,
    })
}

const LINE_DIFF_CACHE_MAX = 2000
const lineDiffCache = new Map<string, { additions: number; deletions: number }>()

/**
 * Compute line-level additions and deletions between oldContent and newContent.
 */
export function computeLineDiffStats(
    oldContent: string,
    newContent: string,
): { additions: number; deletions: number } {
    if (oldContent === newContent) {
        return { additions: 0, deletions: 0 }
    }
    // Fast cache lookup for repeated diff calculations
    const cacheKey = `${oldContent.length}:${newContent.length}:${oldContent}\0${newContent}`
    if (cacheKey.length < 200_000) {
        const cached = lineDiffCache.get(cacheKey)
        if (cached) {
            return cached
        }
    }
    const parts = Diff.diffLines(oldContent, newContent)
    let additions = 0
    let deletions = 0
    for (const part of parts) {
        if (part.added) {
            additions += part.count ?? part.value.split('\n').filter(Boolean).length
        } else if (part.removed) {
            deletions += part.count ?? part.value.split('\n').filter(Boolean).length
        }
    }
    const result = { additions, deletions }
    if (cacheKey.length < 200_000) {
        if (lineDiffCache.size >= LINE_DIFF_CACHE_MAX) {
            const firstKey = lineDiffCache.keys().next().value
            if (firstKey !== undefined) {
                lineDiffCache.delete(firstKey)
            }
        }
        lineDiffCache.set(cacheKey, result)
    }
    return result
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Context lines represent the new/current file and use newLineNum.
 * Removed lines keep oldLineNum. Returns firstChangedLine in the new file.
 */
export function generateDiffString(
    oldContent: string,
    newContent: string,
    contextLines = 4,
): DiffStringResult {
    const parts = Diff.diffLines(oldContent, newContent)
    const output: string[] = []
    const oldLines = oldContent.split('\n')
    const newLines = newContent.split('\n')
    const maxLineNum = Math.max(oldLines.length, newLines.length)
    const lineNumWidth = String(maxLineNum).length

    let oldLineNum = 1
    let newLineNum = 1
    let lastWasChange = false
    let firstChangedLine: number | undefined

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        const raw = part.value.split('\n')
        if (raw[raw.length - 1] === '') {
            raw.pop()
        }

        if (part.added || part.removed) {
            if (firstChangedLine === undefined) {
                firstChangedLine = newLineNum
            }
            for (const line of raw) {
                if (part.added) {
                    const lineNum = String(newLineNum).padStart(lineNumWidth, ' ')
                    output.push(`+${lineNum} ${line}`)
                    newLineNum++
                } else {
                    const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ')
                    output.push(`-${lineNum} ${line}`)
                    oldLineNum++
                }
            }
            lastWasChange = true
        } else {
            const nextPartIsChange =
                i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed)
            const hasLeadingChange = lastWasChange
            const hasTrailingChange = nextPartIsChange

            if (hasLeadingChange && hasTrailingChange) {
                if (raw.length <= contextLines * 2) {
                    for (const line of raw) {
                        // Context = current/new file line numbers.
                        const lineNum = String(newLineNum).padStart(lineNumWidth, ' ')
                        output.push(` ${lineNum} ${line}`)
                        oldLineNum++
                        newLineNum++
                    }
                } else {
                    const leadingLines = raw.slice(0, contextLines)
                    const trailingLines = raw.slice(raw.length - contextLines)
                    const skippedLines = raw.length - leadingLines.length - trailingLines.length
                    for (const line of leadingLines) {
                        const lineNum = String(newLineNum).padStart(lineNumWidth, ' ')
                        output.push(` ${lineNum} ${line}`)
                        oldLineNum++
                        newLineNum++
                    }
                    output.push(` ${''.padStart(lineNumWidth, ' ')} ...`)
                    oldLineNum += skippedLines
                    newLineNum += skippedLines
                    for (const line of trailingLines) {
                        const lineNum = String(newLineNum).padStart(lineNumWidth, ' ')
                        output.push(` ${lineNum} ${line}`)
                        oldLineNum++
                        newLineNum++
                    }
                }
            } else if (hasLeadingChange) {
                const shownLines = raw.slice(0, contextLines)
                const skippedLines = raw.length - shownLines.length
                for (const line of shownLines) {
                    const lineNum = String(newLineNum).padStart(lineNumWidth, ' ')
                    output.push(` ${lineNum} ${line}`)
                    oldLineNum++
                    newLineNum++
                }
                if (skippedLines > 0) {
                    output.push(` ${''.padStart(lineNumWidth, ' ')} ...`)
                    oldLineNum += skippedLines
                    newLineNum += skippedLines
                }
            } else if (hasTrailingChange) {
                const skippedLines = Math.max(0, raw.length - contextLines)
                if (skippedLines > 0) {
                    output.push(` ${''.padStart(lineNumWidth, ' ')} ...`)
                    oldLineNum += skippedLines
                    newLineNum += skippedLines
                }
                for (const line of raw.slice(skippedLines)) {
                    const lineNum = String(newLineNum).padStart(lineNumWidth, ' ')
                    output.push(` ${lineNum} ${line}`)
                    oldLineNum++
                    newLineNum++
                }
            } else {
                oldLineNum += raw.length
                newLineNum += raw.length
            }
            lastWasChange = false
        }
    }

    return { diff: output.join('\n'), firstChangedLine }
}

/** Strip at most one UTF-8 BOM code point from the start of content. */
export function stripBom(content: string): { bom: string; text: string } {
    return content.startsWith('\uFEFF')
        ? { bom: '\uFEFF', text: content.slice(1) }
        : { bom: '', text: content }
}

/** Byte-for-byte equality for snapshot guards (same-size replacements included). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) {
        return false
    }
    for (let i = 0; i < a.byteLength; i++) {
        if (a[i] !== b[i]) {
            return false
        }
    }
    return true
}
