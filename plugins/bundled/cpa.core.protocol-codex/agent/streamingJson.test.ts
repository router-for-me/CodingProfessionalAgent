import { describe, expect, it } from 'vitest'
import { parseStreamingJson } from './streamingJson'

describe('parseStreamingJson', () => {
    it('returns empty object for empty input', () => {
        expect(parseStreamingJson('')).toEqual({})
        expect(parseStreamingJson(undefined)).toEqual({})
        expect(parseStreamingJson(null)).toEqual({})
        expect(parseStreamingJson('   ')).toEqual({})
    })

    it('parses complete JSON objects', () => {
        expect(parseStreamingJson('{"path":"a.ts"}')).toEqual({ path: 'a.ts' })
    })

    it('parses incomplete object prefixes for UI previews', () => {
        expect(parseStreamingJson('{"path":"src/')).toEqual({ path: 'src/' })
        expect(parseStreamingJson('{"path":')).toEqual({ path: null })
        expect(parseStreamingJson('{')).toEqual({})
        expect(parseStreamingJson('{"a":1,"b":')).toEqual({ a: 1, b: null })
    })

    it('falls back to empty object for unrecoverable fragments', () => {
        expect(parseStreamingJson('not-json')).toEqual({})
        expect(parseStreamingJson('[1,2]')).toEqual({})
    })

    it('repairs raw control characters inside strings', () => {
        expect(parseStreamingJson('{"text":"line1\nline2"}')).toEqual({
            text: 'line1\nline2',
        })
    })
})
