import { describe, expect, it } from 'vitest'
import {
    isBuiltinSlashCommand,
    matchSlashQuery,
    parseSlashCommand,
} from './slashCommands.js'

describe('slashCommands utilities', () => {
    describe('isBuiltinSlashCommand', () => {
        it('identifies compact commands across languages and aliases', () => {
            expect(isBuiltinSlashCommand('/compact')).toBe(true)
            expect(isBuiltinSlashCommand('/compact focus on tests')).toBe(true)
            expect(isBuiltinSlashCommand('/压缩')).toBe(true)
            expect(isBuiltinSlashCommand('/压缩 关注权限模块')).toBe(true)
            expect(isBuiltinSlashCommand('/compress')).toBe(true)
        })

        it('identifies model commands across languages and aliases', () => {
            expect(isBuiltinSlashCommand('/model')).toBe(true)
            expect(isBuiltinSlashCommand('/model ')).toBe(true)
            expect(isBuiltinSlashCommand('/模型')).toBe(true)
            expect(isBuiltinSlashCommand('/models')).toBe(true)
        })

        it('identifies skill prefix', () => {
            expect(isBuiltinSlashCommand('/skill:devin')).toBe(true)
        })

        it('returns false for prompt templates or regular text', () => {
            expect(isBuiltinSlashCommand('/my-custom-prompt')).toBe(false)
            expect(isBuiltinSlashCommand('regular text')).toBe(false)
            expect(isBuiltinSlashCommand('')).toBe(false)
        })
    })

    describe('parseSlashCommand', () => {
        it('parses compact command and extracts focus parameter', () => {
            const enNoFocus = parseSlashCommand('/compact')
            expect(enNoFocus).toEqual({
                type: 'compact',
                focus: '',
                commandToken: 'compact',
            })

            const enWithFocus = parseSlashCommand('/compact focus on security')
            expect(enWithFocus).toEqual({
                type: 'compact',
                focus: 'focus on security',
                commandToken: 'compact',
            })

            const zhNoFocus = parseSlashCommand('/压缩')
            expect(zhNoFocus).toEqual({
                type: 'compact',
                focus: '',
                commandToken: '压缩',
            })

            const zhWithFocus = parseSlashCommand('/压缩 重点关注鉴权和数据校验')
            expect(zhWithFocus).toEqual({
                type: 'compact',
                focus: '重点关注鉴权和数据校验',
                commandToken: '压缩',
            })

            const fullWidthSpace = parseSlashCommand('/压缩\u3000全角空格参数')
            expect(fullWidthSpace).toEqual({
                type: 'compact',
                focus: '全角空格参数',
                commandToken: '压缩',
            })
        })

        it('parses model command', () => {
            const enModel = parseSlashCommand('/model')
            expect(enModel).toEqual({
                type: 'model',
                focus: '',
                commandToken: 'model',
            })

            const zhModel = parseSlashCommand('/模型')
            expect(zhModel).toEqual({
                type: 'model',
                focus: '',
                commandToken: '模型',
            })
        })

        it('returns unknown for unregistered commands', () => {
            const unknown = parseSlashCommand('/custom-template arg1 arg2')
            expect(unknown).toEqual({
                type: 'unknown',
                focus: 'arg1 arg2',
                commandToken: 'custom-template',
            })
        })
    })

    describe('matchSlashQuery', () => {
        it('matches on command body prefix ignoring case', () => {
            expect(matchSlashQuery('comp', 'compact', 'Compact context')).toBe(true)
            expect(matchSlashQuery('COMP', 'compact', 'Compact context')).toBe(true)
            expect(matchSlashQuery('压', '压缩', '压缩对话上下文')).toBe(true)
            expect(matchSlashQuery('压缩', '压缩', '压缩对话上下文')).toBe(true)
        })

        it('matches on alias prefix', () => {
            expect(matchSlashQuery('comp', '压缩', '压缩对话上下文', ['compact', '压缩', 'compress'])).toBe(true)
            expect(matchSlashQuery('压', 'compact', 'Compact context', ['compact', '压缩'])).toBe(true)
            expect(matchSlashQuery('mod', '模型', '打开模型选择器', ['model', '模型'])).toBe(true)
            expect(matchSlashQuery('模', 'model', 'Open model selector', ['model', '模型'])).toBe(true)
        })

        it('does not falsely match unrelated queries', () => {
            expect(matchSlashQuery('diff', 'compact', 'Compact context', ['compact'])).toBe(false)
            expect(matchSlashQuery('c', 'model', 'Open model selector', ['model'])).toBe(false)
        })
    })
})
