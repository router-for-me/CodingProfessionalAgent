import type { Locale } from '@cpa/plugin-api'

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

export function getQuickActionPrompt(
    kind: QuickActionKind,
    locale: Locale = 'zh-CN',
): string {
    const table = PROMPTS[kind] ?? PROMPTS.explore
    return table[locale] ?? table['zh-CN']
}
