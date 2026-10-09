const APPROX_BYTES_PER_TOKEN = 4

/**
 * Approximate token count for text.
 */
export function approxTokenCount(text: string): number {
    const byteLength = new TextEncoder().encode(text).length
    return Math.floor((byteLength + (APPROX_BYTES_PER_TOKEN - 1)) / APPROX_BYTES_PER_TOKEN)
}

/**
 * Approximate bytes for a given token count.
 */
function approxBytesForTokens(tokens: number): number {
    return tokens * APPROX_BYTES_PER_TOKEN
}

/**
 * Truncate middle of text to fit within maxTokens budget.
 */
export function truncateMiddleWithTokenBudget(
    text: string,
    maxTokens: number,
): { content: string; truncated: boolean } {
    if (!text) {
        return { content: '', truncated: false }
    }
    const encoder = new TextEncoder()
    const textBytes = encoder.encode(text)
    const maxBytes = approxBytesForTokens(maxTokens)

    if (maxTokens > 0 && textBytes.length <= maxBytes) {
        return { content: text, truncated: false }
    }

    if (maxBytes === 0) {
        const removedTokens = Math.floor((textBytes.length + 3) / APPROX_BYTES_PER_TOKEN)
        return {
            content: `…${removedTokens} tokens truncated…`,
            truncated: true,
        }
    }

    const leftBudget = Math.floor(maxBytes / 2)
    const rightBudget = maxBytes - leftBudget

    let leftEnd = 0
    let rightStart = text.length

    let currentByteCount = 0
    for (let i = 0; i < text.length; i++) {
        const codePoint = text.codePointAt(i)!
        const charBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
        if (currentByteCount + charBytes <= leftBudget) {
            currentByteCount += charBytes
            if (codePoint > 0xffff) i++
            leftEnd = i + 1
        } else {
            break
        }
    }

    const tailStartTargetBytes = Math.max(0, textBytes.length - rightBudget)
    currentByteCount = 0
    for (let i = 0; i < text.length; i++) {
        const codePoint = text.codePointAt(i)!
        const charBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
        if (currentByteCount >= tailStartTargetBytes) {
            rightStart = i
            break
        }
        currentByteCount += charBytes
        if (codePoint > 0xffff) i++
    }

    if (rightStart < leftEnd) {
        rightStart = leftEnd
    }

    const left = text.slice(0, leftEnd)
    const right = text.slice(rightStart)

    const removedBytes = Math.max(0, textBytes.length - maxBytes)
    const removedTokens = Math.floor((removedBytes + 3) / APPROX_BYTES_PER_TOKEN)
    const marker = `…${removedTokens} tokens truncated…`

    return {
        content: `${left}${marker}${right}`,
        truncated: true,
    }
}
