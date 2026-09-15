import { useEffect, useMemo, useState } from 'react'
import {
    CustomSelect,
    type CustomSelectOption,
    Plus,
    Trash2,
    cn,
    useHostServices,
    useTranslation,
} from '@cpa/plugin-ui'
import {
    DEFAULT_SUBAGENT_ROLES,
    type ModelCatalogEntry,
    type SubagentRole,
} from '@cpa/plugin-api'

export type { SubagentRole }

export const DEFAULT_FALLBACK_MODELS: CustomSelectOption<string>[] = [
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
    { value: 'gpt-5.5', label: 'GPT 5.5' },
    { value: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
    { value: 'grok-4.6', label: 'Grok 4.6' },
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
]

export function getDefaultSubagentRoles(_t?: any): SubagentRole[] {
    return DEFAULT_SUBAGENT_ROLES.map((role) => ({ ...role }))
}

export function getReasoningOptionsForModel(
    modelId: string,
    rawCatalogModels: readonly ModelCatalogEntry[],
    t: any,
): CustomSelectOption<string>[] {
    const defaultOption: CustomSelectOption<string> = {
        value: 'default',
        label: t('settings.subagents.roles.reasoningDefault', '由模型决定'),
    }

    const matchedModel = rawCatalogModels.find((m) => m.id === modelId)
    if (matchedModel) {
        if (!matchedModel.reasoningLevels || matchedModel.reasoningLevels.length === 0) {
            return [
                defaultOption,
                { value: 'off', label: t('composer.reasoning.off', '关闭') },
            ]
        }

        const mapped: CustomSelectOption<string>[] = matchedModel.reasoningLevels
            .filter((lvl) => lvl.id.trim().toLowerCase() !== 'ultra')
            .map((lvl) => {
                let label = lvl.fallbackLabel || lvl.id
                if (lvl.labelKey) {
                    const tr = t(lvl.labelKey)
                    if (tr && tr !== lvl.labelKey) label = tr
                } else {
                    const tr = t(`composer.reasoning.${lvl.id}`, lvl.id)
                    if (tr) label = tr
                }
                return {
                    value: lvl.id,
                    label,
                }
            })

        return [defaultOption, ...mapped]
    }

    // Standard fallback options if model details are not in catalog
    return [
        defaultOption,
        { value: 'off', label: t('composer.reasoning.off', '关闭') },
        { value: 'low', label: t('composer.reasoning.low', '低') },
        { value: 'medium', label: t('composer.reasoning.medium', '中') },
        { value: 'high', label: t('composer.reasoning.high', '高') },
        { value: 'xhigh', label: t('composer.reasoning.xhigh', '极高') },
    ]
}

interface SubagentRoleCardProps {
    role: SubagentRole
    modelOptions: CustomSelectOption<string>[]
    rawCatalogModels: readonly ModelCatalogEntry[]
    onUpdate: (patch: Partial<SubagentRole>) => void
    onDelete: () => void
}

function SubagentRoleCard({
    role,
    modelOptions,
    rawCatalogModels,
    onUpdate,
    onDelete,
}: SubagentRoleCardProps) {
    const { t } = useTranslation()

    const roleReasoningOptions = useMemo(() => {
        const opts = getReasoningOptionsForModel(role.modelId, rawCatalogModels, t)
        if (role.reasoningEffort && !opts.some((opt) => opt.value === role.reasoningEffort)) {
            opts.push({
                value: role.reasoningEffort,
                label: t(`composer.reasoning.${role.reasoningEffort}`, role.reasoningEffort),
            })
        }
        return opts
    }, [role.modelId, role.reasoningEffort, rawCatalogModels, t])

    const handleModelChange = (nextModelId: string) => {
        const nextReasoningOptions = getReasoningOptionsForModel(nextModelId, rawCatalogModels, t)
        const isValid = nextReasoningOptions.some((opt) => opt.value === role.reasoningEffort)
        const nextReasoningEffort = isValid ? role.reasoningEffort : 'default'

        onUpdate({
            modelId: nextModelId,
            reasoningEffort: nextReasoningEffort,
        })
    }

    return (
        <div
            data-testid={`role-card-${role.id}`}
            className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4 shadow-sm transition-all"
        >
            {/* Role Name and Delete Row (No Bot icon) */}
            <div className="flex items-center gap-2.5">
                <div className="min-w-0 flex-1">
                    <input
                        type="text"
                        value={role.name}
                        onChange={(e) => onUpdate({ name: e.target.value })}
                        placeholder={t(
                            'settings.subagents.roles.namePlaceholder',
                            '角色名称，如：代码审查员'
                        )}
                        aria-label={t('settings.subagents.roles.roleName', '角色名称')}
                        className={cn(
                            'w-full rounded-lg border border-[var(--border-subtle)]',
                            'bg-[var(--bg-sidebar-hover)] px-3 py-1.5 text-[13px] font-medium',
                            'text-[var(--text-primary)] font-[inherit]',
                            'outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40'
                        )}
                    />
                </div>
                <button
                    type="button"
                    onClick={onDelete}
                    aria-label={t('settings.subagents.roles.deleteRole', '删除角色')}
                    title={t('settings.subagents.roles.deleteRole', '删除角色')}
                    className={cn(
                        'flex size-8 shrink-0 items-center justify-center rounded-lg',
                        'text-[var(--text-muted)] hover:bg-rose-500/10 hover:text-rose-400',
                        'transition-colors outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30'
                    )}
                >
                    <Trash2 className="size-4" />
                </button>
            </div>

            {/* Role Prompt Row */}
            <div className="mt-3">
                <label className="mb-1 block text-[11px] font-medium text-[var(--text-muted)] font-[inherit]">
                    {t('settings.subagents.roles.prompt', '角色提示词')}
                </label>
                <textarea
                    rows={2}
                    value={role.description}
                    onChange={(e) => onUpdate({ description: e.target.value })}
                    placeholder={t(
                        'settings.subagents.roles.promptPlaceholder',
                        '输入该角色的专属提示词或任务指令...'
                    )}
                    aria-label={t(
                        'settings.subagents.roles.prompt',
                        '角色提示词'
                    )}
                    className={cn(
                        'w-full resize-none rounded-lg border border-[var(--border-subtle)]',
                        'bg-[var(--bg-sidebar-hover)] px-3 py-2 text-[12px] leading-relaxed',
                        'text-[var(--text-primary)] placeholder:text-[var(--text-muted)] font-[inherit]',
                        'outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40'
                    )}
                />
            </div>

            {/* Model and Reasoning Effort Row (Linked) */}
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                    <label className="mb-1 block text-[11px] font-medium text-[var(--text-muted)] font-[inherit]">
                        {t('settings.subagents.roles.model', '模型')}
                    </label>
                    <CustomSelect<string>
                        value={role.modelId}
                        options={modelOptions}
                        onChange={handleModelChange}
                        ariaLabel={t('settings.subagents.roles.model', '模型')}
                        searchable
                        searchPlaceholder={t('settings.subagents.roles.searchModel', '搜索模型...')}
                        fullWidth
                    />
                </div>
                <div>
                    <label className="mb-1 block text-[11px] font-medium text-[var(--text-muted)] font-[inherit]">
                        {t('settings.subagents.roles.reasoning', '思考量')}
                    </label>
                    <CustomSelect<string>
                        value={role.reasoningEffort}
                        options={roleReasoningOptions}
                        onChange={(val) => onUpdate({ reasoningEffort: val })}
                        ariaLabel={t(
                            'settings.subagents.roles.reasoning',
                            '思考量'
                        )}
                        fullWidth
                    />
                </div>
            </div>
        </div>
    )
}

export interface SubagentRolesSectionProps {
    roles: SubagentRole[]
    onChange: (roles: SubagentRole[]) => void
}

/**
 * Roles section for configuring subagent roles, their names, descriptions, models, and reasoning effort.
 */
export function SubagentRolesSection({ roles, onChange }: SubagentRolesSectionProps) {
    const { t } = useTranslation()
    const services = useHostServices()

    const [rawCatalogModels, setRawCatalogModels] = useState<readonly ModelCatalogEntry[]>(
        () => (services?.models?.getModels?.() ?? []) as readonly ModelCatalogEntry[]
    )

    useEffect(() => {
        if (!services?.models?.subscribe) return
        return services.models.subscribe(() => {
            const next = (services.models?.getModels?.() ?? []) as readonly ModelCatalogEntry[]
            setRawCatalogModels(next)
        })
    }, [services])

    // Build selectable model options from catalog or fallback models
    const modelOptions = useMemo<CustomSelectOption<string>[]>(() => {
        const list: CustomSelectOption<string>[] = []
        if (rawCatalogModels.length > 0) {
            for (const entry of rawCatalogModels) {
                if (entry && entry.id) {
                    list.push({
                        value: entry.id,
                        label: entry.label || entry.id,
                    })
                }
            }
        } else {
            list.push(...DEFAULT_FALLBACK_MODELS)
        }

        // Dynamically append any modelId used by current roles if missing
        for (const role of roles) {
            if (role.modelId && !list.some((opt) => opt.value === role.modelId)) {
                list.push({ value: role.modelId, label: role.modelId })
            }
        }
        return list
    }, [rawCatalogModels, roles])

    const handleAddRole = () => {
        const defaultModelId = modelOptions[0]?.value || 'gpt-5.5'
        const newRole: SubagentRole = {
            id: `role-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: '',
            description: '',
            modelId: defaultModelId,
            reasoningEffort: 'default',
        }
        onChange([...roles, newRole])
    }

    const handleDeleteRole = (id: string) => {
        onChange(roles.filter((r) => r.id !== id))
    }

    const handleUpdateRole = (id: string, patch: Partial<SubagentRole>) => {
        onChange(
            roles.map((r) => {
                if (r.id !== id) return r
                return { ...r, ...patch }
            })
        )
    }

    return (
        <div className="flex flex-col space-y-3 pt-2" data-testid="subagent-roles-section">
            {/* Header */}
            <div className="flex items-center justify-between px-0.5">
                <div>
                    <h2 className="text-[14px] font-semibold text-[var(--text-primary)] font-[inherit]">
                        {t('settings.subagents.roles.title', '子智能体角色')}
                    </h2>
                    <p className="mt-0.5 text-[12px] text-[var(--text-muted)] font-[inherit]">
                        {t(
                            'settings.subagents.roles.subtitle',
                            '配置子智能体的预设角色、角色提示词、选用模型与思考深度。'
                        )}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={handleAddRole}
                    aria-label={t('settings.subagents.roles.addRole', '添加角色')}
                    className={cn(
                        'inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)]',
                        'bg-[var(--bg-card)] hover:bg-[var(--bg-sidebar-hover)] px-3 py-1.5',
                        'text-[12px] font-medium text-[var(--text-primary)] font-[inherit]',
                        'transition-colors shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40'
                    )}
                >
                    <Plus className="size-3.5" />
                    <span>{t('settings.subagents.roles.addRole', '添加角色')}</span>
                </button>
            </div>

            {/* Empty State */}
            {roles.length === 0 ? (
                <div
                    className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--border-subtle)] bg-[var(--bg-card)]/50 py-10 px-4 text-center"
                    data-testid="roles-empty-state"
                >
                    <p className="text-[13px] font-medium text-[var(--text-primary)] font-[inherit]">
                        {t('settings.subagents.roles.emptyTitle', '暂无角色')}
                    </p>
                    <p className="mt-1 max-w-[340px] text-[12px] text-[var(--text-muted)] font-[inherit]">
                        {t(
                            'settings.subagents.roles.emptyDesc',
                            '为子智能体添加具有特定专业技能的角色，定义专属模型与思考深度。'
                        )}
                    </p>
                </div>
            ) : (
                <div className="space-y-3" data-testid="roles-list">
                    {roles.map((role) => (
                        <SubagentRoleCard
                            key={role.id}
                            role={role}
                            modelOptions={modelOptions}
                            rawCatalogModels={rawCatalogModels}
                            onUpdate={(patch) => handleUpdateRole(role.id, patch)}
                            onDelete={() => handleDeleteRole(role.id)}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}
