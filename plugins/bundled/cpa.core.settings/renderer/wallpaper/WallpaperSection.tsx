import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from '@cpa/plugin-ui'
import { BUILTIN_WALLPAPERS, importWallpaper, OFF, wallpaperImage, wallpaperStore } from './wallpaper.js'

export function WallpaperEffect() {
    const { value } = useSyncExternalStore(wallpaperStore.subscribe, wallpaperStore.getSnapshot)
    useEffect(() => {
        const image = wallpaperImage(value)
        if (!image) return
        const style = document.documentElement.style
        const previous = style.getPropertyValue('--app-background-image')
        style.setProperty('--app-background-image', image)
        return () => {
            if (previous) style.setProperty('--app-background-image', previous)
            else style.removeProperty('--app-background-image')
        }
    }, [value])
    return null
}

export function WallpaperSection() {
    const { t } = useTranslation()
    const { value, ready, busy, error } = useSyncExternalStore(wallpaperStore.subscribe, wallpaperStore.getSnapshot)
    const input = useRef<HTMLInputElement>(null)
    const [importing, setImporting] = useState(false)
    const [invalid, setInvalid] = useState(false)
    const disabled = !ready || busy || importing
    const buttonClass = 'rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2 text-[var(--text-primary)] cursor-pointer hover:bg-[var(--bg-sidebar-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent-blue)] aria-pressed:border-[var(--accent-blue)] aria-pressed:ring-1 aria-pressed:ring-[var(--accent-blue)] disabled:opacity-50 disabled:cursor-default'
    return <section className="space-y-3" aria-labelledby="wallpaper-heading">
        <h2 id="wallpaper-heading" className="text-[var(--text-primary)]">{t('settings.appearance.wallpaper.title')}</h2>
        <p className="text-[var(--text-muted)]">{t('settings.appearance.wallpaper.description')}</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" role="group" aria-label={t('settings.appearance.wallpaper.title')}>
            <button type="button" className={buttonClass} disabled={disabled} aria-pressed={value.kind === 'off'} onClick={() => { setInvalid(false); void wallpaperStore.set(OFF) }}>
                <span className="mb-2 block h-16 rounded bg-[var(--bg-app)]" />
                {t('settings.appearance.wallpaper.off')}
            </button>
            {Object.entries(BUILTIN_WALLPAPERS).map(([id, image]) => <button key={id} type="button" className={buttonClass} disabled={disabled} aria-pressed={value.kind === 'builtin' && value.id === id}
                onClick={() => { setInvalid(false); void wallpaperStore.set({ kind: 'builtin', id: id as keyof typeof BUILTIN_WALLPAPERS }) }}>
                <span className="mb-2 block h-16 rounded" style={{ backgroundImage: image }} />
                {t(`settings.appearance.wallpaper.${id}`)}
            </button>)}
        </div>
        <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={buttonClass} disabled={disabled} aria-pressed={value.kind === 'custom'} onClick={() => input.current?.click()}>
                {t(`settings.appearance.wallpaper.${importing ? 'importing' : 'custom'}`)}
            </button>
            <button type="button" className={buttonClass} disabled={disabled || value.kind === 'off'} onClick={() => { setInvalid(false); void wallpaperStore.set(OFF) }}>{t('settings.appearance.wallpaper.reset')}</button>
            {value.kind === 'custom' && <img src={value.data} alt={t('settings.appearance.wallpaper.custom')} className="h-12 w-20 rounded object-cover" />}
        </div>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" aria-label={t('settings.appearance.wallpaper.custom')} disabled={disabled} onChange={async event => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (!file) return
            setImporting(true)
            setInvalid(false)
            try { await wallpaperStore.set(await importWallpaper(file)) }
            catch { setInvalid(true) }
            finally { setImporting(false) }
        }} />
        {(invalid || error) && <p role="alert" className="text-[var(--text-primary)]">{t(`settings.appearance.wallpaper.${invalid ? 'invalid' : 'saveError'}`)}</p>}
    </section>
}
