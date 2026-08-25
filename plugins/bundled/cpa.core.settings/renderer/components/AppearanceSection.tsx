import { useMemo, useState } from 'react'
import {
    CustomSelect,
    cn,
    useHostService,
    useSettings,
    useTranslation,
} from '@cpa/plugin-ui'
import {
    SettingsServiceToken,
    UiServiceToken,
    type AppSettings,
    type ThemeMode,
} from '@cpa/plugin-api'
import {
    CODE_FONT_FAMILIES,
    FONT_WEIGHT_OPTIONS,
    UI_FONT_FAMILIES,
    getThemePresets,
    useResolvedTheme,
} from '../utils/theme.js'
import { ColorPickerPill } from './ColorPickerPill.js'
import { SettingsPixelInput, ToggleSwitch } from './SettingsControls.js'
import { ThemeImportDialog } from './ThemeImportDialog.js'

const THEME_OPTIONS: { id: ThemeMode; labelKey: string }[] = [
    { id: 'system', labelKey: 'settings.appearance.theme.system' },
    { id: 'light', labelKey: 'settings.appearance.theme.light' },
    { id: 'dark', labelKey: 'settings.appearance.theme.dark' },
]

export function AppearanceSection() {
    const { t } = useTranslation()
    const uiService = useHostService(UiServiceToken)
    const settingsService = useHostService(SettingsServiceToken)
    const settings = useSettings()

    // Settings from store
    const theme = settings.theme ?? 'dark'
    const themePreset = settings.themePreset ?? 'codex'
    const accentColor = settings.accentColor ?? '#339CFF'
    const backgroundColor = settings.backgroundColor ?? '#181818'
    const foregroundColor = settings.foregroundColor ?? '#FFFFFF'
    const uiFontFamily = settings.uiFontFamily ?? 'system'
    const uiFontWeight = settings.uiFontWeight ?? 'normal'
    const codeFontFamily = settings.codeFontFamily ?? 'system'
    const codeFontWeight = settings.codeFontWeight ?? 'normal'
    const contrast = settings.contrast ?? 60
    const uiFontSize = settings.uiFontSize ?? 14
    const codeFontSize = settings.codeFontSize ?? 12
    const fontSmoothing = settings.fontSmoothing ?? true

    // Actions
    const setTheme = (val: ThemeMode) => settingsService?.setTheme?.(val)
    const setThemePreset = (val: string) => settingsService?.setThemePreset?.(val)
    const setAccentColor = (val: string) => settingsService?.setAccentColor?.(val)
    const setBackgroundColor = (val: string) => settingsService?.setBackgroundColor?.(val)
    const setForegroundColor = (val: string) => settingsService?.setForegroundColor?.(val)
    const setUiFontFamily = (val: string) => settingsService?.setUiFontFamily?.(val)
    const setUiFontWeight = (val: string) => settingsService?.setUiFontWeight?.(val)
    const setCodeFontFamily = (val: string) => settingsService?.setCodeFontFamily?.(val)
    const setCodeFontWeight = (val: string) => settingsService?.setCodeFontWeight?.(val)
    const setContrast = (val: number) => settingsService?.setContrast?.(val)
    const setUiFontSize = (val: number) => settingsService?.setUiFontSize?.(val)
    const setCodeFontSize = (val: number) => settingsService?.setCodeFontSize?.(val)
    const setFontSmoothing = (val: boolean) => settingsService?.setFontSmoothing?.(val)

    const pushToast = (msg: string) => uiService?.pushToast(msg)

    const [importDialogOpen, setImportDialogOpen] = useState(false)

    // Determine active resolved theme (light vs dark)
    const resolvedTheme = useResolvedTheme(theme)
    const isLight = resolvedTheme === 'light'

    const currentPresets = useMemo(() => getThemePresets(!isLight), [isLight])

    const presetOptions = useMemo(
        () =>
            currentPresets.map((p) => ({
                value: p.id,
                label: p.label,
            })),
        [currentPresets],
    )

    const uiFontOptions = useMemo(
        () =>
            UI_FONT_FAMILIES.map((item) => ({
                value: item.value,
                label:
                    item.value === 'system'
                        ? t('settings.appearance.fontFamily.system')
                        : item.labelKey,
            })),
        [t],
    )

    const codeFontOptions = useMemo(
        () =>
            CODE_FONT_FAMILIES.map((item) => ({
                value: item.value,
                label:
                    item.value === 'system'
                        ? t('settings.appearance.fontFamily.system')
                        : item.labelKey,
            })),
        [t],
    )

    const fontWeightOptions = useMemo(
        () =>
            FONT_WEIGHT_OPTIONS.map((item) => ({
                value: item.value,
                label: t(item.labelKey),
            })),
        [t],
    )

    const handleThemeChange = (nextTheme: ThemeMode) => {
        setTheme(nextTheme)
        const nextIsLight =
            nextTheme === 'light' ||
            (nextTheme === 'system' &&
                typeof window !== 'undefined' &&
                window.matchMedia?.('(prefers-color-scheme: light)')?.matches)

        if (nextIsLight) {
            if (backgroundColor === '#181818' || backgroundColor === '#0e0e0e') {
                setBackgroundColor('#FFFFFF')
            }
            if (foregroundColor === '#FFFFFF' || foregroundColor === '#ECECEC') {
                setForegroundColor('#1A1C1F')
            }
            if (contrast === 60) {
                setContrast(45)
            }
        } else {
            if (backgroundColor === '#FFFFFF' || backgroundColor === '#fafafa') {
                setBackgroundColor('#181818')
            }
            if (foregroundColor === '#1A1C1F' || foregroundColor === '#171717') {
                setForegroundColor('#FFFFFF')
            }
            if (contrast === 45) {
                setContrast(60)
            }
        }
    }

    const handlePresetChange = (presetId: string) => {
        setThemePreset(presetId)
        const preset = currentPresets.find((p) => p.id === presetId)
        if (preset) {
            setAccentColor(preset.accent)
            setBackgroundColor(preset.bg)
            setForegroundColor(preset.fg)
            setContrast(preset.contrast)
        }
    }

    const handleCopyTheme = async () => {
        const payload = {
            name: isLight ? 'Custom Light Theme' : 'Custom Dark Theme',
            theme,
            themePreset,
            accentColor,
            backgroundColor,
            foregroundColor,
            contrast,
            uiFontFamily,
            uiFontWeight,
            codeFontFamily,
            codeFontWeight,
        }
        try {
            if (uiService?.writeClipboard) {
                await uiService.writeClipboard(JSON.stringify(payload, null, 2))
            } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
                await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
            }
            pushToast(t('settings.appearance.copied'))
        } catch {
            pushToast(t('session.copyFailed'))
        }
    }

    const handleImportTheme = (config: Partial<AppSettings>) => {
        if (config.theme) setTheme(config.theme)
        if (config.themePreset) setThemePreset(config.themePreset)
        if (config.accentColor) setAccentColor(config.accentColor)
        if (config.backgroundColor) setBackgroundColor(config.backgroundColor)
        if (config.foregroundColor) setForegroundColor(config.foregroundColor)
        if (typeof config.contrast === 'number') setContrast(config.contrast)
        if (config.uiFontFamily) setUiFontFamily(config.uiFontFamily)
        if (config.uiFontWeight) setUiFontWeight(config.uiFontWeight)
        if (config.codeFontFamily) setCodeFontFamily(config.codeFontFamily)
        if (config.codeFontWeight) setCodeFontWeight(config.codeFontWeight)
        pushToast(t('settings.appearance.imported'))
    }

    return (
        <div className="mx-auto w-full max-w-[760px] space-y-6 px-8 pt-8 pb-12 select-none">
            {/* Title */}
            <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
                {t('settings.nav.appearance')}
            </h1>

            {/* Theme Section */}
            <section className="space-y-3">
                <div className="text-[13px] font-medium text-[var(--text-secondary)]">
                    {t('settings.appearance.theme')}
                </div>

                {/* 3 Theme Mode Cards */}
                <div
                    role="radiogroup"
                    aria-label={t('settings.appearance.theme')}
                    className="grid grid-cols-3 gap-4"
                >
                    {THEME_OPTIONS.map((option) => {
                        const isSelected = theme === option.id
                        return (
                            <div key={option.id} className="flex flex-col items-center">
                                <button
                                    type="button"
                                    role="radio"
                                    aria-checked={isSelected}
                                    aria-label={t(option.labelKey)}
                                    className={cn(
                                        'group relative h-[126px] w-full cursor-pointer overflow-hidden rounded-xl transition-all',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/50',
                                        isSelected
                                            ? isLight
                                                ? 'border-2 border-neutral-900 ring-1 ring-neutral-900/10 shadow-md'
                                                : 'border-2 border-white ring-1 ring-white/30 shadow-lg'
                                            : isLight
                                                ? 'border border-neutral-200 hover:border-neutral-400'
                                                : 'border border-white/10 hover:border-white/30',
                                    )}
                                    onClick={() => handleThemeChange(option.id)}
                                >
                                    {option.id === 'system' ? (
                                        /* System Split Card */
                                        <div className="relative flex h-full w-full">
                                            {/* Left Half (Light) */}
                                            <div className="h-full w-1/2 bg-[#e4e4e7]" />
                                            {/* Right Half (Dark) */}
                                            <div className="h-full w-1/2 bg-[#27272a]" />

                                            {/* Mock window centered and bottom-aligned */}
                                            <div className="absolute bottom-0 left-1/2 flex h-[80%] w-[82%] -translate-x-1/2 overflow-hidden rounded-t-lg border border-black/10 shadow-sm">
                                                {/* Mock window left (light) */}
                                                <div className="flex h-full w-1/2 flex-col gap-1.5 bg-[#f4f4f5] p-2">
                                                    <div className="h-1.5 w-10 rounded-full bg-neutral-300" />
                                                    <div className="mt-1 h-1 w-8 rounded-full bg-neutral-300" />
                                                    <div className="h-1 w-12 rounded-full bg-neutral-200" />
                                                    <div className="h-1 w-10 rounded-full bg-neutral-200" />
                                                </div>
                                                {/* Mock window right (dark) */}
                                                <div className="flex h-full w-1/2 flex-col gap-1.5 bg-[#18181b] p-2">
                                                    <div className="h-1.5 w-10 rounded-full bg-neutral-700" />
                                                    <div className="mt-1 h-1 w-8 rounded-full bg-neutral-700" />
                                                    <div className="h-1 w-12 rounded-full bg-neutral-800" />
                                                    <div className="h-1 w-10 rounded-full bg-neutral-800" />
                                                </div>
                                            </div>
                                        </div>
                                    ) : option.id === 'light' ? (
                                        /* Light Card */
                                        <div className="relative flex h-full w-full items-end justify-center bg-[#f4f4f5]">
                                            <div className="flex h-[80%] w-[82%] flex-col gap-1.5 rounded-t-lg border border-black/5 bg-white p-2.5 shadow-sm">
                                                <div className="mx-auto h-1.5 w-14 rounded-full bg-neutral-300" />
                                                <div className="mt-1 h-1.5 w-24 rounded-full bg-neutral-200" />
                                                <div className="h-1.5 w-32 rounded-full bg-neutral-200" />
                                                <div className="h-1.5 w-20 rounded-full bg-neutral-200" />
                                            </div>
                                        </div>
                                    ) : (
                                        /* Dark Card */
                                        <div className="relative flex h-full w-full items-end justify-center bg-[#27272a]">
                                            <div className="flex h-[80%] w-[82%] flex-col gap-1.5 rounded-t-lg border border-white/10 bg-[#18181b] p-2.5 shadow-sm">
                                                <div className="mx-auto h-1.5 w-14 rounded-full bg-neutral-700" />
                                                <div className="mt-1 h-1.5 w-24 rounded-full bg-neutral-800" />
                                                <div className="h-1.5 w-32 rounded-full bg-neutral-800" />
                                                <div className="h-1.5 w-20 rounded-full bg-neutral-800" />
                                            </div>
                                        </div>
                                    )}
                                </button>
                                <span
                                    className={cn(
                                        'mt-2 text-center text-[12.5px] transition-colors',
                                        isSelected
                                            ? 'font-medium text-[var(--text-primary)]'
                                            : 'text-[var(--text-secondary)]',
                                    )}
                                >
                                    {t(option.labelKey)}
                                </span>
                            </div>
                        )
                    })}
                </div>

                {/* Live Diff Code Preview Box */}
                <div
                    className={cn(
                        'mt-4 overflow-hidden rounded-xl border p-3.5 font-mono leading-[1.65] transition-colors',
                        isLight
                            ? 'border-neutral-200 bg-white text-neutral-800 shadow-sm'
                            : 'border-white/10 bg-[#121316] text-neutral-200',
                    )}
                    style={{ fontSize: 'var(--code-font-size, 12px)' }}
                >
                    <div className="grid grid-cols-2 gap-3">
                        {/* Left Column: Old/Delete diff */}
                        <div className="flex flex-col">
                            <div className="flex items-center px-1">
                                <span
                                    className={cn(
                                        'mr-2 w-4 select-none',
                                        isLight ? 'text-neutral-400' : 'text-neutral-600',
                                    )}
                                >
                                    1
                                </span>
                                <span>
                                    <span
                                        className={isLight ? 'text-purple-600' : 'text-purple-400'}
                                    >
                                        const
                                    </span>{' '}
                                    <span
                                        className={isLight ? 'text-amber-600' : 'text-amber-300'}
                                    >
                                        themePreview
                                    </span>
                                    <span
                                        className={isLight ? 'text-neutral-500' : 'text-neutral-400'}
                                    >
                                        :{' '}
                                    </span>
                                    <span
                                        className={isLight ? 'text-purple-600' : 'text-purple-400'}
                                    >
                                        ThemeConfig
                                    </span>
                                    <span
                                        className={isLight ? 'text-neutral-700' : 'text-neutral-400'}
                                    >
                                        {' '}
                                        = {'{'}
                                    </span>
                                </span>
                            </div>
                            <div
                                className={cn(
                                    'my-0.5 flex items-center rounded-r border-l-[3px] border-red-500 px-1 py-0.5',
                                    isLight ? 'bg-[#fee2e2]' : 'bg-[#3c1717]/60',
                                )}
                            >
                                <span
                                    className={cn(
                                        'mr-2 w-4 select-none',
                                        isLight ? 'text-red-400' : 'text-neutral-600',
                                    )}
                                >
                                    2
                                </span>
                                <span>
                                    <span
                                        className={isLight ? 'text-neutral-400' : 'text-neutral-500'}
                                    >
                                        &nbsp;&nbsp;
                                    </span>
                                    <span
                                        className={isLight ? 'text-amber-700' : 'text-orange-400'}
                                    >
                                        surface
                                    </span>
                                    <span
                                        className={isLight ? 'text-neutral-600' : 'text-neutral-400'}
                                    >
                                        :{' '}
                                    </span>
                                    <span
                                        className={isLight ? 'text-emerald-700' : 'text-emerald-400'}
                                    >
                                        "sidebar"
                                    </span>
                                    <span
                                        className={isLight ? 'text-neutral-600' : 'text-neutral-400'}
                                    >
                                        ,
                                    </span>
                                </span>
                            </div>
                            <div
                                className={cn(
                                    'my-0.5 flex items-center rounded-r border-l-[3px] border-red-500 px-1 py-0.5',
                                    isLight ? 'bg-[#fee2e2]' : 'bg-[#3c1717]/60',
                                )}
                            >
                                <span
                                    className={cn(
                                        'mr-2 w-4 select-none',
                                        isLight ? 'text-red-400' : 'text-neutral-600',
                                    )}
                                >
                                    3
                                </span>
                                <span>
                                    <span
                                        className={isLight ? 'text-neutral-400' : 'text-neutral-500'}
                                    >
                                        &nbsp;&nbsp;
                                    </span>
                                    <span
                                        className={isLight ? 'text-amber-700' : 'text-orange-400'}
                                    >
                                        accent
                                    </span>
                                    <span
                                        className={isLight ? 'text-neutral-600' : 'text-neutral-400'}
                                    >
                                        :{' '}
                                    </span>
                                    <span
                                        className={isLight ? 'text-emerald-700' : 'text-emerald-400'}
                                    >
                                        "#2563eb"
                                    </span>
                                    <span
                                        className={isLight ? 'text-neutral-600' : 'text-neutral-400'}
                                    >
                                        ,
                                    </span>
                                </span>
                            </div>
                            <div
                                className={cn(
                                    'my-0.5 flex items-center rounded-r border-l-[3px] border-red-500 px-1 py-0.5',
                                    isLight ? 'bg-[#fee2e2]' : 'bg-[#3c1717]/60',
                                )}
                            >
                                <span
                                    className={cn(
                                        'mr-2 w-4 select-none',
                                        isLight ? 'text-red-400' : 'text-neutral-600',
                                    )}
                                >
                                    4
                                </span>
                                <span>
                                    <span
                                        className={isLight ? 'text-neutral-400' : 'text-neutral-500'}
                                    >
                                        &nbsp;&nbsp;
                                    </span>
                                    <span
                                        className={isLight ? 'text-amber-700' : 'text-orange-400'}
                                    >
                                        contrast
                                    </span>
                                    <span
                                        className={isLight ? 'text-neutral-600' : 'text-neutral-400'}
                                    >
                                        :{' '}
                                    </span>
                                    <span
                                        className={isLight ? 'text-blue-600' : 'text-amber-300'}
                                    >
                                        42
                                    </span>
                                    <span
                                        className={isLight ? 'text-neutral-600' : 'text-neutral-400'}
                                    >
                                        ,
                                    </span>
                                </span>
                            </div>
                            <div className="flex items-center px-1">
                                <span
                                    className={cn(
                                        'mr-2 w-4 select-none',
                                        isLight ? 'text-neutral-400' : 'text-neutral-600',
                                    )}
                                >
                                    5
                                </span>
                                <span
                                    className={isLight ? 'text-neutral-700' : 'text-neutral-400'}
                                >
                                    {'}'};
                                </span>
                            </div>
                        </div>

                        {/* Right Column: New/Add diff */}
                        <div className="flex flex-col">
                            <div className="flex items-center px-1">
                                <span
                                    className={cn(
                                        'mr-2 w-4 select-none',
                                        isLight ? 'text-neutral-400' : 'text-neutral-600',
                                    )}
                                >
                                    1
                                </span>
                                <span>
                                    <span
                                        className={isLight ? 'text-purple-600' : 'text-purple-400'}
                                    >
                                        const
                                    </span>{' '}
                                    <span
                                        className={isLight ? 'text-amber-600' : 'text-amber-300'}
                                    >
                                        themePreview
                                    </span>
                                    <span
                                        className={isLight ? 'text-neutral-500' : 'text-neutral-400'}
                                    >
                                        :{' '}
                                    </span>
                                    <span
                                        className={isLight ? 'text-purple-600' : 'text-purple-400'}
                                    >
                                        ThemeConfig
                                    </span>
                                    <span
                                        className={isLight ? 'text-neutral-700' : 'text-neutral-400'}
                                    >
                                        {' '}
                                        = {'{'}
                                    </span>
                                </span>
                            </div>
                            <div
                                className={cn(
                                    'my-0.5 flex items-center rounded-l border-r-[3px] border-emerald-500 px-1 py-0.5',
                                    isLight ? 'bg-[#dcfce7]' : 'bg-[#153420]/60',
                                )}
                            >
                                <span
                                    className={cn(
                                        'mr-2 w-4 select-none',
                                        isLight ? 'text-emerald-600' : 'text-neutral-600',
                                    )}
                                >
                                    2
                                </span>
                                <span>
                                    <span
                                        className={isLight ? 'text-neutral-400' : 'text-neutral-500'}
                                    >
                                        &nbsp;&nbsp;
                                    </span>
                                    <span
                                        className={isLight ? 'text-amber-700' : 'text-orange-400'}
                                    >
                                        surface
                                    </span>
                                    <span
                                        className={isLight ? 'text-neutral-600' : 'text-neutral-400'}
                                    >
                                        :{' '}
                                    </span>
                                    <span
                                        className={isLight ? 'text-emerald-700' : 'text-emerald-400'}
                                    >
                                        "sidebar-elevated"
                                    </span>
                                    <span
                                        className={isLight ? 'text-neutral-600' : 'text-neutral-400'}
                                    >
                                        ,
                                    </span>
                                </span>
                            </div>
                            <div
                                className={cn(
                                    'my-0.5 flex items-center rounded-l border-r-[3px] border-emerald-500 px-1 py-0.5',
                                    isLight ? 'bg-[#dcfce7]' : 'bg-[#153420]/60',
                                )}
                            >
                                <span
                                    className={cn(
                                        'mr-2 w-4 select-none',
                                        isLight ? 'text-emerald-600' : 'text-neutral-600',
                                    )}
                                >
                                    3
                                </span>
                                <span>
                                    <span
                                        className={isLight ? 'text-neutral-400' : 'text-neutral-500'}
                                    >
                                        &nbsp;&nbsp;
                                    </span>
                                    <span
                                        className={isLight ? 'text-amber-700' : 'text-orange-400'}
                                    >
                                        accent
                                    </span>
                                    <span
                                        className={isLight ? 'text-neutral-600' : 'text-neutral-400'}
                                    >
                                        :{' '}
                                    </span>
                                    <span
                                        className={isLight ? 'text-emerald-700' : 'text-emerald-400'}
                                    >
                                        "{accentColor.toLowerCase()}"
                                    </span>
                                    <span
                                        className={isLight ? 'text-neutral-600' : 'text-neutral-400'}
                                    >
                                        ,
                                    </span>
                                </span>
                            </div>
                            <div
                                className={cn(
                                    'my-0.5 flex items-center rounded-l border-r-[3px] border-emerald-500 px-1 py-0.5',
                                    isLight ? 'bg-[#dcfce7]' : 'bg-[#153420]/60',
                                )}
                            >
                                <span
                                    className={cn(
                                        'mr-2 w-4 select-none',
                                        isLight ? 'text-emerald-600' : 'text-neutral-600',
                                    )}
                                >
                                    4
                                </span>
                                <span>
                                    <span
                                        className={isLight ? 'text-neutral-400' : 'text-neutral-500'}
                                    >
                                        &nbsp;&nbsp;
                                    </span>
                                    <span
                                        className={isLight ? 'text-amber-700' : 'text-orange-400'}
                                    >
                                        contrast
                                    </span>
                                    <span
                                        className={isLight ? 'text-neutral-600' : 'text-neutral-400'}
                                    >
                                        :{' '}
                                    </span>
                                    <span
                                        className={isLight ? 'text-blue-600' : 'text-amber-300'}
                                    >
                                        {contrast}
                                    </span>
                                    <span
                                        className={isLight ? 'text-neutral-600' : 'text-neutral-400'}
                                    >
                                        ,
                                    </span>
                                </span>
                            </div>
                            <div className="flex items-center px-1">
                                <span
                                    className={cn(
                                        'mr-2 w-4 select-none',
                                        isLight ? 'text-neutral-400' : 'text-neutral-600',
                                    )}
                                >
                                    5
                                </span>
                                <span
                                    className={isLight ? 'text-neutral-700' : 'text-neutral-400'}
                                >
                                    {'}'};
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Theme Settings Card */}
                <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)]">
                    {/* Card Header Row */}
                    <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
                        <span className="text-[13.5px] font-medium text-[var(--text-primary)]">
                            {isLight
                                ? t('settings.appearance.lightTheme')
                                : t('settings.appearance.darkTheme')}
                        </span>

                        <div className="flex items-center gap-3">
                            <button
                                type="button"
                                className="text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] cursor-pointer"
                                onClick={() => setImportDialogOpen(true)}
                            >
                                {t('settings.appearance.import')}
                            </button>
                            <button
                                type="button"
                                className="text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] cursor-pointer"
                                onClick={handleCopyTheme}
                            >
                                {t('settings.appearance.duplicate')}
                            </button>
                            <span
                                className={cn(
                                    'flex items-center justify-center rounded px-1.5 py-0.5 text-[11px] font-semibold transition-colors',
                                    isLight
                                        ? 'border border-neutral-300 bg-neutral-100 text-neutral-700'
                                        : 'border border-neutral-700 bg-neutral-800 text-neutral-300',
                                )}
                            >
                                Aa
                            </span>
                            <CustomSelect
                                value={themePreset}
                                options={presetOptions}
                                ariaLabel="Theme Preset"
                                triggerClassName="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] px-2.5 py-1 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-sidebar)]"
                                onChange={handlePresetChange}
                            />
                        </div>
                    </div>

                    {/* Card Settings Rows */}
                    <div className="divide-y divide-[var(--border-subtle)]">
                        {/* Accent color */}
                        <div className="flex items-center justify-between px-4 py-3">
                            <span className="text-[13px] text-[var(--text-primary)]">
                                {t('settings.appearance.accentColor')}
                            </span>
                            <ColorPickerPill
                                value={accentColor}
                                defaultColor="#339CFF"
                                ariaLabel={t('settings.appearance.accentColor')}
                                onChange={(val) => {
                                    setAccentColor(val)
                                    setThemePreset('custom')
                                }}
                            />
                        </div>

                        {/* Background color */}
                        <div className="flex items-center justify-between px-4 py-3">
                            <span className="text-[13px] text-[var(--text-primary)]">
                                {t('settings.appearance.background')}
                            </span>
                            <ColorPickerPill
                                value={backgroundColor}
                                defaultColor={isLight ? '#FFFFFF' : '#181818'}
                                ariaLabel={t('settings.appearance.background')}
                                onChange={(val) => {
                                    setBackgroundColor(val)
                                    setThemePreset('custom')
                                }}
                            />
                        </div>

                        {/* Foreground color */}
                        <div className="flex items-center justify-between px-4 py-3">
                            <span className="text-[13px] text-[var(--text-primary)]">
                                {t('settings.appearance.foreground')}
                            </span>
                            <ColorPickerPill
                                value={foregroundColor}
                                defaultColor={isLight ? '#1A1C1F' : '#FFFFFF'}
                                ariaLabel={t('settings.appearance.foreground')}
                                onChange={(val) => {
                                    setForegroundColor(val)
                                    setThemePreset('custom')
                                }}
                            />
                        </div>

                        {/* UI Font */}
                        <div className="flex items-center justify-between px-4 py-3">
                            <span className="text-[13px] text-[var(--text-primary)]">
                                {t('settings.appearance.uiFont')}
                            </span>
                            <div className="flex items-center gap-2">
                                <CustomSelect
                                    value={uiFontFamily}
                                    options={uiFontOptions}
                                    ariaLabel={t('settings.appearance.uiFont')}
                                    triggerClassName="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] px-2.5 py-1 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-sidebar)]"
                                    onChange={(val) => setUiFontFamily(val)}
                                />
                                <CustomSelect
                                    value={uiFontWeight}
                                    options={fontWeightOptions}
                                    ariaLabel="UI Font Weight"
                                    triggerClassName="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] px-2.5 py-1 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-sidebar)]"
                                    onChange={(val) => setUiFontWeight(val)}
                                />
                            </div>
                        </div>

                        {/* Code Font */}
                        <div className="flex items-center justify-between px-4 py-3">
                            <span className="text-[13px] text-[var(--text-primary)]">
                                {t('settings.appearance.codeFont')}
                            </span>
                            <div className="flex items-center gap-2">
                                <CustomSelect
                                    value={codeFontFamily}
                                    options={codeFontOptions}
                                    ariaLabel={t('settings.appearance.codeFont')}
                                    triggerClassName="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] px-2.5 py-1 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-sidebar)]"
                                    onChange={(val) => setCodeFontFamily(val)}
                                />
                                <CustomSelect
                                    value={codeFontWeight}
                                    options={fontWeightOptions}
                                    ariaLabel="Code Font Weight"
                                    triggerClassName="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] px-2.5 py-1 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-sidebar)]"
                                    onChange={(val) => setCodeFontWeight(val)}
                                />
                            </div>
                        </div>

                        {/* Contrast */}
                        <div className="flex items-center justify-between px-4 py-3">
                            <span className="text-[13px] text-[var(--text-primary)]">
                                {t('settings.appearance.contrast')}
                            </span>
                            <div className="flex items-center gap-3">
                                <div className="relative flex w-[140px] items-center">
                                    <input
                                        type="range"
                                        min={0}
                                        max={100}
                                        step={1}
                                        value={contrast}
                                        aria-label={t('settings.appearance.contrast')}
                                        className={cn(
                                            'h-1.5 w-full cursor-pointer appearance-none rounded-lg outline-none transition-colors',
                                            isLight ? 'bg-neutral-200' : 'bg-neutral-700',
                                            '[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none',
                                            '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-md',
                                            isLight
                                                ? '[&::-webkit-slider-thumb]:bg-neutral-900 [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-neutral-900'
                                                : '[&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-neutral-300',
                                        )}
                                        style={{
                                            background: `linear-gradient(to right, var(--accent-blue) 0%, var(--accent-blue) ${contrast}%, ${isLight ? '#e4e4e7' : '#3f3f46'} ${contrast}%, ${isLight ? '#e4e4e7' : '#3f3f46'} 100%)`,
                                        }}
                                        onChange={(e) => {
                                            setContrast(Number(e.target.value))
                                            setThemePreset('custom')
                                        }}
                                    />
                                </div>
                                <span className="w-6 text-right font-mono text-[12px] text-[var(--text-secondary)]">
                                    {contrast}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* Preferences Section */}
            <section className="space-y-3 pt-4">
                <div className="text-[13px] font-medium text-[var(--text-secondary)]">
                    {t('settings.appearance.preferences')}
                </div>

                <div className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)]">
                    {/* UI Font Size */}
                    <div className="flex items-center justify-between px-4 py-3">
                        <div>
                            <div className="text-[13px] font-medium text-[var(--text-primary)]">
                                {t('settings.appearance.uiFontSize')}
                            </div>
                            <div className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                                {t('settings.appearance.uiFontSize.desc')}
                            </div>
                        </div>
                        <SettingsPixelInput
                            value={uiFontSize}
                            min={10}
                            max={24}
                            ariaLabel={t('settings.appearance.uiFontSize')}
                            onChange={setUiFontSize}
                        />
                    </div>

                    {/* Code Font Size */}
                    <div className="flex items-center justify-between px-4 py-3">
                        <div>
                            <div className="text-[13px] font-medium text-[var(--text-primary)]">
                                {t('settings.appearance.codeFontSize')}
                            </div>
                            <div className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                                {t('settings.appearance.codeFontSize.desc')}
                            </div>
                        </div>
                        <SettingsPixelInput
                            value={codeFontSize}
                            min={9}
                            max={22}
                            ariaLabel={t('settings.appearance.codeFontSize')}
                            onChange={setCodeFontSize}
                        />
                    </div>

                    {/* Font Smoothing */}
                    <div className="flex items-center justify-between px-4 py-3">
                        <div>
                            <div className="text-[13px] font-medium text-[var(--text-primary)]">
                                {t('settings.appearance.fontSmoothing')}
                            </div>
                            <div className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                                {t('settings.appearance.fontSmoothing.desc')}
                            </div>
                        </div>
                        <ToggleSwitch
                            checked={fontSmoothing}
                            label={t('settings.appearance.fontSmoothing')}
                            onChange={setFontSmoothing}
                        />
                    </div>
                </div>
            </section>

            {/* Import dialog */}
            <ThemeImportDialog
                open={importDialogOpen}
                onClose={() => setImportDialogOpen(false)}
                onImport={handleImportTheme}
            />
        </div>
    )
}
