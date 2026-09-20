import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PluginCapabilityClient } from '@cpa/plugin-api'
import { createWallpaperStore, MAX_DATA_LENGTH, MAX_FILE_BYTES, normalizeWallpaper, OFF, validateDimensions, validateFile, validateSignature, WALLPAPER_KEY, wallpaperImage, wallpaperStore, importWallpaper } from './wallpaper.js'
import { WallpaperEffect, WallpaperSection } from './WallpaperSection.js'

vi.mock('@cpa/plugin-ui', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const makeClient = (invoke = vi.fn().mockResolvedValue(undefined)) => ({ invoke, has: () => true, subscribe: () => () => {} }) as PluginCapabilityClient

afterEach(() => { cleanup(); wallpaperStore.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('wallpaper validation', () => {
    it('defaults off and rejects URLs, paths, SVG, unknown presets and oversized data', () => {
        for (const value of [null, undefined, {}, { kind: 'builtin', id: '__proto__' }, { kind: 'builtin', id: 'unknown' }, ...['https://example.com/a.jpg', 'file:///tmp/a.jpg', 'data:image/svg+xml;base64,aaaa', 'data:image/jpeg;base64,/9j/' + 'a'.repeat(MAX_DATA_LENGTH)].map(data => ({ kind: 'custom', data }))]) expect(normalizeWallpaper(value)).toEqual(OFF)
        expect(normalizeWallpaper({ kind: 'builtin', id: 'ocean' })).toEqual({ kind: 'builtin', id: 'ocean' })
        expect(normalizeWallpaper({ kind: 'custom', data: 'data:image/jpeg;base64,/9j/aaaa' }).kind).toBe('custom')
        expect(wallpaperImage(OFF)).toBeUndefined()
        expect(wallpaperImage({ kind: 'builtin', id: 'ocean' })).toContain('var(--bg-app) 88%')
    })
    it('limits file type, size and decoded dimensions', () => {
        expect(MAX_FILE_BYTES).toBe(10 * 1024 * 1024)
        expect(() => validateFile({ type: 'image/png', size: MAX_FILE_BYTES })).not.toThrow()
        for (const file of [{ type: 'image/svg+xml', size: 5 }, { type: 'image/gif', size: 5 }, { type: 'image/jpeg', size: 0 }, { type: 'image/png', size: MAX_FILE_BYTES + 1 }]) expect(() => validateFile(file)).toThrow()
        for (const [w, h] of [[0, 10], [8193, 1], [6000, 5000], [NaN, 10]]) expect(() => validateDimensions(w, h)).toThrow()
        expect(() => validateDimensions(6000, 4000)).not.toThrow()
    })
    it('rejects disguised SVG and accepts raster signatures only', () => {
        expect(() => validateSignature(new Uint8Array([60, 115, 118, 103]), 'image/png')).toThrow()
        expect(() => validateSignature(new Uint8Array([255, 216, 255]), 'image/jpeg')).not.toThrow()
        expect(() => validateSignature(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png')).not.toThrow()
        expect(() => validateSignature(new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]), 'image/webp')).not.toThrow()
    })
    it('resizes and re-encodes imported raster pixels, stripping the original payload', async () => {
        const revoke = vi.fn()
        vi.stubGlobal('URL', { createObjectURL: () => 'blob:local', revokeObjectURL: revoke })
        vi.stubGlobal('Image', class {
            naturalWidth = 4000
            naturalHeight = 2000
            onload = () => {}
            set src(_value: string) { this.onload() }
        })
        const drawImage = vi.fn()
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
        const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,/9j/aaaa')
        const file = { size: 100, type: 'image/jpeg', slice: () => ({ arrayBuffer: async () => new Uint8Array([255, 216, 255]).buffer }) } as File
        expect(await importWallpaper(file)).toEqual({ kind: 'custom', data: 'data:image/jpeg;base64,/9j/aaaa' })
        expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1920, 960)
        expect(encode).toHaveBeenCalledWith('image/jpeg', 0.8)
        expect(revoke).toHaveBeenCalledWith('blob:local')
        encode.mockReturnValue('data:image/jpeg;base64,/9j/' + 'a'.repeat(MAX_DATA_LENGTH))
        await expect(importWallpaper(file)).rejects.toThrow()
        expect(revoke).toHaveBeenCalledTimes(2)
    })
    it('releases temporary URLs when decoding fails', async () => {
        const revoke = vi.fn()
        vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL: revoke })
        vi.stubGlobal('Image', class { onerror = () => {}; set src(_value: string) { this.onerror() } })
        const file = { size: 3, type: 'image/jpeg', slice: () => ({ arrayBuffer: async () => new Uint8Array([255, 216, 255]).buffer }) } as File
        await expect(importWallpaper(file)).rejects.toThrow()
        expect(revoke).toHaveBeenCalledWith('blob:test')
    })
})

