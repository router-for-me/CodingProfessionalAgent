/**
 * CPA system prompt builder.
 * Identity is Coding Professional Agent (CPA) — never Pi paths or branding.
 */

import { assertPromptCwd } from '@cpa/plugin-sdk'
import type { PersonalityTone } from '@/types/models'

export const SET_SESSION_TITLE_TOOL_NAME = 'title'
export const TITLE_TOOL_NAME = 'title'

export interface SystemPromptTool {
    name: string
    description: string
}

export interface SystemPromptContextFile {
    path: string
    content: string
}

export interface BuildSystemPromptOptions {
    /** When set, replaces the default CPA base prompt entirely. */
    customPrompt?: string
    /** Appended immediately after the base (default or custom) prompt. */
    appendSystemPrompt?: string
    /** Absolute project working directory; omitted for pure chat mode. */
    cwd?: string
    /** Instruction files in injection order (global → ancestor → cwd). */
    contextFiles?: readonly SystemPromptContextFile[]
    /** Actually available tools; drives capability claims and tool list. */
    tools?: readonly SystemPromptTool[]
    /** Extra guideline lines (optional). */
    promptGuidelines?: readonly string[]
    /** User's selected UI language / locale (e.g. 'zh-CN', 'en'). */
    language?: string
    /** User's selected personality tone constraint. */
    personality?: PersonalityTone | string
}

/**
 * Build a deterministic CPA system prompt from tools, context files, and optional overrides.
 * Does not mutate options, tools, or context file arrays.
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
    const customPrompt = options.customPrompt
    const appendSystemPrompt = options.appendSystemPrompt
    const cwd = options.cwd
    const contextFiles = options.contextFiles ?? []
    const tools = options.tools ?? []
    const promptGuidelines = options.promptGuidelines ?? []

    const toolNames = new Set(
        tools
            .map((tool) => sanitizeSingleLine(tool.name))
            .filter((name) => name.length > 0),
    )
    const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : ''
    const languageGuideline = resolveLanguageGuideline(options.language)
    const personalityGuideline = resolvePersonalityGuideline(options.personality)

    let prompt: string
    if (customPrompt !== undefined && customPrompt !== null) {
        // Custom SYSTEM replaces the default base; do not invent capability claims.
        prompt = customPrompt
        if (appendSection) {
            prompt += appendSection
        }
        const customGuidelines: string[] = []
        if (languageGuideline) {
            customGuidelines.push(languageGuideline)
        }
        if (personalityGuideline) {
            customGuidelines.push(personalityGuideline)
        }
        if (toolNames.has('title') || toolNames.has('set_session_title')) {
            customGuidelines.push(
                'Before starting other work, call the title tool to set a concise session title based on user input',
            )
        }
        if (customGuidelines.length > 0) {
            prompt += `\n\nGuidelines:\n${customGuidelines.map((g) => `- ${g}`).join('\n')}`
        }
    } else {
        prompt = buildDefaultBasePrompt(
            tools,
            toolNames,
            promptGuidelines,
            languageGuideline,
            personalityGuideline,
        )
        if (appendSection) {
            prompt += appendSection
        }
    }

    if (contextFiles.length > 0) {
        prompt += '\n\n<project_context>\n\n'
        prompt += 'Project-specific instructions and guidelines:\n\n'
        for (const file of contextFiles) {
            const pathAttr = escapeXmlAttribute(file.path)
            const content = sanitizeProjectInstructionContent(file.content)
            prompt += `<project_instructions path="${pathAttr}">\n${content}\n</project_instructions>\n\n`
        }
        prompt += '</project_context>\n'
    }

    if (cwd !== undefined && cwd !== null && cwd !== '') {
        const promptCwd = assertPromptCwd(cwd)
        prompt += `\nCurrent working directory: ${promptCwd}`
    }

    return prompt
}

function buildDefaultBasePrompt(
    tools: readonly SystemPromptTool[],
    toolNames: Set<string>,
    promptGuidelines: readonly string[],
    languageGuideline?: string,
    personalityGuideline?: string,
): string {
    const toolsList =
        tools.length > 0
            ? tools
                  .map((tool) => {
                      const name = sanitizeToolName(tool.name)
                      const description = sanitizeSingleLine(tool.description)
                      return `- ${name}: ${description}`
                  })
                  .join('\n')
            : '(none)'

    const role = buildRoleSentence(toolNames)
    const guidelines = buildGuidelines(
        toolNames,
        promptGuidelines,
        languageGuideline,
        personalityGuideline,
    )

    // Closed-world tool list: only the provided tools, never "other custom tools".
    return `${role}

Available tools:
${toolsList}

Guidelines:
${guidelines}`
}

function buildRoleSentence(toolNames: Set<string>): string {
    const actions: string[] = []
    if (toolNames.has('read')) {
        actions.push('reading files')
    }
    if (toolNames.has('bash') || toolNames.has('pwsh') || toolNames.has('powershell')) {
        actions.push('executing commands')
    }
    if (toolNames.has('edit')) {
        actions.push('editing code')
    }
    if (toolNames.has('write')) {
        actions.push('writing new files')
    }
    if (toolNames.has('spawn_agent')) {
        actions.push('dispatching sub-agents')
    }
    if (toolNames.has('ask')) {
        actions.push('asking clarification questions')
    }

    if (actions.length === 0) {
        return (
            'You are Coding Professional Agent (CPA), an expert coding assistant. ' +
            'You help users through conversation and reasoning.'
        )
    }

    return (
        'You are Coding Professional Agent (CPA), an expert coding assistant. ' +
        `You help users by ${joinNaturalList(actions)}.`
    )
}

/**
 * Map user locale / UI language to a default output language guideline instruction.
 * Returns undefined when language is missing, empty, invalid, or unknown.
 */
