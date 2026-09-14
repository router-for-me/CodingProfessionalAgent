/** Recognize Gemini IDs, including CPA provider prefixes and thinking suffixes.
 * Do not infer the protocol from a user-facing display label.
 */
export function isGeminiModelId(id: string): boolean {
    return /(?:^|\/)gemini-[^/]+$/i.test(id.trim())
}
