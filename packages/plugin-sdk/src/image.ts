/**
 * Neutral image processing utilities for agent tools.
 */

export interface ProcessedImage {
    mediaType: string
    base64Data: string
    originalBytes?: number
    resizedBytes?: number
}

export type ImageProcessResult =
    | {
          ok: true
          data: string
          mimeType: string
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
    processImage?(bytes: Uint8Array, mimeType: string): Promise<ProcessedImage>
}

/**
 * Creates a browser-compatible image processor that passes through base64.
 */
export function createBrowserImageProcessor(): ImageProcessor {
    return {
        async process(bytes: Uint8Array, mimeType: string): Promise<ImageProcessResult> {
            let binary = ''
            const chunkSize = 0x8000
            for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
                const slice = bytes.subarray(offset, offset + chunkSize)
                binary += String.fromCharCode(...slice)
            }
            return {
                ok: true,
                data: btoa(binary),
                mimeType,
                hints: [],
                wasResized: false,
            }
        },
        async processImage(bytes: Uint8Array, mimeType: string): Promise<ProcessedImage> {
            let binary = ''
            const chunkSize = 0x8000
            for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
                const slice = bytes.subarray(offset, offset + chunkSize)
                binary += String.fromCharCode(...slice)
            }
            const base64Data = btoa(binary)
            return {
                mediaType: mimeType,
                base64Data,
                originalBytes: bytes.byteLength,
                resizedBytes: bytes.byteLength,
            }
        },
    }
}
