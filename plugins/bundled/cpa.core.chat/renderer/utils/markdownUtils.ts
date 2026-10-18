/**
 * Recursively extracts plain text from hast nodes, React element trees, or primitives.
 */
export function extractMarkdownNodeText(node: unknown): string {
    if (!node) {
        return ''
    }
    if (typeof node === 'string') {
        return node
    }
    if (typeof node === 'number') {
        return String(node)
    }
    if (Array.isArray(node)) {
        return node.map(extractMarkdownNodeText).join('')
    }
    if (typeof node === 'object') {
        const obj = node as Record<string, unknown>
        if (typeof obj.value === 'string') {
            return obj.value
        }
        if (obj.children) {
            return extractMarkdownNodeText(obj.children)
        }
        if (obj.props && typeof obj.props === 'object') {
            return extractMarkdownNodeText((obj.props as Record<string, unknown>).children)
        }
    }
    return ''
}

/**
 * Determines whether a markdown <pre> block contains only empty or whitespace-only content.
 * Used to suppress empty code box rendering artifacts caused by unclosed code blocks or stray backticks.
 */
export function isMarkdownPreEmpty(node: unknown, children: unknown): boolean {
    const nodeText = extractMarkdownNodeText(node)
    if (nodeText.trim().length > 0) {
        return false
    }
    const childrenText = extractMarkdownNodeText(children)
    return childrenText.trim().length === 0
}

interface FenceInfo {
    lineIndex: number
    indent: string
    marker: string
    char: string
    length: number
    info: string
}

interface FenceNode {
    open: FenceInfo
    close: FenceInfo | null
    children: FenceNode[]
    requiredLength: number
}

/**
 * Normalizes and balances markdown code fences to ensure nested code blocks
 * (e.g. ```markdown containing inner ```bash ... ```) have outer fences promoted to 4+ backticks.
 * This prevents inner code fences from prematurely terminating the outer block, ensuring
 * inner code blocks remain intact and eliminating stray trailing backticks.
 */