export function resolveLanguageGuideline(language?: string): string | undefined {
    if (!language || typeof language !== 'string') {
        return undefined
    }
    const trimmed = language.trim().replace(/_/g, '-')
    if (!trimmed) {
        return undefined
    }

    try {
        const locale = new Intl.Locale(trimmed)
        const lang = locale.language?.toLowerCase()
        if (lang === 'zh') {
            const script = locale.script?.toLowerCase()
            const region = locale.region?.toUpperCase()
            if (
                script === 'hant' ||
                region === 'TW' ||
                region === 'HK' ||
                region === 'MO'
            ) {
                return 'Respond in Traditional Chinese by default unless the user requests otherwise'
            }
            return 'Respond in Simplified Chinese by default unless the user requests otherwise'
        }
        if (lang === 'en') {
            return 'Respond in English by default unless the user requests otherwise'
        }

        const displayNames = new Intl.DisplayNames(['en'], {
            type: 'language',
            fallback: 'none',
        })
        const resolvedName = displayNames.of(locale.baseName || trimmed)
        if (
            resolvedName &&
            resolvedName.toLowerCase() !== trimmed.toLowerCase() &&
            resolvedName.toLowerCase() !== lang
        ) {
            return `Respond in ${resolvedName} by default unless the user requests otherwise`
        }
    } catch {
        // Fall back to undefined for invalid locale tags
    }
    return undefined
}

/**
 * Map personality tone to a system prompt guideline instruction.
 * Returns undefined when personality is missing or unknown.
 */
export function resolvePersonalityGuideline(personality?: string): string | undefined {
    if (!personality || typeof personality !== 'string') {
        return undefined
    }
    switch (personality) {
        case 'pragmatic':
            return 'Maintain a pragmatic, practical, and solution-oriented tone. Focus on actionable steps and real-world efficiency.'
        case 'casual':
            return 'Maintain a casual, friendly, and approachable tone. Speak conversationally while keeping explanations clear.'
        case 'professional':
            return 'Maintain a formal, professional, and courteous tone. Provide well-structured and rigorous explanations.'
        case 'enthusiastic':
            return 'Maintain an energetic, warm, and enthusiastic tone. Encourage the user and express genuine excitement for problem-solving.'
        case 'humorous':
            return 'Maintain a witty, lighthearted, and subtly humorous tone when appropriate, while remaining helpful and accurate.'
        case 'concise':
            return 'Maintain a strict, terse, and highly concise tone. Provide direct answers with minimal fluff and maximum density.'
        default:
            return undefined
    }
}

