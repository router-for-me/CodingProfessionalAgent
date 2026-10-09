import { describe, expect, it } from 'vitest'
import { buildMemoryInstructions, loadMemoryContext } from './memoryContext.js'

const expectedInstructions = `## Memory

Local memory is enabled. Memories are stored in a local database and identified by numeric ids. Tools: memories_search, memories_read, memories_add.

Retrieval:
- At the start of each non-trivial task, call \`memories_search\` with keywords for the task topic, technologies, and general user preferences (e.g. \`queries: ["preferences", "conventions", "<topic>"]\`).
- Results contain only ids, titles, and short snippets. Call \`memories_read\` with the relevant ids in a single batch to fetch full content; skip clearly irrelevant ones.
- Skip retrieval only for clearly self-contained trivial requests (current time, simple translation, trivial formatting).
- Apply discovered user preferences, conventions, and prior decisions to your work.

Recording:
- When you complete a task or a non-trivial step, call \`memories_add\` with a short title and a Markdown note summarizing what was done and key decisions.
- Whenever the user expresses a preference or explicit instruction ("always do X", "never do Y"), record it under a \`## User Preferences\` heading.
- Memories are append-only; to update or correct something, add a new memory.

Using memory facts:
- If you rely on a memory-derived fact you did not verify in this turn, say so briefly, and note it may be stale when it is drift-prone.`

describe('buildMemoryInstructions', () => {
    it('returns the exact system prompt from spec section 6', () => {
        expect(buildMemoryInstructions()).toBe(expectedInstructions)
    })

    it('mentions only the database workflow without legacy paths or citations', () => {
        const instructions = buildMemoryInstructions()
        for (const name of ['memories_search', 'memories_read', 'memories_add']) {
            expect(instructions).toContain(name)
        }
        for (const removed of ['MEMORY.md', 'memory_summary', 'rollout_summaries', 'oai-mem-citation', 'extensions/ad_hoc']) {
            expect(instructions).not.toContain(removed)
        }
    })
})

describe('loadMemoryContext', () => {
    it('returns null synchronously when disabled', () => {
        expect(loadMemoryContext({ localMemoryEnabled: false })).toBeNull()
    })

    it('returns instructions synchronously by default or when enabled', () => {
        expect(loadMemoryContext()).toBe(expectedInstructions)
        expect(loadMemoryContext({})).toBe(expectedInstructions)
        expect(loadMemoryContext({ localMemoryEnabled: true })).toBe(expectedInstructions)
    })
})
