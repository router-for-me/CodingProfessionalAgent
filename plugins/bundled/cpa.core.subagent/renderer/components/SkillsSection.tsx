import { useCallback, useEffect, useMemo, useState } from 'react'
import {
    Folder,
    Search,
} from 'lucide-react'
import {
    cn,
    CustomSelect,
    SettingsCard,
    SettingsRow,
    SettingsSection,
    useHostServices,
    useTranslation,
} from '@cpa/plugin-ui'
import type {
    SkillItemMode,
    SkillMode,
    SkillsSettings,
    SkillTrigger,
} from '@cpa/plugin-api'
import { DEFAULT_SKILLS_SETTINGS, getAppConfigDirName } from '@cpa/plugin-api'

export interface SkillItem {
    name: string
    description: string
    filePath: string
    baseDir: string
    disableModelInvocation?: boolean
    body?: string
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, any>; body: string } {
    if (!raw.startsWith('---')) {
        return { frontmatter: {}, body: raw }
    }
    const end = raw.indexOf('\n---', 3)
    if (end === -1) {
        return { frontmatter: {}, body: raw }
    }
    const yaml = raw.slice(3, end).trim()
    const body = raw.slice(end + 4).replace(/^\r?\n/, '')
    const frontmatter: Record<string, any> = {}

    for (const line of yaml.split(/\r?\n/)) {
        const colon = line.indexOf(':')
        if (colon !== -1) {
            const key = line.slice(0, colon).trim()
            let val: any = line.slice(colon + 1).trim()
            if (val === 'true') val = true
            else if (val === 'false') val = false
            else if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
            else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1)
            frontmatter[key] = val
        }
    }

    return { frontmatter, body }
}

function base64ToUtf8(base64: string): string {
    try {
        const bin = atob(base64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) {
            bytes[i] = bin.charCodeAt(i)
        }
        return new TextDecoder('utf-8').decode(bytes)
    } catch {
        return ''
    }
}

interface SkillSettingRowProps {
    skill: SkillItem
    configuredMode: SkillItemMode
    last?: boolean
    onChangeMode: (mode: SkillItemMode) => void
}

function SkillSettingRow({
    skill,
    configuredMode,
    last = false,
    onChangeMode,
}: SkillSettingRowProps) {
    const { t } = useTranslation()

    const modeOptions = useMemo(
        () => [
            {
                value: 'default' as SkillItemMode,
                label: t('settings.skills.mode.default', '全局设置'),
            },
            {
                value: 'auto' as SkillItemMode,
                label: t('settings.skills.mode.auto', '自动注册'),
            },
            {
                value: 'explicit' as SkillItemMode,
                label: t('settings.skills.mode.explicit', '显性使用'),
            },
            {
                value: 'disabled' as SkillItemMode,
                label: t('settings.skills.mode.disabled', '禁用'),
            },
        ],
        [t],
    )

    return (
        <div
            className={cn(
                'flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3.5 transition-colors',
                !last && 'border-b border-[var(--border-subtle)]',
            )}
        >
            <div className="flex-1 min-w-0 pr-2">
                <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-[var(--text-primary)]">
                        {skill.name}
                    </span>
                    {configuredMode !== 'default' && (
                        <span
                            className={cn(
                                'text-[11px] px-1.5 py-0.5 rounded-full font-medium',
                                configuredMode === 'disabled'
                                    ? 'bg-red-500/10 text-red-500 dark:text-red-400'
                                    : configuredMode === 'explicit'
                                      ? 'bg-amber-500/10 text-amber-500 dark:text-amber-400'
                                      : 'bg-emerald-500/10 text-emerald-500 dark:text-emerald-400',
                            )}
                        >
                            {configuredMode === 'disabled'
                                ? t('settings.skills.mode.disabled', '禁用')
                                : configuredMode === 'explicit'
                                  ? t('settings.skills.mode.explicit', '显性使用')
                                  : t('settings.skills.mode.auto', '自动注册')}
                        </span>
                    )}
                </div>

                {skill.description ? (
                    <p className="mt-1 text-[12px] text-[var(--text-secondary)] leading-relaxed">
                        {skill.description}
                    </p>
                ) : null}

                <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)] font-mono">
                    <Folder className="size-3 shrink-0 opacity-70" aria-hidden />
                    <span className="truncate select-text" title={skill.baseDir || skill.filePath}>
                        {skill.baseDir || skill.filePath}
                    </span>
                </div>
            </div>

            <div className="shrink-0 self-start sm:self-center">
                <CustomSelect<SkillItemMode>
                    value={configuredMode}
                    onChange={onChangeMode}
                    ariaLabel={t('settings.skills.selectModeForSkill', {
                        defaultValue: `为 ${skill.name} 选择使用模式`,
                        name: skill.name,
                    })}
                    options={modeOptions}
                />
            </div>
        </div>
    )
}

