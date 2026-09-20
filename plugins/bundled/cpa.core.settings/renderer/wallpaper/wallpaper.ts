import type { PluginCapabilityClient } from '@cpa/plugin-api'

export const WALLPAPER_KEY = 'appearance.wallpaper'
export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_DATA_LENGTH = 1400000
export const BUILTIN_WALLPAPERS = {
    aurora: 'radial-gradient(ellipse at 20% 20%, #55d9bd, transparent 65%), linear-gradient(135deg, #263777, #9555a8)',
    dunes: 'radial-gradient(ellipse at 80% 90%, #b96855, transparent 65%), linear-gradient(145deg, #e7c797, #896188)',
    ocean: 'radial-gradient(ellipse at 75% 15%, #65cdd1, transparent 60%), linear-gradient(145deg, #25658a, #182e63)',
} as const
export type Wallpaper = { kind: 'off' } | { kind: 'builtin'; id: keyof typeof BUILTIN_WALLPAPERS } | { kind: 'custom'; data: string }
export const OFF: Wallpaper = { kind: 'off' }
export function normalizeWallpaper(value: unknown): Wallpaper {
    if (!value || typeof value !== 'object') return OFF
    const v = value as Record<string, unknown>
    if (v.kind === 'builtin' && typeof v.id === 'string' && Object.prototype.hasOwnProperty.call(BUILTIN_WALLPAPERS, v.id)) return { kind: 'builtin', id: v.id as keyof typeof BUILTIN_WALLPAPERS }
    if (v.kind === 'custom' && typeof v.data === 'string' && v.data.length <= MAX_DATA_LENGTH && /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]+={0,2}$/.test(v.data)) return { kind: 'custom', data: v.data }
    return OFF
}
export function wallpaperImage(value: Wallpaper): string | undefined {
    if (value.kind === 'off') return undefined
    const image = value.kind === 'builtin' ? BUILTIN_WALLPAPERS[value.id] : `url("${value.data}")`
    // Keep text contrast close to the chosen theme; elevated surfaces stay opaque.
    return `linear-gradient(color-mix(in srgb, var(--bg-app) 88%, transparent), color-mix(in srgb, var(--bg-app) 88%, transparent)), ${image}`
}
export function validateFile(file: Pick<File, 'size' | 'type'>): void {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size <= 0 || file.size > MAX_FILE_BYTES) throw new Error('invalid-image')
}
export function validateDimensions(width: number, height: number): void {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 8192 || height > 8192 || width * height > 24000000) throw new Error('invalid-image')
}
export function validateSignature(bytes: Uint8Array, type: string): void {
    const matches = (signature: number[], offset = 0) => signature.every((byte, i) => bytes[i + offset] === byte)
    const valid = type === 'image/png' ? matches([137, 80, 78, 71, 13, 10, 26, 10])
        : type === 'image/jpeg' ? matches([255, 216, 255])
        : type === 'image/webp' && matches([82, 73, 70, 70]) && matches([87, 69, 66, 80], 8)
    if (!valid) throw new Error('invalid-image')
}
export async function importWallpaper(file: File): Promise<Wallpaper> {
    validateFile(file)
    const header = new Uint8Array(await file.slice(0, 12).arrayBuffer())
    validateSignature(header, file.type)
    const url = URL.createObjectURL(file)
    try {
        const image = new Image()
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve()
            image.onerror = () => reject(new Error('invalid-image'))
            image.src = url
        })
        validateDimensions(image.naturalWidth, image.naturalHeight)
        const scale = Math.min(1, 1920 / Math.max(image.naturalWidth, image.naturalHeight))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('invalid-image')
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
        // Re-encode raster pixels only: no SVG, paths, external URLs, animation or metadata.
        const result = normalizeWallpaper({ kind: 'custom', data: canvas.toDataURL('image/jpeg', 0.8) })
        if (result.kind !== 'custom') throw new Error('invalid-image')
        return result
    } finally {
        URL.revokeObjectURL(url)
    }
}

export function createWallpaperStore() {
    let state = { value: OFF, ready: false, busy: false, error: false }
    let client: PluginCapabilityClient | null = null
    let generation = 0
    const listeners = new Set<() => void>()
    const update = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()) }
    return {
        getSnapshot: () => state,
        subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
        async initialize(next: PluginCapabilityClient) {
            client = next
            const current = ++generation
            update({ value: OFF, ready: false, busy: false, error: false })
            try {
                const value = await next.invoke('kvstore:get', [WALLPAPER_KEY])
                if (current === generation) update({ value: normalizeWallpaper(value), ready: true })
            } catch { if (current === generation) update({ ready: true, error: true }) }
        },
        async set(value: Wallpaper) {
            if (!client || !state.ready || state.busy) return
            const current = generation
            update({ busy: true, error: false })
            try {
                const normalized = normalizeWallpaper(value)
                await client.invoke('kvstore:set', [WALLPAPER_KEY, normalized])
                if (current === generation) update({ value: normalized })
            } catch { if (current === generation) update({ error: true }) }
            finally { if (current === generation) update({ busy: false }) }
        },
        dispose() { ++generation; client = null; update({ value: OFF, ready: false, busy: false, error: false }) },
    }
}
export const wallpaperStore = createWallpaperStore()