export function balanceMarkdownCodeFences(text: string): string {
    if (!text || (!text.includes('```') && !text.includes('~~~'))) {
        return text
    }

    const lines = text.split('\n')
    const fenceRegex = /^(\s{0,3})(`{3,}|~{3,})(.*)$/

    const fences: FenceInfo[] = []
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!line) continue
        const m = line.match(fenceRegex)
        if (m && m[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
            fences.push({
                lineIndex: i,
                indent: m[1],
                marker: m[2],
                char: m[2][0] as string,
                length: m[2].length,
                info: m[3].trim(),
            })
        }
    }

    if (fences.length === 0) {
        return text
    }

    const stack: FenceNode[] = []
    const roots: FenceNode[] = []

    for (const f of fences) {
        if (f.info.length > 0) {
            // Explicit code block open (e.g. ```markdown, ```bash)
            const node: FenceNode = { open: f, close: null, children: [], requiredLength: f.length }
            if (stack.length > 0) {
                stack[stack.length - 1]?.children.push(node)
            } else {
                roots.push(node)
            }
            stack.push(node)
        } else {
            // Pure fence without info string
            if (stack.length > 0) {
                // Closes current innermost block
                const node = stack.pop()!
                node.close = f
            } else {
                // Untyped code block open
                const node: FenceNode = { open: f, close: null, children: [], requiredLength: f.length }
                roots.push(node)
                stack.push(node)
            }
        }
    }

    // Recursively resolve required fence lengths (outer must strictly exceed inner)
    function resolveRequiredLength(node: FenceNode): number {
        let maxChildFence = 0
        for (const child of node.children) {
            const childLen = resolveRequiredLength(child)
            if (childLen > maxChildFence) {
                maxChildFence = childLen
            }
        }
        if (maxChildFence >= node.requiredLength) {
            node.requiredLength = maxChildFence + 1
        }
        return node.requiredLength
    }

    for (const root of roots) {
        resolveRequiredLength(root)
    }

    // Apply promotions to lines array
    function applyPromotions(node: FenceNode) {
        if (node.requiredLength > node.open.length) {
            const newMarker = node.open.char.repeat(node.requiredLength)
            const openLine = lines[node.open.lineIndex]
            if (openLine !== undefined) {
                const m = openLine.match(fenceRegex)
                if (m) {
                    lines[node.open.lineIndex] = m[1] + newMarker + m[3]
                }
            }
            if (node.close) {
                const closeLine = lines[node.close.lineIndex]
                if (closeLine !== undefined) {
                    const cm = closeLine.match(fenceRegex)
                    if (cm) {
                        lines[node.close.lineIndex] = cm[1] + newMarker
                    }
                }
            }
        }
        for (const child of node.children) {
            applyPromotions(child)
        }
    }

    for (const root of roots) {
        applyPromotions(root)
    }

    // Handle unclosed blocks (e.g. streaming deltas or truncated output)
    let result = lines.join('\n')
    while (stack.length > 0) {
        const unclosed = stack.pop()!
        const marker = unclosed.open.char.repeat(unclosed.requiredLength)
        result += '\n' + unclosed.open.indent + marker
    }

    return result
}

function appendInlineMathToken(current: string, inner: string): string {
    const prefix = current.endsWith('$') ? ' ' : ''
    return `${current}${prefix}$$${inner}$$`
}

function normalizeInlineMathSegment(seg: string): string {
    if (!seg.includes('$') && !seg.includes('\\(') && !seg.includes('\\[')) {
        return seg
    }

    let out = ''
    let i = 0
    const len = seg.length

    while (i < len) {
        const ch = seg[i]!

        if (ch === '\\') {
            if (seg.startsWith('\\(', i)) {
                const closeIdx = seg.indexOf('\\)', i + 2)
                if (closeIdx !== -1) {
                    const inner = seg.slice(i + 2, closeIdx).trim()
                    if (inner.length > 0) {
                        out = appendInlineMathToken(out, inner)
                        i = closeIdx + 2
                        continue
                    }
                }
            } else if (seg.startsWith('\\[', i)) {
                const closeIdx = seg.indexOf('\\]', i + 2)
                if (closeIdx !== -1) {
                    const inner = seg.slice(i + 2, closeIdx).trim()
                    if (inner.length > 0 && /[\\_^=]/.test(inner)) {
                        out = appendInlineMathToken(out, inner)
                        i = closeIdx + 2
                        continue
                    }
                }
            }
            if (i + 1 < len) {
                out += seg[i]! + seg[i + 1]!
                i += 2
            } else {
                out += ch
                i += 1
            }
            continue
        }

        if (ch === '$') {
            if (seg[i + 1] === '$') {
                const closeIdx = seg.indexOf('$$', i + 2)
                if (closeIdx !== -1) {
                    const inner = seg.slice(i + 2, closeIdx).trim()
                    if (inner.length > 0) {
                        out = appendInlineMathToken(out, inner)
                    } else {
                        out += seg.slice(i, closeIdx + 2)
                    }
                    i = closeIdx + 2
                    continue
                }
                while (i < len && seg[i] === '$') {
                    out += seg[i]!
                    i += 1
                }
                continue
            }

            const prev = i > 0 ? seg[i - 1]! : ''
            const next = i + 1 < len ? seg[i + 1]! : ''
            const canOpen =
                next !== '' &&
                !/\s/.test(next) &&
                next !== '$' &&
                (prev === '' || !/[A-Za-z0-9_$\\]/.test(prev))

            if (canOpen) {
                let j = i + 1
                let matchedClose = -1
                while (j < len) {
                    if (seg[j] === '\n' || seg[j] === '\r') {
                        break
                    }
                    if (seg[j] === '\\') {
                        j += 2
                        continue
                    }
                    if (seg[j] === '$') {
                        if (seg[j + 1] === '$') {
                            break
                        }
                        const beforeClose = seg[j - 1]!
                        const afterClose = j + 1 < len ? seg[j + 1]! : ''
                        const afterClose2 = j + 2 < len ? seg[j + 2]! : ''
                        const isNextLatexCommand =
                            afterClose === '\\' && /[A-Za-z]/.test(afterClose2)
                        if (
                            !/\s/.test(beforeClose) &&
                            (afterClose === '' || !/[A-Za-z0-9_$]/.test(afterClose)) &&
                            !isNextLatexCommand
                        ) {
                            matchedClose = j
                        }
                        break
                    }
                    j += 1
                }

                if (matchedClose !== -1) {
                    const inner = seg.slice(i + 1, matchedClose)
                    out = appendInlineMathToken(out, inner)
                    i = matchedClose + 1
                    continue
                }
            }

            out += '$'
            i += 1
            continue
        }

        out += ch
        i += 1
    }

    return out
}

const PROTECTED_SPAN_REGEX =
    /(^|\n)((?:\s{0,3}> ?)*\s{0,3}\[[^\]\n]+\]:\s*\S[^\n]*)|(\]\(\s*(?:<[^>\n]*>|(?:\\.|[^()\s\\]|\([^()\n]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\))|(\]\[[^\]\n]*\])|(\[[^\]\n]+\](?!\())|(<(?:https?|ftp|mailto):[^>\s]+>)|(\bhttps?:\/\/[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*)/g

function normalizeRefLabel(label: string): string {
    return label.trim().replace(/\s+/g, ' ').toLowerCase()
}

function collectDefinedReferenceLabels(text: string): ReadonlySet<string> {
    const refs = new Set<string>()
    const defRegex = /(?:^|\n)(?:\s{0,3}> ?)*\s{0,3}\[([^\]\n]+)\]:\s*\S/g
    let m: RegExpExecArray | null
    while ((m = defRegex.exec(text)) !== null) {
        if (m[1]) {
            refs.add(normalizeRefLabel(m[1]))
        }
    }
    return refs
}

function normalizeTextPreservingUrls(
    text: string,
    definedRefs: ReadonlySet<string>,
): string {
    if (!text.includes('$') && !text.includes('\\(') && !text.includes('\\[')) {
        return text
    }

    let result = ''
    let lastIndex = 0
    PROTECTED_SPAN_REGEX.lastIndex = 0

    let match: RegExpExecArray | null
    while ((match = PROTECTED_SPAN_REGEX.exec(text)) !== null) {
        const matchStart = match.index
        const leadingNewline = match[1] ?? ''
        const bracketCandidate = match[5]
        if (bracketCandidate !== undefined) {
            const innerLabel = bracketCandidate.slice(1, -1)
            if (!definedRefs.has(normalizeRefLabel(innerLabel))) {
                continue
            }
        }
        const protectedStart = matchStart + leadingNewline.length
        if (protectedStart > lastIndex) {
            result += normalizeInlineMathSegment(text.slice(lastIndex, protectedStart))
        }
        result += text.slice(protectedStart, matchStart + match[0].length)
        lastIndex = matchStart + match[0].length
    }

    if (lastIndex < text.length) {
        result += normalizeInlineMathSegment(text.slice(lastIndex))
    }

    return result
}

function normalizeChunkInlineMath(
    chunk: string,
    definedRefs: ReadonlySet<string>,
): string {
    if (!chunk.includes('$') && !chunk.includes('\\(') && !chunk.includes('\\[')) {
        return chunk
    }
    if (!chunk.includes('`')) {
        return normalizeTextPreservingUrls(chunk, definedRefs)
    }

    let result = ''
    let textStart = 0
    let i = 0
    const len = chunk.length

    while (i < len) {
        if (chunk[i] === '`') {
            let tickEnd = i
            while (tickEnd < len && chunk[tickEnd] === '`') {
                tickEnd++
            }
            const tickCount = tickEnd - i
            let closeStart = -1
            let searchIdx = tickEnd
            while (searchIdx < len) {
                if (chunk[searchIdx] === '`') {
                    let closeEnd = searchIdx
                    while (closeEnd < len && chunk[closeEnd] === '`') {
                        closeEnd++
                    }
                    if (closeEnd - searchIdx === tickCount) {
                        closeStart = searchIdx
                        break
                    }
                    searchIdx = closeEnd
                } else {
                    searchIdx++
                }
            }

            if (closeStart !== -1) {
                if (i > textStart) {
                    result += normalizeTextPreservingUrls(
                        chunk.slice(textStart, i),
                        definedRefs,
                    )
                }
                const codeSpan = chunk.slice(i, closeStart + tickCount)
                result +=
                    codeSpan.includes('\n') && codeSpan.includes('$$')
                        ? codeSpan.replace(/\r?\n(?:\s{0,3}> ?)*[ \t]*(?=\$\$)/g, ' ')
                        : codeSpan
                i = closeStart + tickCount
                textStart = i
                continue
            }
            i = tickEnd
            continue
        }
        i++
    }

    if (textStart < len) {
        result += normalizeTextPreservingUrls(chunk.slice(textStart), definedRefs)
    }

    return result
}

