/**
 * Neutral image processing utilities for agent tools.
 */

export interface ProcessedImage {
    mediaType: string
    base64Data: string
    originalBytes?: number
    resizedBytes?: number
}

export interface ImageProcessor {
    processImage(bytes: Uint8Array, mimeType: string): Promise<ProcessedImage>
}

/**
 * Creates a browser-compatible image processor that passes through or converts base64.
 */
export function createBrowserImageProcessor(): ImageProcessor {
    return {
        async processImage(bytes: Uint8Array, mimeType: string): Promise<ProcessedImage> {
            let binary = ''
            const chunkSize = 0x8000
            for (let offset = 0; offset < bytes.length; offset += chunkSize) {
                const slice = bytes.subarray(offset, offset + chunkSize)
                binary += String.fromCharCode(...slice)
            }
            const base64Data = btoa(binary)
            return {
                mediaType: mimeType,
                base64Data,
                originalBytes: bytes.length,
                resizedBytes: bytes.length,
            }
        },
    }
}
