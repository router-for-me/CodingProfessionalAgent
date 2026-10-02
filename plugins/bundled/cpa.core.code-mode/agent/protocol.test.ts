import { describe, expect, it } from 'vitest'
import { EXEC_PARAMETERS, WAIT_PARAMETERS, execParametersForLocale } from './protocol'

describe('Code Mode function tool schemas', () => {
    it('uses a source string rather than a freeform or custom protocol tool', () => {
        expect(EXEC_PARAMETERS).toEqual({
            type: 'object',
            properties: {
                source: {
                    type: 'string',
                    description: 'Raw JavaScript source. Optional first line: // @exec: {"yield_time_ms":10000,"max_output_tokens":1000}',
                },
                description: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 200,
                    description: 'Short user-visible summary of this batch, shown in the activity line. One sentence describing what the code does, not the source itself.',
                },
            },
            required: ['source', 'description'],
            additionalProperties: false,
        })
        expect(execParametersForLocale('zh-CN')).toMatchObject({
            properties: { description: { description: expect.stringContaining('Simplified Chinese (zh-CN)') } },
        })
        expect(execParametersForLocale('en')).toMatchObject({
            properties: { description: { description: expect.stringContaining('English (en)') } },
        })
        expect(execParametersForLocale(undefined)).not.toBe(EXEC_PARAMETERS)
    })

    it('requires only cell_id for wait and bounds optional numeric fields', () => {
        expect(WAIT_PARAMETERS).toMatchObject({
            type: 'object', required: ['cell_id'], additionalProperties: false,
            properties: {
                cell_id: { type: 'string' },
                yield_time_ms: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
                max_tokens: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
                terminate: { type: 'boolean' },
            },
        })
    })
})
