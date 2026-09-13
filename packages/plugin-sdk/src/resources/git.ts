/**
 * CPA Git settings prompt formatter.
 * Formats configured Git settings into a dedicated <git> XML block for system prompt injection.
 * If no settings are configured or filled, returns an empty string.
 */

import type { GitSettings } from '@cpa/plugin-api'

function sanitizeGitInstruction(text: string): string {
    return text.replace(/<\/git>/gi, '&lt;/git&gt;').trim()
}

/**
 * Formats configured Git settings into an XML block for injection into the system prompt.
 * Only non-empty and explicitly defined settings are included. If none are provided or filled, returns an empty string.
 */
export function formatGitSettingsForPrompt(
    git?: Partial<GitSettings> | null,
): string {
    if (!git || typeof git !== 'object') {
        return ''
    }

    const items: string[] = []

    // 1. Pull request merge method
    if (typeof git.mergeMethod === 'string') {
        const method = git.mergeMethod.trim()
        if (method.length > 0) {
            items.push(`Use the "${method}" method when merging pull requests.`)
        }
    }

    // 2. Always force push
    if (typeof git.alwaysForcePush === 'boolean') {
        if (git.alwaysForcePush) {
            items.push(
                'When pushing branches to the remote repository, always use force push with lease (e.g. "git push --force-with-lease").',
            )
        } else {
            items.push(
                'Do not force push when pushing branches unless explicitly instructed.',
            )
        }
    }

    // 3. Create draft pull requests
    if (typeof git.createDraftPr === 'boolean') {
        if (git.createDraftPr) {
            items.push(
                'When creating pull requests, create them as draft by default (e.g. "gh pr create --draft").',
            )
        } else {
            items.push(
                'Do not create pull requests as draft by default (create regular, ready-for-review pull requests).',
            )
        }
    }

    // 4. Commit instructions
    if (typeof git.commitInstructions === 'string') {
        const trimmed = sanitizeGitInstruction(git.commitInstructions)
        if (trimmed.length > 0) {
            if (trimmed.includes('\n')) {
                items.push(`Commit instructions:\n${trimmed}`)
            } else {
                items.push(`Commit instructions: ${trimmed}`)
            }
        }
    }

    // 5. Pull request instructions
    if (typeof git.prInstructions === 'string') {
        const trimmed = sanitizeGitInstruction(git.prInstructions)
        if (trimmed.length > 0) {
            if (trimmed.includes('\n')) {
                items.push(`Pull request instructions:\n${trimmed}`)
            } else {
                items.push(`Pull request instructions: ${trimmed}`)
            }
        }
    }

    if (items.length === 0) {
        return ''
    }

    return `\n\n<git>\n${items.join('\n')}\n</git>`
}
