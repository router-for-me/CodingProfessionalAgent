import { describe, expect, it } from 'vitest'
import { formatGitSettingsForPrompt } from './git.js'

describe('formatGitSettingsForPrompt', () => {
    it('returns empty string when no settings provided, empty object, or non-object', () => {
        expect(formatGitSettingsForPrompt()).toBe('')
        expect(formatGitSettingsForPrompt(null)).toBe('')
        expect(formatGitSettingsForPrompt(undefined)).toBe('')
        expect(formatGitSettingsForPrompt({} as any)).toBe('')
        expect(formatGitSettingsForPrompt('invalid' as any)).toBe('')
    })

    it('returns empty string when fields are empty or whitespace only', () => {
        expect(
            formatGitSettingsForPrompt({
                mergeMethod: '' as any,
                commitInstructions: '   ',
                prInstructions: '',
            }),
        ).toBe('')
    })

    it('injects single commitInstructions when only commit instructions are provided', () => {
        const result = formatGitSettingsForPrompt({
            commitInstructions: 'Use conventional commits format',
        })

        expect(result).toBe(
            '\n\n<git>\nCommit instructions: Use conventional commits format\n</git>',
        )
    })

    it('injects single prInstructions when only PR instructions are provided', () => {
        const result = formatGitSettingsForPrompt({
            prInstructions: 'Include issue reference and test summary',
        })

        expect(result).toBe(
            '\n\n<git>\nPull request instructions: Include issue reference and test summary\n</git>',
        )
    })

    it('injects multiline instructions cleanly with preserved line breaks', () => {
        const multilineCommit = 'Follow guidelines:\n- feat: new feature\n- fix: bug fix'
        const result = formatGitSettingsForPrompt({
            commitInstructions: multilineCommit,
        })

        expect(result).toBe(
            `\n\n<git>\nCommit instructions:\n${multilineCommit}\n</git>`,
        )
    })

    it('formats pull request merge method for merge and squash', () => {
        const mergeResult = formatGitSettingsForPrompt({
            mergeMethod: 'merge',
        })
        expect(mergeResult).toContain('<git>')
        expect(mergeResult).toContain(
            'Use the "merge" method when merging pull requests.',
        )
        expect(mergeResult).not.toContain('Pull request merge method:')
        expect(mergeResult).toContain('</git>')

        const squashResult = formatGitSettingsForPrompt({
            mergeMethod: 'squash',
        })
        expect(squashResult).toContain(
            'Use the "squash" method when merging pull requests.',
        )
        expect(squashResult).not.toContain('Pull request merge method:')
    })

    it('formats alwaysForcePush as true and false', () => {
        const forcePushResult = formatGitSettingsForPrompt({
            alwaysForcePush: true,
        })
        expect(forcePushResult).toContain(
            'When pushing branches to the remote repository, always use force push with lease (e.g. "git push --force-with-lease").',
        )
        expect(forcePushResult).not.toContain('Always force push:')

        const noForcePushResult = formatGitSettingsForPrompt({
            alwaysForcePush: false,
        })
        expect(noForcePushResult).toContain(
            'Do not force push when pushing branches unless explicitly instructed.',
        )
        expect(noForcePushResult).not.toContain('Always force push:')
    })

    it('formats createDraftPr as true and false', () => {
        const draftPrResult = formatGitSettingsForPrompt({
            createDraftPr: true,
        })
        expect(draftPrResult).toContain(
            'When creating pull requests, create them as draft by default (e.g. "gh pr create --draft").',
        )
        expect(draftPrResult).not.toContain('Create draft pull requests:')

        const normalPrResult = formatGitSettingsForPrompt({
            createDraftPr: false,
        })
        expect(normalPrResult).toContain(
            'Do not create pull requests as draft by default (create regular, ready-for-review pull requests).',
        )
        expect(normalPrResult).not.toContain('Create draft pull requests:')
    })

    it('formats all 5 configured settings in one coherent <git> section', () => {
        const result = formatGitSettingsForPrompt({
            mergeMethod: 'squash',
            alwaysForcePush: true,
            createDraftPr: false,
            commitInstructions: 'Use Angular commit conventions',
            prInstructions: 'Link to related issues in PR description',
        })

        expect(result).toBe(
            [
                '',
                '',
                '<git>',
                'Use the "squash" method when merging pull requests.',
                'When pushing branches to the remote repository, always use force push with lease (e.g. "git push --force-with-lease").',
                'Do not create pull requests as draft by default (create regular, ready-for-review pull requests).',
                'Commit instructions: Use Angular commit conventions',
                'Pull request instructions: Link to related issues in PR description',
                '</git>',
            ].join('\n'),
        )
    })

    it('omits fields that the user did not fill in partial settings', () => {
        const result = formatGitSettingsForPrompt({
            mergeMethod: 'merge',
            commitInstructions: 'Prefix with ticket ID',
            // alwaysForcePush, createDraftPr, and prInstructions are omitted / undefined
        })

        expect(result).toContain('Use the "merge" method when merging pull requests.')
        expect(result).toContain('Commit instructions: Prefix with ticket ID')
        expect(result).not.toContain('force push')
        expect(result).not.toContain('draft')
        expect(result).not.toContain('Pull request instructions')
    })

    it('neutralizes </git> closing tag in instructions to prevent XML injection', () => {
        const result = formatGitSettingsForPrompt({
            commitInstructions: 'Do not use </git> in messages',
        })

        expect(result).not.toContain('Do not use </git>')
        expect(result).toContain('Do not use &lt;/git&gt;')
        expect(result.endsWith('</git>')).toBe(true)
    })
})
