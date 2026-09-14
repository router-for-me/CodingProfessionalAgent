import { describe, expect, it } from 'vitest'
import { createBrowserImageProcessor } from './image.js'

describe('createBrowserImageProcessor', () => {
    it('supports process() method with ImageProcessResult shape', async () => {
        const processor = createBrowserImageProcessor()
        const bytes = new Uint8Array([72, 101, 108, 108, 111]) // "Hello"
        const result = await processor.process(bytes, 'image/png')

        expect(result.ok).toBe(true)
        if (result.ok) {
            expect(result.data).toBe(btoa('Hello'))
            expect(result.mimeType).toBe('image/png')
            expect(result.wasResized).toBe(false)
            expect(result.hints).toEqual([])
        }
    })

    it('supports legacy processImage() method with ProcessedImage shape', async () => {
        const processor = createBrowserImageProcessor()
        const bytes = new Uint8Array([72, 101, 108, 108, 111])
        expect(processor.processImage).toBeDefined()
        const result = await processor.processImage!(bytes, 'image/png')

        expect(result.mediaType).toBe('image/png')
        expect(result.base64Data).toBe(btoa('Hello'))
        expect(result.originalBytes).toBe(5)
        expect(result.resizedBytes).toBe(5)
    })
})
