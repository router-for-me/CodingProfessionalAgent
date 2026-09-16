import { describe, expect, it } from 'vitest'
import { extractMemoryCitations, stripMemoryCitations } from './memoryCitation.js'

describe('memoryCitation', () => {
    const SAMPLE_XML = `<oai-mem-citation>
<citation_entries>
extensions/ad_hoc/notes/2026-09-15T19-40-00-triage-issue-5847.md:1-8|note=[prior triage workflow and decision criteria]
extensions/ad_hoc/notes/2026-09-16T01-56-16-triage-issue-5851.md:1-10|note=[outcome B handling conventions]
MEMORY.md:234-236|note=[responsesapi citation extraction code pointer]
just_file.md:12
bare_file.md
</citation_entries>
<rollout_ids>
019c6e27-e55b-73d1-87d8-4e01f1f75043
019c7714-3b77-74d1-9866-e1f484aae2ab
</rollout_ids>
</oai-mem-citation>`

    it('returns original text when no citation tag is present', () => {
        const text = 'Hello world, this is a plain message.'
        const result = extractMemoryCitations(text)
        expect(result.cleanText).toBe(text)
        expect(result.citations).toBeUndefined()
        expect(stripMemoryCitations(text)).toBe(text)
    })

    it('extracts citation entries and rollout IDs while stripping citation XML', () => {
        const rawText = `# Triage Report\n\nSome findings here.\n\n${SAMPLE_XML}`
        const result = extractMemoryCitations(rawText)

        expect(result.cleanText).toBe('# Triage Report\n\nSome findings here.')
        expect(result.citations).toBeDefined()
        expect(result.citations?.entries).toEqual([
            {
                file: 'extensions/ad_hoc/notes/2026-09-15T19-40-00-triage-issue-5847.md',
                lineRange: '1-8',
                note: 'prior triage workflow and decision criteria',
            },
            {
                file: 'extensions/ad_hoc/notes/2026-09-16T01-56-16-triage-issue-5851.md',
                lineRange: '1-10',
                note: 'outcome B handling conventions',
            },
            {
                file: 'MEMORY.md',
                lineRange: '234-236',
                note: 'responsesapi citation extraction code pointer',
            },
            {
                file: 'just_file.md',
                lineRange: '12',
            },
            {
                file: 'bare_file.md',
            },
        ])
        expect(result.citations?.rolloutIds).toEqual([
            '019c6e27-e55b-73d1-87d8-4e01f1f75043',
            '019c7714-3b77-74d1-9866-e1f484aae2ab',
        ])
    })

    it('handles unclosed streaming citation blocks gracefully', () => {
        const partial = `Here is my answer.\n\n<oai-mem-citation>\n<citation_entries>\nnotes/task.md:5-10|note=[task details]`
        const result = extractMemoryCitations(partial)

        expect(result.cleanText).toBe('Here is my answer.')
        expect(result.citations?.entries).toEqual([
            {
                file: 'notes/task.md',
                lineRange: '5-10',
                note: 'task details',
            },
        ])
    })

    it('stripMemoryCitations cleanly removes the XML block', () => {
        const text = `Content before.\n\n${SAMPLE_XML}\n`
        expect(stripMemoryCitations(text)).toBe('Content before.')
    })
})
