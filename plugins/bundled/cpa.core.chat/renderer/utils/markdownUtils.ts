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