function computeMultiLineInlineCodeLines(
    allLines: readonly string[],
    fenceOpenRegex: RegExp,
    fenceCloseRegex: RegExp,
): ReadonlySet<number> {
    const protectedLines = new Set<number>()
    let activeFence: { char: string; length: number } | null = null
    let paraStart = -1
    let paraHasBacktick = false

    const processParagraph = (startLine: number, endLine: number) => {
        if (endLine <= startLine || !paraHasBacktick) return
        const lineStartOffsets: number[] = []
        let offset = 0
        for (let k = startLine; k <= endLine; k++) {
            lineStartOffsets.push(offset)
            offset += (allLines[k]?.length ?? 0) + 1
        }
        const paragraphText = allLines.slice(startLine, endLine + 1).join('\n')
        const len = paragraphText.length

        const findLineForOffset = (pos: number): number => {
            let lo = 0
            let hi = lineStartOffsets.length - 1
            while (lo <= hi) {
                const mid = (lo + hi) >> 1
                if ((lineStartOffsets[mid] ?? 0) <= pos) {
                    lo = mid + 1
                } else {
                    hi = mid - 1
                }
            }
            return startLine + Math.max(0, hi)
        }

        let i = 0
        while (i < len) {
            if (paragraphText[i] === '`') {
                let tickEnd = i
                while (tickEnd < len && paragraphText[tickEnd] === '`') {
                    tickEnd++
                }
                const tickCount = tickEnd - i
                let closeStart = -1
                let searchIdx = tickEnd
                while (searchIdx < len) {
                    if (paragraphText[searchIdx] === '`') {
                        let closeEnd = searchIdx
                        while (closeEnd < len && paragraphText[closeEnd] === '`') {
                            closeEnd++
                        }
                        if (closeEnd - searchIdx === tickCount) {
                            closeStart = searchIdx
                            break
                        }
                        searchIdx = closeEnd
                    } else {
                        searchIdx++
                    }
                }

                if (closeStart !== -1) {
                    const openLine = findLineForOffset(i)
                    const closeLine = findLineForOffset(closeStart + tickCount - 1)
                    if (closeLine > openLine) {
                        for (let ln = openLine + 1; ln <= closeLine; ln++) {
                            protectedLines.add(ln)
                        }
                    }
                    i = closeStart + tickCount
                    continue
                }
                i = tickEnd
                continue
            }
            i++
        }
    }

    for (let idx = 0; idx < allLines.length; idx++) {
        const line = allLines[idx] ?? ''
        if (activeFence !== null) {
            const cm = line.match(fenceCloseRegex)
            if (
                cm &&
                cm[3] &&
                cm[3][0] === activeFence.char &&
                cm[3].length >= activeFence.length
            ) {
                activeFence = null
            }
            continue
        }
        const om = line.match(fenceOpenRegex)
        if (om && om[3]) {
            if (paraStart !== -1) {
                processParagraph(paraStart, idx - 1)
                paraStart = -1
                paraHasBacktick = false
            }
            activeFence = { char: om[3][0]!, length: om[3].length }
            continue
        }
        const bqMatch = line.match(/^((?:\s{0,3}> ?)*)/)
        const afterBq = line.slice((bqMatch?.[1] ?? '').length)
        if (afterBq.trim() === '') {
            if (paraStart !== -1) {
                processParagraph(paraStart, idx - 1)
                paraStart = -1
                paraHasBacktick = false
            }
            continue
        }
        if (paraStart === -1) {
            paraStart = idx
        }
        if (line.includes('`')) {
            paraHasBacktick = true
        }
    }

    if (paraStart !== -1) {
        processParagraph(paraStart, allLines.length - 1)
    }

    return protectedLines
}

