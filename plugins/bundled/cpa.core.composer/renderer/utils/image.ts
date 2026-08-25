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
        return {
            width: Math.round(width),
            height: Math.round(height),
            scale: 1,
            wasResized: false,
        }
    }

    const scale = Math.min(maxWidth / width, maxHeight / height)
    const targetWidth = Math.max(1, Math.round(width * scale))
    const targetHeight = Math.max(1, Math.round(height * scale))

    return {
        width: targetWidth,
        height: targetHeight,
        scale,
        wasResized: true,
    }
}

export function detectImageMimeType(
    bytes: Uint8Array,
    declaredMimeType?: string,
): SupportedImageMimeType | null {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'image/jpeg'
    }

    if (
        bytes.length >= PNG_SIGNATURE.length &&
        PNG_SIGNATURE.every((expected, index) => bytes[index] === expected)
    ) {
        return 'image/png'
    }

    if (
        bytes.length >= 6 &&
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38 &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) &&
        bytes[5] === 0x61
    ) {
        return 'image/gif'
    }

    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    ) {
        return 'image/webp'
    }

    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
        return 'image/bmp'
    }

    if (declaredMimeType) {
        const lower = declaredMimeType.toLowerCase().trim()
        if (
            lower === 'image/jpeg' ||
            lower === 'image/jpg' ||
            lower === 'image/png' ||
            lower === 'image/gif' ||
            lower === 'image/webp' ||
            lower === 'image/bmp'
        ) {
            return (lower === 'image/jpg' ? 'image/jpeg' : lower) as SupportedImageMimeType
        }
    }

    return null
}

export function bytesToBase64(bytes: Uint8Array): string {
    let binary = ''
    const len = bytes.byteLength
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
}

export function base64ToBytes(base64: string): Uint8Array {
    const raw = atob(base64)
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) {
        bytes[i] = raw.charCodeAt(i)
    }
    return bytes
}

export function createBrowserImageProcessor(
    options: BrowserImageProcessorOptions = {},
): ImageProcessor {
    const maxWidth = options.maxWidth ?? DEFAULT_MAX_EDGE
    const maxHeight = options.maxHeight ?? DEFAULT_MAX_EDGE
    const autoResize = options.autoResize ?? true

    return {
        async process(bytes: Uint8Array, declaredMime: string): Promise<ImageProcessResult> {
            const detected = detectImageMimeType(bytes, declaredMime)
            if (!detected) {
                return {
                    ok: false,
                    message: `Unsupported or invalid image format: "${declaredMime}"`,
                }
            }

            const rawBase64 = bytesToBase64(bytes)

            try {
                const blob = new Blob([bytes as BlobPart], { type: detected })
                const loader =
                    options.createImageBitmap ??
                    (typeof createImageBitmap === 'function' ? createImageBitmap : null)

                if (!loader) {
                    return {
                        ok: true,
                        data: rawBase64,
                        mimeType: detected,
                        hints: [],
                        wasResized: false,
                    }
                }

                const bitmap = await loader(blob)
                const origWidth = bitmap.width
                const origHeight = bitmap.height

                const fit = fitWithin(origWidth, origHeight, maxWidth, maxHeight)

                if (!fit.wasResized || !autoResize) {
                    bitmap.close()
                    return {
                        ok: true,
                        data: rawBase64,
                        mimeType: detected,
                        hints: [],
                        wasResized: false,
                        originalWidth: origWidth,
                        originalHeight: origHeight,
                        width: origWidth,
                        height: origHeight,
                    }
                }

                // Resize via canvas
                let canvas: CanvasLike | null = null
                if (options.createCanvas) {
                    canvas = options.createCanvas(fit.width, fit.height)
                } else if (typeof document !== 'undefined') {
                    const el = document.createElement('canvas')
                    el.width = fit.width
                    el.height = fit.height
                    canvas = el
                }

                if (!canvas) {
                    bitmap.close()
                    return {
                        ok: true,
                        data: rawBase64,
                        mimeType: detected,
                        hints: [],
                        wasResized: false,
                        originalWidth: origWidth,
                        originalHeight: origHeight,
                        width: origWidth,
                        height: origHeight,
                    }
                }

                const ctx = canvas.getContext('2d')
                if (!ctx) {
                    bitmap.close()
                    return {
                        ok: true,
                        data: rawBase64,
                        mimeType: detected,
                        hints: [],
                        wasResized: false,
                        originalWidth: origWidth,
                        originalHeight: origHeight,
                        width: origWidth,
                        height: origHeight,
                    }
                }

                ctx.drawImage(bitmap, 0, 0, fit.width, fit.height)
                bitmap.close()

                let outputBlob: Blob | null = null
                if (canvas.convertToBlob) {
                    outputBlob = await canvas.convertToBlob({
                        type: 'image/jpeg',
                        quality: JPEG_QUALITY,
                    })
                } else if (canvas.toBlob) {
                    outputBlob = await new Promise<Blob | null>((resolve) => {
                        canvas!.toBlob!(
                            (res) => resolve(res),
                            'image/jpeg',
                            JPEG_QUALITY,
                        )
                    })
                }

                if (!outputBlob) {
                    return {
                        ok: true,
                        data: rawBase64,
                        mimeType: detected,
                        hints: [],
                        wasResized: false,
                        originalWidth: origWidth,
                        originalHeight: origHeight,
                        width: origWidth,
                        height: origHeight,
                    }
                }

                const buffer = await outputBlob.arrayBuffer()
                const resizedBytes = new Uint8Array(buffer)
                const resizedBase64 = bytesToBase64(resizedBytes)

                return {
                    ok: true,
                    data: resizedBase64,
                    mimeType: 'image/jpeg',
                    hints: [`Resized from ${origWidth}x${origHeight} to ${fit.width}x${fit.height}`],
                    wasResized: true,
                    originalWidth: origWidth,
                    originalHeight: origHeight,
                    width: fit.width,
                    height: fit.height,
                }
            } catch (err: any) {
                return {
                    ok: true,
                    data: rawBase64,
                    mimeType: detected,
                    hints: [],
                    wasResized: false,
                }
            }
        },
    }
}
