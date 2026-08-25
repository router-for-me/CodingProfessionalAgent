/**
 * Image mime sniffing, dimension fit, and browser-side resize helpers.
 * No Node Buffer/fs — TextEncoder/Decoder + canvas only.
 */

export type SupportedImageMimeType =
    | 'image/jpeg'
    | 'image/png'
    | 'image/gif'
    | 'image/webp'
    | 'image/bmp'

export interface FitWithinResult {
    width: number
    height: number
    scale: number
    wasResized: boolean
}

export type ImageProcessResult =
    | {
          ok: true
          data: string
          mimeType: SupportedImageMimeType | string
          hints: string[]
          wasResized: boolean
          originalWidth?: number
          originalHeight?: number
          width?: number
          height?: number
      }
    | {
          ok: false
          message: string
      }

export interface ImageProcessor {
    process(bytes: Uint8Array, mimeType: string): Promise<ImageProcessResult>
}

export interface BrowserImageProcessorOptions {
    maxWidth?: number
    maxHeight?: number
    autoResize?: boolean
    /** Injected for tests (jsdom has no real image codecs). */
    createImageBitmap?: (blob: Blob) => Promise<ImageBitmap>
    createCanvas?: (width: number, height: number) => CanvasLike
    blobToBase64?: (blob: Blob) => Promise<string>
}

export interface CanvasLike {
    width: number
    height: number
    getContext(type: '2d'): CanvasRenderingContext2DLike | null
    toBlob?(
        callback: (blob: Blob | null) => void,
        type?: string,
        quality?: number,
    ): void
    convertToBlob?(options?: { type?: string; quality?: number }): Promise<Blob>
}

export interface CanvasRenderingContext2DLike {
    drawImage(
        image: ImageBitmap,
        dx: number,
        dy: number,
        dw: number,
        dh: number,
    ): void
}

export interface ImageBitmap {
    width: number
    height: number
    close(): void
}

const DEFAULT_MAX_EDGE = 2000
const JPEG_QUALITY = 0.85

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

/**
 * Scale dimensions to fit within max bounds without upscaling.
 * Preserves aspect ratio; results are at least 1×1 when input is positive.
 */
export function fitWithin(
    width: number,
    height: number,
    maxWidth: number = DEFAULT_MAX_EDGE,
    maxHeight: number = DEFAULT_MAX_EDGE,
): FitWithinResult {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('width and height must be positive finite numbers')
    }
    if (
        !Number.isFinite(maxWidth) ||
        !Number.isFinite(maxHeight) ||
        maxWidth <= 0 ||
        maxHeight <= 0
    ) {
        throw new Error('maxWidth and maxHeight must be positive finite numbers')
    }

    if (width <= maxWidth && height <= maxHeight) {
        return { width, height, scale: 1, wasResized: false }
    }

    const scale = Math.min(maxWidth / width, maxHeight / height)
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        scale,
        wasResized: true,
    }
}

/**
 * Detect supported image mime from magic bytes (extension is never required).
 * Requires minimum structural length so truncated headers are not treated as images:
 * JPEG >= 4 (SOI + marker), PNG >= 8, GIF >= 13 (header + logical screen descriptor),
 * WebP >= 12, BMP >= 14 (BITMAPFILEHEADER).
 */
export function detectImageMimeType(bytes: Uint8Array): SupportedImageMimeType | undefined {
    // JPEG: FF D8 FF <marker>
    if (
        bytes.byteLength >= 4 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
    ) {
        return 'image/jpeg'
    }
    if (bytes.byteLength >= 8 && startsWith(bytes, PNG_SIGNATURE)) {
        return 'image/png'
    }
    // GIF header (6) + Logical Screen Descriptor (7) = 13
    if (
        bytes.byteLength >= 13 &&
        (startsWithAscii(bytes, 0, 'GIF87a') || startsWithAscii(bytes, 0, 'GIF89a'))
    ) {
        return 'image/gif'
    }
    // RIFF (4) + size (4) + WEBP (4) = 12
    if (
        bytes.byteLength >= 12 &&
        startsWithAscii(bytes, 0, 'RIFF') &&
        startsWithAscii(bytes, 8, 'WEBP')
    ) {
        return 'image/webp'
    }
    // BITMAPFILEHEADER is 14 bytes
    if (bytes.byteLength >= 14 && startsWithAscii(bytes, 0, 'BM')) {
        return 'image/bmp'
    }
    return undefined
}

/** Base64 encode without Node Buffer. */
export function bytesToBase64(bytes: Uint8Array): string {
    const chunkSize = 0x8000
    let binary = ''
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        const slice = bytes.subarray(offset, offset + chunkSize)
        binary += String.fromCharCode(...slice)
    }
    return btoa(binary)
}

/**
 * Decode raw base64 (no data-url prefix) into bytes without Node Buffer.
 * Returns null when the payload is not valid base64.
 */
export function base64ToBytes(base64: string): Uint8Array | null {
    if (typeof base64 !== 'string' || base64.length === 0) return null
    try {
        const binary = atob(base64)
        const out = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) {
            out[i] = binary.charCodeAt(i)
        }
        return out
    } catch {
        return null
    }
}

export function formatDimensionHint(
    originalWidth: number,
    originalHeight: number,
    width: number,
    height: number,
): string {
    const scale = originalWidth / width
    return `[Image: original ${originalWidth}x${originalHeight}, displayed at ${width}x${height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`
}

/**
 * Browser image processor using createImageBitmap + canvas.
 * No resize → keep original mime/data. Resize → PNG (or JPEG when source is JPEG).
 */