function countBlockquoteMarkers(prefix: string): number {
    let count = 0
    for (let i = 0; i < prefix.length; i++) {
        if (prefix[i] === '>') count++
    }
    return count
}

/**
 * Normalizes LaTeX math delimiters in markdown text so `remark-math` (configured with
 * `singleDollarTextMath: false`) can render inline and display math via KaTeX without
 * falsely matching currency values (e.g. `$100 and $200`), shell variables (e.g. `$PATH`),
 * link URLs, or code blocks/spans.
 */
export function normalizeMarkdownMath(text: string): string {
    if (!text || (!text.includes('$') && !text.includes('\\(') && !text.includes('\\['))) {
        return text
    }

    const definedRefs = collectDefinedReferenceLabels(text)
    const lines = text.split('\n')
    const outLines: string[] = []
    const pendingParagraphLines: string[] = []
    const fenceOpenRegex = /^((?:\s{0,3}> ?)*)(\s{0,3})(`{3,}|~{3,})(.*)$/
    const fenceCloseRegex = /^((?:\s{0,3}> ?)*)(\s{0,3})(`{3,}|~{3,})\s*$/
    const multiLineInlineCodeLines = text.includes('`')
        ? computeMultiLineInlineCodeLines(lines, fenceOpenRegex, fenceCloseRegex)
        : new Set<number>()

    let activeCodeFence: { char: string; length: number; bqDepth: number } | null = null
    let inIndentedCodeBlock = false
    let prevLineWasBlank = true
    let prevBqDepth = 0
    let inDollarBlock: { prefix: string } | null = null
    let inBracketBlock: { prefix: string } | null = null

    const flushParagraphLines = () => {
        if (pendingParagraphLines.length === 0) return
        const chunk = pendingParagraphLines.join('\n')
        pendingParagraphLines.length = 0
        outLines.push(normalizeChunkInlineMath(chunk, definedRefs))
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? ''

        if (activeCodeFence !== null) {
            const bqMatch = line.match(/^((?:\s{0,3}> ?)*)/)
            const currentBqDepth = countBlockquoteMarkers(bqMatch?.[1] ?? '')
            if (activeCodeFence.bqDepth > 0 && currentBqDepth < activeCodeFence.bqDepth) {
                activeCodeFence = null
            } else {
                const closeMatch = line.match(fenceCloseRegex)
                if (
                    closeMatch &&
                    closeMatch[3] &&
                    closeMatch[3][0] === activeCodeFence.char &&
                    closeMatch[3].length >= activeCodeFence.length
                ) {
                    activeCodeFence = null
                }
                outLines.push(line)
                prevLineWasBlank = false
                prevBqDepth = currentBqDepth
                continue
            }
        }

        if (inDollarBlock === null && inBracketBlock === null) {
            const openFenceMatch = line.match(fenceOpenRegex)
            if (openFenceMatch && openFenceMatch[3]) {
                flushParagraphLines()
                inIndentedCodeBlock = false
                const currentBqDepth = countBlockquoteMarkers(openFenceMatch[1] ?? '')
                activeCodeFence = {
                    char: openFenceMatch[3][0]!,
                    length: openFenceMatch[3].length,
                    bqDepth: currentBqDepth,
                }
                outLines.push(line)
                prevLineWasBlank = false
                prevBqDepth = currentBqDepth
                continue
            }
        }

        if (inDollarBlock !== null) {
            if (/^((?:\s{0,3}> ?)*\s*)\$\$\s*$/.test(line)) {
                inDollarBlock = null
                outLines.push(line)
                prevLineWasBlank = false
                continue
            }
            const closeDollarWithMath = line.match(/^((?:\s{0,3}> ?)*\s*)(.+?)\$\$\s*$/)
            if (closeDollarWithMath && closeDollarWithMath[2] && !closeDollarWithMath[2].includes('$$')) {
                const prefix = closeDollarWithMath[1] ?? inDollarBlock.prefix
                const beforeClose = closeDollarWithMath[2].trimEnd()
                outLines.push(`${prefix}${beforeClose}\n${prefix}$$`)
                inDollarBlock = null
                prevLineWasBlank = false
                continue
            }
            outLines.push(line)
            prevLineWasBlank = false
            continue
        }

        if (inBracketBlock !== null) {
            const exactCloseBracket = line.match(/^((?:\s{0,3}> ?)*\s*)\\\]\s*$/)
            if (exactCloseBracket) {
                const prefix = exactCloseBracket[1] ?? inBracketBlock.prefix
                outLines.push(`${prefix}$$`)
                inBracketBlock = null
                prevLineWasBlank = false
                continue
            }
            const closeBracketWithMath = line.match(/^((?:\s{0,3}> ?)*\s*)(.+?)\\\]\s*$/)
            if (closeBracketWithMath && closeBracketWithMath[2] && !closeBracketWithMath[2].includes('\\]')) {
                const prefix = closeBracketWithMath[1] ?? inBracketBlock.prefix
                const beforeClose = closeBracketWithMath[2].trimEnd()
                outLines.push(`${prefix}${beforeClose}\n${prefix}$$`)
                inBracketBlock = null
                prevLineWasBlank = false
                continue
            }
            outLines.push(line)
            prevLineWasBlank = false
            continue
        }

        const bqPrefixMatch = line.match(/^((?:\s{0,3}> ?)*)/)
        const bqPrefix = bqPrefixMatch?.[1] ?? ''
        const currentBqDepth = countBlockquoteMarkers(bqPrefix)
        const restAfterBq = line.slice(bqPrefix.length)

        if (currentBqDepth !== prevBqDepth) {
            flushParagraphLines()
            inIndentedCodeBlock = false
            prevLineWasBlank = true
        }
        prevBqDepth = currentBqDepth

        if (inIndentedCodeBlock) {
            if (restAfterBq.trim() === '' || /^(?: {4,}|\t)/.test(restAfterBq)) {
                outLines.push(line)
                prevLineWasBlank = restAfterBq.trim() === ''
                continue
            }
            inIndentedCodeBlock = false
        }

        if (prevLineWasBlank && /^(?: {4,}|\t)\S/.test(restAfterBq)) {
            flushParagraphLines()
            inIndentedCodeBlock = true
            outLines.push(line)
            prevLineWasBlank = false
            continue
        }

        if (restAfterBq.trim() === '') {
            flushParagraphLines()
            outLines.push(line)
            prevLineWasBlank = true
            continue
        }

        if (multiLineInlineCodeLines.has(i)) {
            pendingParagraphLines.push(line)
            prevLineWasBlank = false
            continue
        }

        const singleLineBracket = line.match(/^((?:\s{0,3}>\s*)*\s*)\\\[(.+?)\\\]\s*$/)
        if (
            singleLineBracket &&
            singleLineBracket[2] &&
            !singleLineBracket[2].includes('\\]') &&
            !singleLineBracket[2].includes('`')
        ) {
            flushParagraphLines()
            const prefix = singleLineBracket[1] ?? ''
            const inner = singleLineBracket[2].trim()
            if (inner.length > 0) {
                outLines.push(`${prefix}$$\n${prefix}${inner}\n${prefix}$$`)
                prevLineWasBlank = false
                continue
            }
        }

        const singleLineDollar = line.match(/^((?:\s{0,3}>\s*)*\s*)\$\$(.+?)\$\$\s*$/)
        if (
            singleLineDollar &&
            singleLineDollar[2] &&
            !singleLineDollar[2].includes('$$') &&
            !singleLineDollar[2].includes('`')
        ) {
            flushParagraphLines()
            const prefix = singleLineDollar[1] ?? ''
            const inner = singleLineDollar[2].trim()
            if (inner.length > 0) {
                outLines.push(`${prefix}$$\n${prefix}${inner}\n${prefix}$$`)
                prevLineWasBlank = false
                continue
            }
        }

        const openBracketMatch = line.match(/^((?:\s{0,3}>\s*)*\s*)\\\[(.*)$/)
        if (
            openBracketMatch &&
            openBracketMatch[2] !== undefined &&
            !openBracketMatch[2].includes('\\]') &&
            !openBracketMatch[2].includes('`')
        ) {
            let hasClosingBracket = false
            for (let k = i + 1; k < lines.length; k++) {
                const ahead = lines[k] ?? ''
                if (fenceOpenRegex.test(ahead)) break
                if (/^((?:\s{0,3}>\s*)*\s*)(.*?)\\\]\s*$/.test(ahead)) {
                    hasClosingBracket = true
                    break
                }
            }
            if (hasClosingBracket) {
                flushParagraphLines()
                const prefix = openBracketMatch[1] ?? ''
                const trailing = openBracketMatch[2].trim()
                inBracketBlock = { prefix }
                if (trailing.length > 0) {
                    outLines.push(`${prefix}$$\n${prefix}${trailing}`)
                } else {
                    outLines.push(`${prefix}$$`)
                }
                prevLineWasBlank = false
                continue
            }
        }

        const openDollarMatch = line.match(/^((?:\s{0,3}>\s*)*\s*)\$\$(.*)$/)
        if (
            openDollarMatch &&
            openDollarMatch[2] !== undefined &&
            !openDollarMatch[2].includes('$') &&
            !openDollarMatch[2].includes('`')
        ) {
            flushParagraphLines()
            const prefix = openDollarMatch[1] ?? ''
            const trailing = openDollarMatch[2].trim()
            inDollarBlock = { prefix }
            if (trailing.length > 0) {
                outLines.push(`${prefix}$$\n${prefix}${trailing}`)
            } else {
                outLines.push(line)
            }
            prevLineWasBlank = false
            continue
        }

        pendingParagraphLines.push(line)
        prevLineWasBlank = false
    }

    flushParagraphLines()

    if (inDollarBlock !== null) {
        outLines.push(`${inDollarBlock.prefix}$$`)
    }

    return outLines.join('\n')
}

