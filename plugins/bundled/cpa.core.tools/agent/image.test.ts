import { describe, expect, it, vi } from 'vitest'
import {
    bytesToBase64,
    createBrowserImageProcessor,
    detectImageMimeType,
    fitWithin,
    formatDimensionHint,
    type CanvasLike,
    type ImageBitmap,
} from './image'

function jpegBytes(): Uint8Array {
    // SOI + APP0 marker (minimum valid marker sequence)
    return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
}

function pngBytes(): Uint8Array {
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
}

function gifBytes(): Uint8Array {
    // Header (6) + Logical Screen Descriptor (7) = 13 bytes minimum
    return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00])
}

function webpBytes(): Uint8Array {
    const bytes = new Uint8Array(16)
    bytes.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
    bytes.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
    return bytes
}

function bmpBytes(): Uint8Array {
    // BITMAPFILEHEADER is 14 bytes
    return new Uint8Array([0x42, 0x4d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
}

describe('image helpers', () => {
    describe('detectImageMimeType', () => {
        it('detects jpeg/png/gif/webp/bmp from magic bytes', () => {
            expect(detectImageMimeType(jpegBytes())).toBe('image/jpeg')
            expect(detectImageMimeType(pngBytes())).toBe('image/png')
            expect(detectImageMimeType(gifBytes())).toBe('image/gif')
            expect(detectImageMimeType(webpBytes())).toBe('image/webp')
            expect(detectImageMimeType(bmpBytes())).toBe('image/bmp')
        })

        it('returns undefined for non-image payloads', () => {
            expect(detectImageMimeType(new TextEncoder().encode('hello'))).toBeUndefined()
            expect(detectImageMimeType(new Uint8Array([0x00, 0x01]))).toBeUndefined()
        })

        it('rejects truncated magic headers that lack minimum structure', () => {
            // 3-byte JPEG SOI fragment
            expect(detectImageMimeType(new Uint8Array([0xff, 0xd8, 0xff]))).toBeUndefined()
            // 2-byte BMP signature only
            expect(detectImageMimeType(new Uint8Array([0x42, 0x4d]))).toBeUndefined()
            // 6-byte GIF header without logical screen descriptor
            expect(
                detectImageMimeType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])),
            ).toBeUndefined()
            // Incomplete PNG signature
            expect(
                detectImageMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a])),
            ).toBeUndefined()
            // RIFF without full WEBP tag (under 12 bytes)
            expect(
                detectImageMimeType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45])),
            ).toBeUndefined()
        })
    })

    describe('fitWithin', () => {
        it('does not upscale images already within bounds', () => {
            expect(fitWithin(800, 600, 2000, 2000)).toEqual({
                width: 800,
                height: 600,
                scale: 1,
                wasResized: false,
            })
        })

        it('keeps aspect ratio and never exceeds max 2000', () => {
            const result = fitWithin(4000, 2000, 2000, 2000)
            expect(result.width).toBe(2000)
            expect(result.height).toBe(1000)
            expect(result.wasResized).toBe(true)
            expect(result.width).toBeLessThanOrEqual(2000)
            expect(result.height).toBeLessThanOrEqual(2000)
        })

        it('fits tall images by height', () => {
            const result = fitWithin(1000, 5000, 2000, 2000)
            expect(result.height).toBe(2000)
            expect(result.width).toBe(400)
        })

        it('rejects non-positive dimensions', () => {
            expect(() => fitWithin(0, 10)).toThrow(/positive/i)
            expect(() => fitWithin(10, -1)).toThrow(/positive/i)
        })
    })

    describe('createBrowserImageProcessor', () => {
        it('keeps original mime and data when no resize is needed', async () => {
            const source = pngBytes()
            const close = vi.fn()
            const processor = createBrowserImageProcessor({
                createImageBitmap: async () =>
                    ({
                        width: 100,
                        height: 80,
                        close,
                    }) as ImageBitmap,
                createCanvas: () => {
                    throw new Error('canvas should not be used when no resize is needed')
                },
            })

            const result = await processor.process(source, 'image/png')
            expect(result.ok).toBe(true)
            if (!result.ok) {
                return
            }
            expect(result.wasResized).toBe(false)
            expect(result.mimeType).toBe('image/png')
            expect(result.data).toBe(bytesToBase64(source))
            expect(result.hints).toEqual([])
            expect(close).toHaveBeenCalledTimes(1)
        })

        it('resizes oversized images to PNG/JPEG with an accurate dimension hint', async () => {
            const source = jpegBytes()
            const close = vi.fn()
            const drawImage = vi.fn()
            const processor = createBrowserImageProcessor({
                createImageBitmap: async () =>
                    ({
                        width: 4000,
                        height: 2000,
                        close,
                    }) as ImageBitmap,
                createCanvas: (width, height) => {
                    expect(width).toBe(2000)
                    expect(height).toBe(1000)
                    const canvas: CanvasLike = {
                        width,
                        height,
                        getContext: () => ({ drawImage }),
                        convertToBlob: async ({ type } = {}) =>
                            new Blob([new Uint8Array([1, 2, 3])], { type: type ?? 'image/png' }),
                    }
                    return canvas
                },
                blobToBase64: async () => 'resized-base64',
            })

            const result = await processor.process(source, 'image/jpeg')
            expect(result.ok).toBe(true)
            if (!result.ok) {
                return
            }
            expect(result.wasResized).toBe(true)
            expect(result.mimeType).toBe('image/jpeg')
            expect(result.data).toBe('resized-base64')
            expect(result.hints[0]).toBe(formatDimensionHint(4000, 2000, 2000, 1000))
            expect(drawImage).toHaveBeenCalled()
            expect(close).toHaveBeenCalledTimes(1)
        })

        it('cleans up the bitmap and returns an error note on failure', async () => {
            const close = vi.fn()
            const processor = createBrowserImageProcessor({
                createImageBitmap: async () =>
                    ({
                        width: 3000,
                        height: 3000,
                        close,
                    }) as ImageBitmap,
                createCanvas: () => {
                    throw new Error('canvas boom')
                },
            })

            const result = await processor.process(pngBytes(), 'image/png')
            expect(result.ok).toBe(false)
            if (result.ok) {
                return
            }
            expect(result.message).toMatch(/canvas boom/)
            expect(close).toHaveBeenCalledTimes(1)
        })

        it('keeps original GIF bytes when oversized to preserve animation', async () => {
            const source = gifBytes()
            const close = vi.fn()
            const processor = createBrowserImageProcessor({
                createImageBitmap: async () =>
                    ({
                        width: 4000,
                        height: 2000,
                        close,
                    }) as ImageBitmap,
                createCanvas: () => {
                    throw new Error('canvas must not be used for oversized GIF')
                },
            })

            const result = await processor.process(source, 'image/gif')
            expect(result.ok).toBe(true)
            if (!result.ok) {
                return
            }
            expect(result.wasResized).toBe(false)
            expect(result.mimeType).toBe('image/gif')
            expect(result.data).toBe(bytesToBase64(source))
            expect(result.hints.some((hint) => /GIF resizing skipped to preserve animation/i.test(hint))).toBe(
                true,
            )
            expect(close).toHaveBeenCalledTimes(1)
        })

        it('returns positive dimensions on no-resize path and always closes bitmap', async () => {
            const source = pngBytes()
            const close = vi.fn()
            const processor = createBrowserImageProcessor({
                autoResize: false,
                createImageBitmap: async () =>
                    ({
                        width: 640,
                        height: 480,
                        close,
                    }) as ImageBitmap,
                createCanvas: () => {
                    throw new Error('canvas must not be used when autoResize is false')
                },
            })

            const result = await processor.process(source, 'image/png')
            expect(result.ok).toBe(true)
            if (!result.ok) return
            expect(result.wasResized).toBe(false)
            expect(result.width).toBe(640)
            expect(result.height).toBe(480)
            expect(result.originalWidth).toBe(640)
            expect(result.originalHeight).toBe(480)
            expect(result.data).toBe(bytesToBase64(source))
            expect(close).toHaveBeenCalledTimes(1)
        })

        it('rejects non-positive dimensions on no-resize path', async () => {
            const close = vi.fn()
            const processor = createBrowserImageProcessor({
                autoResize: false,
                createImageBitmap: async () =>
                    ({
                        width: 0,
                        height: 10,
                        close,
                    }) as ImageBitmap,
            })
            const result = await processor.process(pngBytes(), 'image/png')
            expect(result.ok).toBe(false)
            expect(close).toHaveBeenCalledTimes(1)
        })
    })
})
