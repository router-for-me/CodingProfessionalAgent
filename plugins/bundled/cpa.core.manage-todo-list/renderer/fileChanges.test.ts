import { describe, expect, it } from 'vitest'
import { extractFileChangesFromEntries } from '../shared/fileChanges.js'

describe('extractFileChangesFromEntries', () => {
    it('returns null for empty entries', () => {
        expect(extractFileChangesFromEntries([])).toBeNull()
        expect(extractFileChangesFromEntries(null)).toBeNull()
    })

    it('aggregates edit and write mutations and skips errored tool calls', () => {
        const result = extractFileChangesFromEntries([
            {
                kind: 'toolResult',
                toolCallId: 'failed-edit',
                isError: true,
            },
            {
                kind: 'assistant',
                createdAt: 100,
                content: [
                    {
                        type: 'toolCall',
                        id: 'failed-edit',
                        name: 'edit',
                        arguments: {
                            path: 'src/bad.ts',
                            edits: [{ oldText: 'a', newText: 'b' }],
                        },
                    },
                    {
                        type: 'toolCall',
                        id: 'ok-edit',
                        name: 'edit',
                        arguments: {
                            path: 'src/ok.ts',
                            edits: [{ oldText: 'line1', newText: 'line1\nline2\nline3' }],
                        },
                        details: { additions: 2, deletions: 0 },
                    },
                    {
                        type: 'tool_call',
                        id: 'ok-write',
                        name: 'write',
                        args: {
                            path: 'src/new.ts',
                            content: 'one\ntwo\nthree',
                        },
                    },
                ],
            },
        ])

        expect(result).toEqual({
            files: {
                'src/ok.ts': {
                    path: 'src/ok.ts',
                    additions: 2,
                    deletions: 0,
                    modifiedAt: 100,
                },
                'src/new.ts': {
                    path: 'src/new.ts',
                    additions: 3,
                    deletions: 0,
                    modifiedAt: 100,
                },
            },
            totalAdditions: 5,
            totalDeletions: 0,
            totalFilesChanged: 2,
        })
    })

    it('accurately computes additions and deletions for edits using computeLineDiffStats', () => {
        const result = extractFileChangesFromEntries([
            {
                kind: 'assistant',
                createdAt: 200,
                content: [
                    {
                        type: 'toolCall',
                        id: 'edit-with-diff',
                        name: 'edit',
                        arguments: {
                            path: 'src/calc.ts',
                            edits: [
                                // Line replacement: 1 line removed, 1 line added
                                {
                                    oldText: 'const value = 10\n',
                                    newText: 'const value = 20\n',
                                },
                                // Deletion only: 2 lines removed, 0 lines added
                                {
                                    oldText: 'const obsolete1 = true\nconst obsolete2 = false\n',
                                    newText: '',
                                },
                            ],
                        },
                    },
                ],
            },
        ])

        expect(result).not.toBeNull()
        expect(result?.files['src/calc.ts']).toEqual({
            path: 'src/calc.ts',
            additions: 1,
            deletions: 3,
            modifiedAt: 200,
        })
        expect(result?.totalAdditions).toBe(1)
        expect(result?.totalDeletions).toBe(3)
        expect(result?.totalFilesChanged).toBe(1)
    })
})
