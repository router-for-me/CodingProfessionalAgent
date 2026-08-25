import type { Locale } from '@/types/models'

export type QuickActionKind = 'explore' | 'build' | 'review' | 'fix'

const PROMPTS: Record<QuickActionKind, Record<Locale, string>> = {
  explore: {
    'zh-CN':
      'Help me explore and understand this codebase: start from the entry points, outline the main modules, dependencies, and key data flows, and call out the most important places to read first.',
    en: 'Help me explore and understand this codebase: start from the entry points, outline the main modules, dependencies, and key data flows, and call out the most important places to read first.',
  },
  build: {
    'zh-CN':
      'I want to build a new feature. Please clarify the scope and a minimal viable approach, then propose a step-by-step implementation plan (files, APIs, and acceptance criteria).',
    en: 'I want to build a new feature. Please clarify the scope and a minimal viable approach, then propose a step-by-step implementation plan (files, APIs, and acceptance criteria).',
  },
  review: {
    'zh-CN':
      'Please review the current changes (or a diff I will paste). Suggest improvements for correctness, edge cases, readability, and regression risk, ordered by severity.',
    en: 'Please review the current changes (or a diff I will paste). Suggest improvements for correctness, edge cases, readability, and regression risk, ordered by severity.',
  },
  fix: {
    'zh-CN':
      'I hit a failure or error. Help me find the root cause, provide reproduction steps and a fix plan, and explain how to verify the fix.',
    en: 'I hit a failure or error. Help me find the root cause, provide reproduction steps and a fix plan, and explain how to verify the fix.',
  },
}

const MOCK_REPLIES: Record<QuickActionKind | 'general', Record<Locale, string>> =
  {
    explore: {
      'zh-CN': `## Codebase sketch

I started from the entry points and configs:

1. **Bootstrap** — \`src/main.tsx\` mounts the React root
2. **Shell** — \`src/app/App.tsx\` / \`router.tsx\` own routing
3. **State** — \`src/stores/*\` keep sessions and messages in Zustand

\`\`\`ts
// Suggested reading order
const readingOrder = [
  'src/main.tsx',
  'src/app/router.tsx',
  'src/stores/sessionStore.ts',
]
\`\`\`

Tell me which module to dive into next, or I can sketch the data flow.`,
      en: `## Codebase sketch

I started from the entry points and configs:

1. **Bootstrap** — \`src/main.tsx\` mounts the React root
2. **Shell** — \`src/app/App.tsx\` / \`router.tsx\` own routing
3. **State** — \`src/stores/*\` keep sessions and messages in Zustand

\`\`\`ts
// Suggested reading order
const readingOrder = [
  'src/main.tsx',
  'src/app/router.tsx',
  'src/stores/sessionStore.ts',
]
\`\`\`

Tell me which module to dive into next, or I can sketch the data flow.`,
    },
    build: {
      'zh-CN': `## Minimal viable plan

Prefer a demo-able path:

| Step | Work | Acceptance |
|------|------|------------|
| 1 | Model + store API | Types compile |
| 2 | UI skeleton + interactions | Empty state is clickable |
| 3 | Wire persistence / mock service | State survives refresh |

\`\`\`ts
export interface FeatureDraft {
  id: string
  title: string
  status: 'todo' | 'doing' | 'done'
}
\`\`\`

Once you confirm the first acceptance scenario, I can start coding.`,
      en: `## Minimal viable plan

Prefer a demo-able path:

| Step | Work | Acceptance |
|------|------|------------|
| 1 | Model + store API | Types compile |
| 2 | UI skeleton + interactions | Empty state is clickable |
| 3 | Wire persistence / mock service | State survives refresh |

\`\`\`ts
export interface FeatureDraft {
  id: string
  title: string
  status: 'todo' | 'doing' | 'done'
}
\`\`\`

Once you confirm the first acceptance scenario, I can start coding.`,
    },
    review: {
      'zh-CN': `## Review summary

Ordered by severity:

1. **High** — async path lacks an error fallback; UI can stick on loading
2. **Medium** — list keys use index, which can scramble state on reorder
3. **Low** — hard-coded copy; prefer i18n keys

\`\`\`diff
- if (loading) return <Spinner />
+ if (error) return <ErrorState reason={error} />
+ if (loading) return <Spinner />
\`\`\`

Paste a diff or file path and I will dig deeper file by file.`,
      en: `## Review summary

Ordered by severity:

1. **High** — async path lacks an error fallback; UI can stick on loading
2. **Medium** — list keys use index, which can scramble state on reorder
3. **Low** — hard-coded copy; prefer i18n keys

\`\`\`diff
- if (loading) return <Spinner />
+ if (error) return <ErrorState reason={error} />
+ if (loading) return <Spinner />
\`\`\`

Paste a diff or file path and I will dig deeper file by file.`,
    },
    fix: {
      'zh-CN': `## Root-cause hypothesis

A common failure path: the request is aborted, but the UI still treats status as \`streaming\`.

**Reproduce**
1. Send a message
2. Stop mid-stream or switch sessions quickly
3. Check whether the send button recovers

**Fix direction**

\`\`\`ts
try {
  await stream(input)
} finally {
  // Always clear streaming, including abort
  setStatus(signal.aborted ? 'aborted' : 'done')
}
\`\`\`

Share the full stack or a repro clip and I will craft a precise patch.`,
      en: `## Root-cause hypothesis

A common failure path: the request is aborted, but the UI still treats status as \`streaming\`.

**Reproduce**
1. Send a message
2. Stop mid-stream or switch sessions quickly
3. Check whether the send button recovers

**Fix direction**

\`\`\`ts
try {
  await stream(input)
} finally {
  // Always clear streaming, including abort
  setStatus(signal.aborted ? 'aborted' : 'done')
}
\`\`\`

Share the full stack or a repro clip and I will craft a precise patch.`,
    },
    general: {
      'zh-CN': `Got it. I will clarify the goal first, then propose concrete next steps.

Helpful extras:

- Desired outcome
- Related files / error output
- Constraints (deadline, compatibility, etc.)

\`\`\`md
Goal:
Context:
Constraints:
\`\`\`

With that, I can propose a plan or code changes right away.`,
      en: `Got it. I will clarify the goal first, then propose concrete next steps.

Helpful extras:

- Desired outcome
- Related files / error output
- Constraints (deadline, compatibility, etc.)

\`\`\`md
Goal:
Context:
Constraints:
\`\`\`

With that, I can propose a plan or code changes right away.`,
    },
  }

export function getQuickActionPrompt(
  kind: QuickActionKind,
  locale: Locale,
): string {
  return PROMPTS[kind][locale] ?? PROMPTS[kind].en
}

export function getMockReplyTemplate(
  kind: QuickActionKind | 'general',
  locale: Locale,
): string {
  return MOCK_REPLIES[kind][locale] ?? MOCK_REPLIES[kind].en
}
