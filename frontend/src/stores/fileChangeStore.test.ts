import { beforeEach, describe, expect, it } from 'vitest'
import {
    extractFileChangesFromEntries,
    syncFileChangesFromEntries,
    useFileChangeStore,
} from './fileChangeStore'
import type { ConversationEntry } from '@/features/agent-runtime/session/types'

describe('fileChangeStore', () => {
    beforeEach(() => {
        useFileChangeStore.getState().clearAll()
    })

    describe('extractFileChangesFromEntries', () => {
        it('returns null for empty or invalid entries', () => {
            expect(extractFileChangesFromEntries(null)).toBeNull()
            expect(extractFileChangesFromEntries([])).toBeNull()
            expect(extractFileChangesFromEntries([{ kind: 'user', id: 'u1', sessionId: 's1', createdAt: 1, content: [] }])).toBeNull()
        })

        it('extracts edit tool calls with line diff additions and deletions', () => {
            const entries: ConversationEntry[] = [
                {
                    kind: 'assistant',
                    id: 'a1',
                    sessionId: 's1',
                    createdAt: 100,
                    status: 'done',
                    stopReason: 'toolUse',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'call_edit_1',
                            name: 'edit',
                            arguments: {
                                path: 'src/main.ts',
                                edits: [
                                    {
                                        oldText: 'const a = 1;\n',
                                        newText: 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
                                    },
                                ],
                            },
                        },
                    ],
                },
                {
                    kind: 'toolResult',
                    id: 'tr1',
                    sessionId: 's1',
                    createdAt: 101,
                    toolCallId: 'call_edit_1',
                    toolName: 'edit',
                    content: [{ type: 'text', text: 'Success' }],
                    isError: false,
                },
            ]

            const result = extractFileChangesFromEntries(entries)
            expect(result).not.toBeNull()
            expect(result?.totalFilesChanged).toBe(1)
            expect(result?.totalAdditions).toBe(2)
            expect(result?.totalDeletions).toBe(0)
            expect(result?.files['src/main.ts']?.additions).toBe(2)
        })

        it('extracts write tool calls and skips errored tool results', () => {
            const entries: ConversationEntry[] = [
                {
                    kind: 'assistant',
                    id: 'a1',
                    sessionId: 's1',
                    createdAt: 100,
                    status: 'done',
                    stopReason: 'toolUse',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'call_write_1',
                            name: 'write',
                            arguments: {
                                path: 'docs/readme.md',
                                content: 'Line 1\nLine 2\nLine 3\nLine 4',
                            },
                        },
                        {
                            type: 'toolCall',
                            id: 'call_write_fail',
                            name: 'write',
                            arguments: {
                                path: 'error.txt',
                                content: 'Fail content',
                            },
                        },
                    ],
                },
                {
                    kind: 'toolResult',
                    id: 'tr1',
                    sessionId: 's1',
                    createdAt: 101,
                    toolCallId: 'call_write_1',
                    toolName: 'write',
                    content: [{ type: 'text', text: 'Success' }],
                    isError: false,
                },
                {
                    kind: 'toolResult',
                    id: 'tr2',
                    sessionId: 's1',
                    createdAt: 102,
                    toolCallId: 'call_write_fail',
                    toolName: 'write',
                    content: [{ type: 'text', text: 'Permission denied' }],
                    isError: true,
                },
            ]

            const result = extractFileChangesFromEntries(entries)
            expect(result).not.toBeNull()
            expect(result?.totalFilesChanged).toBe(1)
            expect(result?.files['docs/readme.md']).toBeDefined()
            expect(result?.files['error.txt']).toBeUndefined()
            expect(result?.totalAdditions).toBe(4)
            expect(result?.totalDeletions).toBe(0)
        })

        it('aggregates multiple edits to multiple files correctly', () => {
            const entries: ConversationEntry[] = [
                {
                    kind: 'assistant',
                    id: 'a1',
                    sessionId: 's1',
                    createdAt: 100,
                    status: 'done',
                    stopReason: 'toolUse',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'call_1',
                            name: 'edit',
                            arguments: {
                                path: 'file1.ts',
                                edits: [
                                    {
                                        oldText: 'old line 1\nold line 2',
                                        newText: 'new line 1',
                                    },
                                ],
                            },
                        },
                        {
                            type: 'toolCall',
                            id: 'call_2',
                            name: 'write',
                            arguments: {
                                path: 'file2.ts',
                                content: 'alpha\nbeta\ngamma',
                            },
                        },
                    ],
                },
            ]

            const result = extractFileChangesFromEntries(entries)
            expect(result?.totalFilesChanged).toBe(2)
            expect(result?.files['file1.ts']?.additions).toBe(1)
            expect(result?.files['file1.ts']?.deletions).toBe(2)
            expect(result?.files['file2.ts']?.additions).toBe(3)
            expect(result?.files['file2.ts']?.deletions).toBe(0)
            expect(result?.totalAdditions).toBe(4)
            expect(result?.totalDeletions).toBe(2)
        })
    })

    describe('recordChange & syncFileChangesFromEntries', () => {
        it('records live changes incrementally', () => {
            useFileChangeStore.getState().recordChange('s1', {
                path: 'a.ts',
                additions: 10,
                deletions: 2,
            })
            expect(useFileChangeStore.getState().getChanges('s1').totalAdditions).toBe(10)
            expect(useFileChangeStore.getState().getChanges('s1').totalDeletions).toBe(2)
            expect(useFileChangeStore.getState().getChanges('s1').totalFilesChanged).toBe(1)

            useFileChangeStore.getState().recordChange('s1', {
                path: 'a.ts',
                additions: 5,
                deletions: 1,
            })
            expect(useFileChangeStore.getState().getChanges('s1').totalAdditions).toBe(15)
            expect(useFileChangeStore.getState().getChanges('s1').totalDeletions).toBe(3)
            expect(useFileChangeStore.getState().getChanges('s1').totalFilesChanged).toBe(1)

            useFileChangeStore.getState().recordChange('s1', {
                path: 'b.ts',
                additions: 73,
                deletions: 15,
            })
            expect(useFileChangeStore.getState().getChanges('s1').totalAdditions).toBe(88)
            expect(useFileChangeStore.getState().getChanges('s1').totalDeletions).toBe(18)
            expect(useFileChangeStore.getState().getChanges('s1').totalFilesChanged).toBe(2)
        })

        it('syncs from entries and clears session changes', () => {
            const entries: ConversationEntry[] = [
                {
                    kind: 'assistant',
                    id: 'a1',
                    sessionId: 's-sync',
                    createdAt: 100,
                    status: 'done',
                    stopReason: 'toolUse',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'c1',
                            name: 'write',
                            arguments: { path: 'test.ts', content: 'test' },
                        },
                    ],
                },
            ]

            syncFileChangesFromEntries('s-sync', entries)
            expect(useFileChangeStore.getState().getChanges('s-sync').totalFilesChanged).toBe(1)

            syncFileChangesFromEntries('s-sync', [])
            expect(useFileChangeStore.getState().getChanges('s-sync').totalFilesChanged).toBe(0)
        })
    })
})
