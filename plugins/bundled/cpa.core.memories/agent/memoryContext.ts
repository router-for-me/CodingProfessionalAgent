export interface LoadMemoryContextOptions {
    localMemoryEnabled?: boolean
}

export function buildMemoryInstructions(): string {
    return `## Memory

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
}

export function loadMemoryContext(options: LoadMemoryContextOptions = {}): string | null {
    return options.localMemoryEnabled === false ? null : buildMemoryInstructions()
}
