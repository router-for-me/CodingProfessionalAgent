/**
 * Matcher pattern evaluation for hooks.
 * Supports regex-based matching for tool names, session sources, triggers, and subagent types.
 */

import type { HookEventName } from './types.js'
import { HOOK_EVENT_NAMES_WITH_MATCHERS } from './types.js'

/**
 * Checks whether an event type supports pattern matching.
 */
export function eventSupportsMatcher(eventName: HookEventName): boolean {
    return HOOK_EVENT_NAMES_WITH_MATCHERS.includes(eventName)
}

/**
 * Evaluates whether a candidate input matches the configured matcher pattern.
 * - Empty / null / undefined matcher pattern matches any input.
 * - Target input undefined / null only matches if pattern is empty / null.
 * - Non-empty pattern is evaluated as a regular expression against the input string.
 */
export function matchesMatcher(
    matcher: string | null | undefined,
    input: string | null | undefined,
): boolean {
    const trimmed = matcher?.trim()
    if (!trimmed) {
        return true
    }
    if (input === undefined || input === null) {
        return false
    }

    try {
        const regex = new RegExp(trimmed)
        return regex.test(input)
    } catch {
        return input.includes(trimmed)
    }
}

/**
 * Validates whether a matcher pattern is a valid regular expression.
 */
export function validateMatcherPattern(pattern: string): { valid: boolean; error?: string } {
    if (!pattern.trim()) {
        return { valid: true }
    }
    try {
        new RegExp(pattern.trim())
        return { valid: true }
    } catch (err) {
        return {
            valid: false,
            error: err instanceof Error ? err.message : String(err),
        }
    }
}
