/**
 * Extract the primary tool call ID from a composite ID (`call_id|item_id`).
 */
export function normalizeToolCallId(id: string): string {
    return id.split('|', 1)[0] ?? id
}

export const codexCallId = normalizeToolCallId