export function createBrowserImageProcessor(
    options: BrowserImageProcessorOptions = {},
): ImageProcessor {
    const maxWidth = options.maxWidth ?? DEFAULT_MAX_EDGE
    const maxHeight = options.maxHeight ?? DEFAULT_MAX_EDGE
    const autoResize = options.autoResize ?? true
    const createImageBitmapFn =
        options.createImageBitmap ??
        ((blob: Blob) => createImageBitmap(blob) as Promise<ImageBitmap>)
    const createCanvasFn = options.createCanvas ?? defaultCreateCanvas
    const blobToBase64Fn = options.blobToBase64 ?? defaultBlobToBase64

    return {
        async process(bytes, mimeType): Promise<ImageProcessResult> {
            let bitmap: ImageBitmap | undefined
            try {
                const blob = new Blob([bytesToArrayBuffer(bytes)], { type: mimeType })
                bitmap = await createImageBitmapFn(blob)
                const originalWidth = bitmap.width
                const originalHeight = bitmap.height
                if (
                    !Number.isFinite(originalWidth) ||
                    !Number.isFinite(originalHeight) ||
                    originalWidth <= 0 ||
                    originalHeight <= 0
                ) {
                    bitmap.close()
                    bitmap = undefined
                    return {
                        ok: false,
                        message: '[Image omitted: invalid dimensions]',
                    }
                }

                // No-resize path still probes dimensions and always closes the bitmap.
                if (!autoResize) {
                    bitmap.close()
                    bitmap = undefined
                    return {
                        ok: true,
                        data: bytesToBase64(bytes),
                        mimeType,
                        hints: [],
                        wasResized: false,
                        originalWidth,
                        originalHeight,
                        width: originalWidth,
                        height: originalHeight,
                    }
                }

                const fitted = fitWithin(originalWidth, originalHeight, maxWidth, maxHeight)

                if (!fitted.wasResized) {
                    bitmap.close()
                    bitmap = undefined
                    return {
                        ok: true,
                        data: bytesToBase64(bytes),
                        mimeType,
                        hints: [],
                        wasResized: false,
                        originalWidth,
                        originalHeight,
                        width: originalWidth,
                        height: originalHeight,
                    }
                }

                // Never canvas-resize GIF: that would flatten animation into a static PNG/JPEG.
                if (mimeType === 'image/gif') {
                    bitmap.close()
                    bitmap = undefined
                    return {
                        ok: true,
                        data: bytesToBase64(bytes),
                        mimeType,
                        hints: ['GIF resizing skipped to preserve animation'],
                        wasResized: false,
                        originalWidth,
                        originalHeight,
                        width: originalWidth,
                        height: originalHeight,
                    }
                }

                const canvas = createCanvasFn(fitted.width, fitted.height)
                const ctx = canvas.getContext('2d')
                if (!ctx) {
                    throw new Error('Canvas 2D context unavailable')
                }
                ctx.drawImage(bitmap, 0, 0, fitted.width, fitted.height)
                bitmap.close()
                bitmap = undefined

                const outputMime: SupportedImageMimeType | string =
                    mimeType === 'image/jpeg' || mimeType === 'image/jpg'
                        ? 'image/jpeg'
                        : 'image/png'
                const blobOut = await canvasToBlob(
                    canvas,
                    outputMime,
                    outputMime === 'image/jpeg' ? JPEG_QUALITY : undefined,
                )
                const data = await blobToBase64Fn(blobOut)
                return {
                    ok: true,
                    data,
                    mimeType: outputMime === 'image/jpg' ? 'image/jpeg' : outputMime,
                    hints: [
                        formatDimensionHint(
                            originalWidth,
                            originalHeight,
                            fitted.width,
                            fitted.height,
                        ),
                    ],
                    wasResized: true,
                    originalWidth,
                    originalHeight,
                    width: fitted.width,
                    height: fitted.height,
                }
            } catch (error) {
                if (bitmap) {
                    try {
                        bitmap.close()
                    } catch {
                        // ignore close failures during cleanup
                    }
                }
                const message =
                    error instanceof Error ? error.message : 'unknown image processing error'
                return {
                    ok: false,
                    message: `[Image omitted: ${message}]`,
                }
            }
        },
    }
}

async function canvasToBlob(
    canvas: CanvasLike,
    type: string,
    quality?: number,
): Promise<Blob> {
    if (typeof canvas.convertToBlob === 'function') {
        return canvas.convertToBlob({ type, quality })
    }
    if (typeof canvas.toBlob === 'function') {
        return new Promise<Blob>((resolve, reject) => {
            canvas.toBlob!(
                (blob) => {
                    if (!blob) {
                        reject(new Error('canvas.toBlob returned null'))
                        return
                    }
                    resolve(blob)
                },
                type,
                quality,
            )
        })
    }
    throw new Error('Canvas cannot export blob')
}

function defaultCreateCanvas(width: number, height: number): CanvasLike {
    if (typeof OffscreenCanvas !== 'undefined') {
        return new OffscreenCanvas(width, height) as unknown as CanvasLike
    }
    if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        return canvas as unknown as CanvasLike
    }
    throw new Error('No canvas implementation available')
}

async function defaultBlobToBase64(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer()
    return bytesToBase64(new Uint8Array(buffer))
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    // Copy into a standalone ArrayBuffer so Blob receives a clean buffer view.
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    return copy.buffer
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
    if (bytes.byteLength < prefix.length) {
        return false
    }
    return prefix.every((value, index) => bytes[index] === value)
}

function startsWithAscii(bytes: Uint8Array, offset: number, text: string): boolean {
    if (bytes.byteLength < offset + text.length) {
        return false
    }
    for (let index = 0; index < text.length; index += 1) {
        if (bytes[offset + index] !== text.charCodeAt(index)) {
            return false
        }
    }
    return true
}
