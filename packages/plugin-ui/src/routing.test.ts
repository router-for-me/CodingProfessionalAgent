import { describe, expect, it } from 'vitest'
import { createHashRouteUrl, getHashRoutePathname } from './routing.js'

describe('Hash route utilities', () => {
    it.each([
        ['', '/'],
        ['#/', '/'],
        ['#/chat/session-1', '/chat/session-1'],
        ['#/chat/session-1?tab=files#details', '/chat/session-1'],
        ['#anchor', '/'],
    ])('extracts pathname from %s', (hash, expected) => {
        expect(getHashRoutePathname(hash)).toBe(expected)
    })

    it.each([
        'http://localhost:5173/',
        'https://example.com/cpa/?token=example',
        'file:///Applications/CPA.app/Contents/Resources/app.asar/frontend/dist/index.html',
    ])('preserves the document URL in deep links: %s', (baseUrl) => {
        const link = createHashRouteUrl('/chat/session-1?tab=files', `${baseUrl}#/old`)
        expect(link).toBe(`${baseUrl}#/chat/session-1?tab=files`)
        expect(getHashRoutePathname(new URL(link).hash)).toBe('/chat/session-1')
    })
})