function buildGuidelines(
    toolNames: Set<string>,
    promptGuidelines: readonly string[],
    languageGuideline?: string,
    personalityGuideline?: string,
): string {
    const guidelinesList: string[] = []
    const seen = new Set<string>()

    const add = (guideline: string): void => {
        // Single-line only: collapse control/newlines so guidelines cannot inject bullets.
        const normalized = sanitizeSingleLine(guideline)
        if (!normalized || seen.has(normalized)) {
            return
        }
        seen.add(normalized)
        guidelinesList.push(normalized)
    }

    const hasBash = toolNames.has('bash')
    const hasPwsh = toolNames.has('pwsh') || toolNames.has('powershell')
    const hasRead = toolNames.has('read')
    const hasEdit = toolNames.has('edit')
    const hasWrite = toolNames.has('write')

    // Exploration via bash or pwsh only when present.
    if (hasBash) {
        add('Use bash for file operations like ls')
        add('Use rg for text searching and fd for file finding instead of grep and find')
    } else if (hasPwsh) {
        add('Use pwsh for file operations like listing, searching, and finding files')
        add('Use rg for text searching and fd for file finding instead of grep and find')
    }

    if (hasRead) {
        add('Use read to examine files instead of cat or sed')
    }

    for (const guideline of promptGuidelines) {
        add(guideline)
    }

    add('Be concise in your responses')

    if (languageGuideline) {
        add(languageGuideline)
    }

    if (personalityGuideline) {
        add(personalityGuideline)
    }

    if (hasRead || hasEdit || hasWrite || hasBash || hasPwsh) {
        add('Show file paths clearly when working with files')
    }

    if (toolNames.has('title') || toolNames.has('set_session_title')) {
        add(
            'Before starting other work, call the title tool to set a concise session title based on user input',
        )
    }

    if (toolNames.has('spawn_agent')) {
        add('Use spawn_agent to delegate independent work to a sub-agent')
        add('When calling spawn_agent, choose a short, human-readable name randomly and pass it in the name field')
        add('When calling spawn_agent, pass the catalog model id the sub-agent should use in the model field')
        add('Use a fresh name for each sub-agent and never let sub-agents spawn their own sub-agents')
    }
    if (toolNames.has('send_message')) {
        add('Use send_message to send follow-up instructions to an existing sub-agent')
    }
    if (toolNames.has('stop_agent')) {
        add('Use stop_agent to abort a running sub-agent')
    }
    if (toolNames.has('ask')) {
        add('Use the ask tool whenever you need to ask the user a question, clarify requirements, confirm choices, or gather user input')
        add('When calling ask, provide a clear question and optionally structured choices in options with title and description')
    }

    return guidelinesList.map((line) => `- ${line}`).join('\n')
}

function joinNaturalList(items: string[]): string {
    if (items.length === 1) {
        return items[0]!
    }
    if (items.length === 2) {
        return `${items[0]} and ${items[1]}`
    }
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

/** Collapse whitespace/control sequences into a single readable line. */
function sanitizeSingleLine(value: string): string {
    return String(value ?? '')
        .replace(/[\u0000-\u001F\u007F]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

/** Empty tool names become a deterministic placeholder so list rendering stays stable. */
function sanitizeToolName(name: string): string {
    const cleaned = sanitizeSingleLine(name)
    return cleaned.length > 0 ? cleaned : '(unnamed)'
}

/**
 * Escape XML attribute specials. Newline/tab/CR become numeric character references.
 * Other C0 controls are stripped.
 */
function escapeXmlAttribute(value: string): string {
    let result = ''
    for (const char of String(value ?? '')) {
        const code = char.charCodeAt(0)
        if (char === '&') {
            result += '&amp;'
        } else if (char === '"') {
            result += '&quot;'
        } else if (char === "'") {
            result += '&apos;'
        } else if (char === '<') {
            result += '&lt;'
        } else if (char === '>') {
            result += '&gt;'
        } else if (char === '\n') {
            result += '&#10;'
        } else if (char === '\r') {
            result += '&#13;'
        } else if (char === '\t') {
            result += '&#9;'
        } else if (code < 0x20 || code === 0x7f) {
            // Strip remaining illegal C0 / DEL controls from attributes.
            continue
        } else {
            result += char
        }
    }
    return result
}

/**
 * Escape text content, strip illegal C0 (keep tab/newline), and neutralize tags that
 * could close or open project_context / project_instructions wrappers.
 * Readable semantics of the original text are preserved via entities.
 */
function sanitizeProjectInstructionContent(content: string): string {
    let text = String(content ?? '')
    // Strip illegal C0 controls except TAB (0x09) and LF (0x0A); normalize CR to LF.
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')

    // Escape XML specials so arbitrary markup cannot break structure.
    text = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')

    // After escaping, closers are already entity-safe. Explicitly re-check patterns
    // that could still appear if callers pre-escaped oddly — keep readable form.
    return text
}

/**
 * Augment an existing system prompt with session title guidelines if not already present.
 */
export function augmentSystemPromptForSessionTitle(systemPrompt: string): string {
    const guideline =
        'Before starting other work, call the title tool to set a concise session title based on user input'
    if (
        systemPrompt.includes(guideline) ||
        systemPrompt.includes('title tool') ||
        systemPrompt.includes('set_session_title tool')
    ) {
        return systemPrompt
    }
    return `${systemPrompt}\n\nGuidelines:\n- ${guideline}`
}