describe('wallpaper persistence', () => {
    it('loads, saves custom images, resets and handles failure without replacing the current choice', async () => {
        const invoke = vi.fn().mockResolvedValue({ kind: 'builtin', id: 'aurora' })
        const store = createWallpaperStore()
        await store.initialize(makeClient(invoke))
        expect(invoke).toHaveBeenCalledWith('kvstore:get', [WALLPAPER_KEY])
        expect(store.getSnapshot().value).toEqual({ kind: 'builtin', id: 'aurora' })
        const custom = { kind: 'custom', data: 'data:image/jpeg;base64,/9j/aaaa' } as const
        await store.set(custom)
        expect(invoke).toHaveBeenLastCalledWith('kvstore:set', [WALLPAPER_KEY, custom])
        invoke.mockRejectedValueOnce(new Error('offline'))
        await store.set(OFF)
        expect(store.getSnapshot()).toMatchObject({ value: custom, error: true, busy: false })
        await store.set(OFF)
        expect(store.getSnapshot().value).toEqual(OFF)
    })
    it('ignores stale loads after disposal and permits retry after a failed load', async () => {
        let resolve!: (v: unknown) => void
        const store = createWallpaperStore()
        const pending = store.initialize(makeClient(vi.fn(() => new Promise(r => { resolve = r }))))
        store.dispose()
        resolve({ kind: 'builtin', id: 'ocean' })
        await pending
        expect(store.getSnapshot().value).toEqual(OFF)
        await store.initialize(makeClient(vi.fn().mockRejectedValue(new Error('offline'))))
        expect(store.getSnapshot()).toMatchObject({ ready: true, error: true })
    })
    it('serializes user changes while a save is pending', async () => {
        const invoke = vi.fn().mockResolvedValue(undefined)
        const store = createWallpaperStore()
        await store.initialize(makeClient(invoke))
        let resolve!: () => void
        invoke.mockImplementationOnce(() => new Promise<void>(r => { resolve = r }))
        const save = store.set({ kind: 'builtin', id: 'dunes' })
        await store.set(OFF)
        expect(invoke).toHaveBeenCalledTimes(2)
        resolve(); await save
        expect(store.getSnapshot().value).toEqual({ kind: 'builtin', id: 'dunes' })
    })
})

describe('wallpaper UI and lifecycle', () => {
    it('selects a preset, resets, and cleans up the global presentation on unmount', async () => {
        await wallpaperStore.initialize(makeClient())
        const view = render(<><WallpaperEffect /><WallpaperSection /></>)
        const preset = screen.getByRole('button', { name: 'settings.appearance.wallpaper.ocean' })
        fireEvent.click(preset)
        await waitFor(() => expect(preset.getAttribute('aria-pressed')).toBe('true'))
        expect(document.documentElement.style.getPropertyValue('--app-background-image')).toContain('linear-gradient')
        fireEvent.click(screen.getByRole('button', { name: 'settings.appearance.wallpaper.reset' }))
        await waitFor(() => expect(document.documentElement.style.getPropertyValue('--app-background-image')).toBe(''))
        await act(async () => { await wallpaperStore.set({ kind: 'builtin', id: 'aurora' }) })
        view.unmount()
        expect(document.documentElement.style.getPropertyValue('--app-background-image')).toBe('')
    })
    it('shows storage errors and retains the previous selection', async () => {
        const invoke = vi.fn().mockResolvedValue(undefined)
        await wallpaperStore.initialize(makeClient(invoke))
        render(<WallpaperSection />)
        invoke.mockRejectedValueOnce(new Error('disk full'))
        fireEvent.click(screen.getByRole('button', { name: 'settings.appearance.wallpaper.ocean' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('settings.appearance.wallpaper.saveError')
        expect(screen.getByRole('button', { name: 'settings.appearance.wallpaper.off' })).toHaveAttribute('aria-pressed', 'true')
    })
})
