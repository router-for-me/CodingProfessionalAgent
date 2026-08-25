import { useCallback, useEffect, useMemo, useState } from 'react'
import {
    cn,
    ToggleSwitch,
    useHostServices,
    useTranslation,
} from '@cpa/plugin-ui'
import {
    deleteLocalMemory,
    type LocalMemoriesBackendOptions,
} from '../../agent/localMemoriesBackend.js'

export interface MemorySettingsSectionProps {
    backendOptions?: LocalMemoriesBackendOptions
}

/**
 * MemorySettingsSection provides controls to enable/disable local memory,
 * configure tool-assisted memory extraction, and delete local memories.
 */
export function MemorySettingsSection({ backendOptions }: MemorySettingsSectionProps = {}) {
    const { t } = useTranslation()
    const services = useHostServices()

    const [settingsSnapshot, setSettingsSnapshot] = useState(() =>
        services?.settings?.getSnapshot?.() ?? ({} as any),
    )

    useEffect(() => {
        if (!services?.settings?.subscribe) return
        const unsubscribe = services.settings.subscribe(() => {
            setSettingsSnapshot(services.settings.getSnapshot?.() ?? ({} as any))
        })
        return unsubscribe
    }, [services?.settings])

    const localMemoryEnabled = settingsSnapshot.localMemoryEnabled ?? true
    const toolAssistedMemoryEnabled = settingsSnapshot.toolAssistedMemoryEnabled ?? false

    const setLocalMemoryEnabled = useCallback(
        (enabled: boolean) => {
            services?.settings?.update?.({ localMemoryEnabled: enabled })
        },
        [services?.settings],
    )

    const setToolAssistedMemoryEnabled = useCallback(
        (enabled: boolean) => {
            services?.settings?.update?.({ toolAssistedMemoryEnabled: enabled })
        },
        [services?.settings],
    )

    const [deleting, setDeleting] = useState(false)

    const adaptedBridge = useMemo(() => {
        const fileSystemService = services?.fileSystem
        if (!fileSystemService) return undefined
        return {
            RuntimeInfo: () =>
                fileSystemService.getRuntimeInfo
                    ? fileSystemService.getRuntimeInfo()
                    : Promise.resolve({ homeDir: '/home/user', platform: 'darwin' }),
            ReadFile: (p: string) => fileSystemService.readFile(p),
            ReadFileIfExists: (p: string) =>
                fileSystemService.readFileIfExists
                    ? fileSystemService.readFileIfExists(p)
                    : Promise.resolve(null),
            WriteFile: (p: string, d: string) => fileSystemService.writeFile(p, d),
            MkdirAll: (p: string) =>
                fileSystemService.mkdirAll ? fileSystemService.mkdirAll(p) : Promise.resolve(),
            Stat: (p: string) =>
                fileSystemService.stat ? fileSystemService.stat(p) : Promise.resolve(null as any),
            ReadDir: async (p: string) => {
                if (!fileSystemService.readDir) return []
                const list = await fileSystemService.readDir(p)
                return (list || []).map((e) => ({ name: e.name, isDir: e.isDirectory }))
            },
        }
    }, [services?.fileSystem])

    const pushToast = useCallback(
        (msg: string) => {
            if (services?.notifications?.show) {
                services.notifications.show({ title: msg, message: msg, type: 'info' })
            }
        },
        [services?.notifications],
    )

    const handleDeleteMemory = useCallback(async () => {
        setDeleting(true)
        try {
            await deleteLocalMemory({
                bridge: backendOptions?.bridge ?? adaptedBridge,
                ...backendOptions,
            })
            pushToast(t('settings.personalization.memoryDeleted', { defaultValue: 'Local memory deleted' }))
        } catch {
            pushToast(
                t('settings.personalization.deleteMemoryFailed', {
                    defaultValue: 'Failed to delete local memory',
                }),
            )
        } finally {
            setDeleting(false)
        }
    }, [backendOptions, adaptedBridge, pushToast, t])

    const learnMore = useCallback(() => {
        pushToast(t('toast.comingSoon', { defaultValue: 'Coming soon' }))
    }, [pushToast, t])

    return (
        <section className="space-y-2">
            <div>
                <h2 className="text-[14px] font-medium text-[var(--text-primary)]">
                    {t('settings.personalization.memory', { defaultValue: 'Memory' })}
                </h2>
                <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-muted)]">
                    {t('settings.personalization.memory.desc', {
                        defaultValue: 'Create memories based on chats and personalize future chats.',
                    })}{' '}
                    <button
                        type="button"
                        className="text-[var(--accent-blue)] hover:underline cursor-pointer"
                        onClick={learnMore}
                    >
                        {t('settings.personalization.learnMore', { defaultValue: 'Learn more' })}
                    </button>
                </p>
            </div>

            <div className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)]">
                {/* Row 1: Enable local memory */}
                <div className="flex items-center justify-between px-4 py-3">
                    <div className="min-w-0 flex-1 pr-4">
                        <div className="text-[13px] font-medium text-[var(--text-primary)]">
                            {t('settings.personalization.enableLocalMemory', {
                                defaultValue: 'Enable local memory',
                            })}
                        </div>
                        <div className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-muted)]">
                            {t('settings.personalization.enableLocalMemory.desc', {
                                defaultValue: 'Create memories based on chats on this machine and personalize future chats',
                            })}
                        </div>
                    </div>
                    <ToggleSwitch
                        checked={localMemoryEnabled}
                        label={t('settings.personalization.enableLocalMemory', {
                            defaultValue: 'Enable local memory',
                        })}
                        onChange={setLocalMemoryEnabled}
                    />
                </div>

                {/* Row 2: Tool-assisted memory */}
                <div className="flex items-center justify-between px-4 py-3">
                    <div className="min-w-0 flex-1 pr-4">
                        <div className="text-[13px] font-medium text-[var(--text-primary)]">
                            {t('settings.personalization.toolAssistedMemory', {
                                defaultValue: 'Tool-assisted memory',
                            })}
                        </div>
                        <div className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-muted)]">
                            {t('settings.personalization.toolAssistedMemory.desc', {
                                defaultValue: 'Allow agent to search and add ad-hoc memory notes during tasks',
                            })}
                        </div>
                    </div>
                    <ToggleSwitch
                        checked={toolAssistedMemoryEnabled}
                        label={t('settings.personalization.toolAssistedMemory', {
                            defaultValue: 'Tool-assisted memory',
                        })}
                        onChange={setToolAssistedMemoryEnabled}
                    />
                </div>

                {/* Row 3: Delete local memory */}
                <div className="flex items-center justify-between px-4 py-3">
                    <div className="min-w-0 flex-1 pr-4">
                        <div className="text-[13px] font-medium text-[var(--text-primary)]">
                            {t('settings.personalization.deleteLocalMemory', {
                                defaultValue: 'Delete local memory',
                            })}
                        </div>
                        <div className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-muted)]">
                            {t('settings.personalization.deleteLocalMemory.desc', {
                                defaultValue: 'Delete all memories stored locally on this machine',
                            })}
                        </div>
                    </div>
                    <button
                        type="button"
                        disabled={deleting}
                        className={cn(
                            'rounded-md bg-red-500/10 px-3 py-1 text-[13px] font-medium',
                            'text-red-400 transition-colors hover:bg-red-500/20 cursor-pointer disabled:opacity-50',
                        )}
                        onClick={handleDeleteMemory}
                    >
                        {deleting
                            ? t('settings.personalization.deleting', { defaultValue: 'Deleting...' })
                            : t('settings.personalization.delete', { defaultValue: 'Delete' })}
                    </button>
                </div>
            </div>
        </section>
    )
}