export function SkillsSection() {
    const { t } = useTranslation()
    const services = useHostServices()

    const [settingsSnapshot, setSettingsSnapshot] = useState(() =>
        services?.settings?.getSnapshot?.() ?? ({} as any),
    )
    const [searchQuery, setSearchQuery] = useState('')
    const [skills, setSkills] = useState<readonly SkillItem[]>(() => {
        const available = services?.skillUsage?.getAvailableSkills?.()
        return Array.isArray(available) ? available : []
    })

    // Subscribe to settings changes
    useEffect(() => {
        if (!services?.settings?.subscribe) return
        return services.settings.subscribe((next) => {
            setSettingsSnapshot(next ?? ({} as any))
        })
    }, [services?.settings])

    // Subscribe to available skills catalog changes
    useEffect(() => {
        if (!services?.skillUsage?.subscribeAvailableSkills) return
        return services.skillUsage.subscribeAvailableSkills(() => {
            const available = services.skillUsage?.getAvailableSkills?.()
            if (Array.isArray(available)) {
                setSkills(available)
            }
        })
    }, [services?.skillUsage])

    // Active skills discovery fallback if catalog is initially empty
    useEffect(() => {
        let cancelled = false
        const fs = services?.fileSystem
        if (!fs) return

        void (async () => {
            try {
                const runtimeInfo = await fs.getRuntimeInfo?.().catch?.(() => null)
                const homeDir = runtimeInfo?.homeDir
                const userConfigDir = runtimeInfo?.userConfigDir
                const discovered: SkillItem[] = []
                const seen = new Set<string>()

                const scanDir = async (dir: string) => {
                    try {
                        const entries = await fs.readDir?.(dir)
                        if (!entries || !Array.isArray(entries)) return
                        for (const entry of entries) {
                            if (entry.isDirectory) {
                                const skillMdPath = `${entry.path}/SKILL.md`
                                try {
                                    const file =
                                        (await fs.readFileIfExists?.(skillMdPath)) ??
                                        (await fs.readFile(skillMdPath).catch(() => null))
                                    if (file && file.dataBase64) {
                                        const content = base64ToUtf8(file.dataBase64)
                                        const { frontmatter } = parseFrontmatter(content)
                                        const name = (frontmatter.name || entry.name).toLowerCase()
                                        if (!seen.has(name)) {
                                            seen.add(name)
                                            discovered.push({
                                                name: frontmatter.name || entry.name,
                                                description: frontmatter.description || '',
                                                filePath: skillMdPath,
                                                baseDir: entry.path,
                                                disableModelInvocation: Boolean(
                                                    frontmatter['disable-model-invocation'],
                                                ),
                                            })
                                        }
                                    }
                                } catch {
                                    // Skip invalid skill file
                                }
                            }
                        }
                    } catch {
                        // Directory does not exist, ignore
                    }
                }

                if (userConfigDir) {
                    await scanDir(`${userConfigDir}/coding-professional-agent/agent/skills`)
                }
                if (homeDir) {
                    const configDirName =
                        (runtimeInfo as any)?.appConfigDirName ||
                        getAppConfigDirName((runtimeInfo as any)?.isDebug)
                    await scanDir(`${homeDir}/${configDirName}/skills`)
                }

                const projects = services?.projects?.getSnapshot?.() ?? []
                const currentSessionId = services?.sessions?.getCurrentSessionId?.() ?? null
                const sessions = services?.sessions?.getSnapshot?.() ?? []
                const session = sessions.find((item: any) => item.id === currentSessionId)
                const projectId = session?.projectId
                const project = projects.find((item: any) => item.id === projectId)
                const cwd = project ? project.paths?.[0] || project.path : undefined
                if (cwd) {
                    await scanDir(`${cwd}/.cpa/skills`)
                }

                if (!cancelled && discovered.length > 0) {
                    setSkills((prev) => {
                        if (prev.length >= discovered.length) return prev
                        return discovered
                    })
                    services?.skillUsage?.setAvailableSkills?.(discovered)
                }
            } catch {
                // Ignore scan failure
            }
        })()

        return () => {
            cancelled = true
        }
    }, [services])

    const skillsSettings: SkillsSettings =
        settingsSnapshot.skills ?? DEFAULT_SKILLS_SETTINGS

    const defaultMode: SkillMode = skillsSettings.defaultMode ?? 'auto'

    const updateSkillsSettings = useCallback(
        (updater: (prev: SkillsSettings) => SkillsSettings) => {
            const current = settingsSnapshot.skills ?? DEFAULT_SKILLS_SETTINGS
            const next = updater(current)
            if (services?.settings?.setSkillsSettings) {
                services.settings.setSkillsSettings(next)
            } else if (services?.settings?.update) {
                void services.settings.update({ skills: next } as any)
            }
        },
        [services?.settings, settingsSnapshot.skills],
    )

    const handleDefaultModeChange = useCallback(
        (mode: SkillMode) => {
            updateSkillsSettings((prev) => ({
                ...prev,
                defaultMode: mode,
            }))
        },
        [updateSkillsSettings],
    )

    const handleSkillModeChange = useCallback(
        (skillName: string, mode: SkillItemMode) => {
            updateSkillsSettings((prev) => {
                const nextSkills = { ...(prev.skills ?? {}) }
                if (mode === 'default') {
                    delete nextSkills[skillName]
                } else {
                    nextSkills[skillName] = mode
                }
                return {
                    ...prev,
                    skills: nextSkills,
                }
            })
        },
        [updateSkillsSettings],
    )

    const filteredSkills = useMemo(() => {
        const query = searchQuery.trim().toLowerCase()
        if (!query) return skills
        return skills.filter(
            (skill) =>
                skill.name.toLowerCase().includes(query) ||
                (skill.description && skill.description.toLowerCase().includes(query)) ||
                (skill.baseDir && skill.baseDir.toLowerCase().includes(query)) ||
                (skill.filePath && skill.filePath.toLowerCase().includes(query)),
        )
    }, [skills, searchQuery])

    return (
        <div className="mx-auto w-full max-w-[760px] space-y-6 px-8 pt-8 pb-12">
            <div>
                <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)] font-[inherit]">
                    {t('settings.skills.title', '技能')}
                </h1>
                <p className="mt-1 text-[13px] text-[var(--text-muted)] font-[inherit]">
                    {t(
                        'settings.skills.subtitle',
                        '配置技能的默认调用模式与独立技能的注册与展开策略。',
                    )}
                </p>
            </div>

            {/* 1. Basic Settings: Default Mode */}
            <SettingsSection title={t('settings.skills.basicSection', '基础设置')}>
                <SettingsCard>
                    <SettingsRow
                        id="skillDefaultMode"
                        title={t('settings.skills.defaultMode', '默认使用模式')}
                        description={t(
                            'settings.skills.defaultModeDesc',
                            '未单独设置模式的技能将默认应用此模式。',
                        )}
                        control={
                            <CustomSelect<SkillMode>
                                value={defaultMode}
                                onChange={handleDefaultModeChange}
                                ariaLabel={t('settings.skills.defaultMode', '默认使用模式')}
                                options={[
                                    {
                                        value: 'auto',
                                        label: t('settings.skills.mode.auto', '自动注册'),
                                    },
                                    {
                                        value: 'explicit',
                                        label: t('settings.skills.mode.explicit', '显性使用'),
                                    },
                                    {
                                        value: 'disabled',
                                        label: t('settings.skills.mode.disabled', '禁用'),
                                    },
                                ]}
                            />
                        }
                    />
                    <SettingsRow
                        id="skillTrigger"
                        title={t('settings.skills.trigger', '技能触发快捷键')}
                        description={t('settings.skills.triggerDesc', '输入所选符号以查找技能。')}
                        control={
                            <CustomSelect<SkillTrigger>
                                value={skillsSettings.trigger ?? '$'}
                                onChange={(trigger) => updateSkillsSettings((prev) => ({ ...prev, trigger }))}
                                ariaLabel={t('settings.skills.trigger', '技能触发快捷键')}
                                options={['$', '#', '/'].map((trigger) => ({
                                    value: trigger as SkillTrigger,
                                    label: trigger,
                                }))}
                            />
                        }
                        last
                    />
                </SettingsCard>
            </SettingsSection>

            {/* 2. Skills List with Search */}
            <SettingsSection title={t('settings.skills.listSection', '技能列表')}>
                <div className="mb-2">
                    <label className="relative block">
                        <Search
                            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--text-muted)]"
                            aria-hidden
                        />
                        <input
                            type="search"
                            value={searchQuery}
                            placeholder={t(
                                'settings.skills.searchPlaceholder',
                                '搜索技能名称、描述或目录...',
                            )}
                            aria-label={t(
                                'settings.skills.searchPlaceholder',
                                '搜索技能名称、描述或目录...',
                            )}
                            className={cn(
                                'w-full rounded-lg border border-[var(--border-subtle)]',
                                'bg-[var(--bg-card)] py-1.5 pl-8 pr-3 text-[12px]',
                                'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                                'outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/30',
                            )}
                            onChange={(e) => setSearchQuery(e.target.value)}
                        />
                    </label>
                </div>

                <SettingsCard>
                    {filteredSkills.length > 0 ? (
                        filteredSkills.map((skill, index) => {
                            const configuredMode =
                                skillsSettings.skills?.[skill.name] ?? 'default'
                            const isLast = index === filteredSkills.length - 1
                            return (
                                <SkillSettingRow
                                    key={skill.name}
                                    skill={skill}
                                    configuredMode={configuredMode}
                                    last={isLast}
                                    onChangeMode={(mode) =>
                                        handleSkillModeChange(skill.name, mode)
                                    }
                                />
                            )
                        })
                    ) : (
                        <div className="px-3.5 py-6 text-center text-[12px] text-[var(--text-muted)]">
                            {searchQuery.trim()
                                ? t('settings.skills.emptySearch', '未找到匹配的技能')
                                : t('settings.skills.emptyList', '暂无可用的技能')}
                        </div>
                    )}
                </SettingsCard>
            </SettingsSection>
        </div>
    )
}
