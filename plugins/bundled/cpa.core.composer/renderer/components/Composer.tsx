import {
    Component,
    memo,
    useCallback,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type ChangeEvent,
    type ClipboardEvent,
    type ErrorInfo,
    type KeyboardEvent,
    type ReactNode,
} from 'react'
import {
    ArrowUp,
    buildSkillSuggestions,
    cn,
    createExtensibleComponent,
    ExtensionSlot,
    FileCode,
    FileText,
    Folder,
    getSkillQuery,
    insertSkillAtCaret,
    Play,
    SkillDraftEditor,
    SkillMenu,
    Square,
    useActiveRun,
    useDisplayMessages,
    useHostServices,
    useProjects,
    useSessions,
    useSettings,
    useSkillUsageCounts,
    useTranslation,
    useUiState,
    X,
    type SkillSuggestion,
} from '@cpa/plugin-ui'
import type {
    ComposerAttachment,
    ComposerImage,
    ComposerProps,
    ComposerRunStatus,
    ComposerSendPayload,
    DimensionProbe,
    ImageProcessor,
    ModelCatalogEntry,
    PromptTemplate,
    Skill,
    WorkLocation,
} from '../types.js'
import {
    base64ToBytes,
    createBrowserImageProcessor,
    detectImageMimeType,
    type SupportedImageMimeType,
} from '../utils/image.js'
import { expandPromptTemplate } from '../utils/promptTemplates.js'
import {
    filterCatalogModels,
    normalizeModelPreferences,
    sortModelsByName,
} from '../utils/modelMenuOptions.js'
import { FALLBACK_MODEL_CATALOG } from '../types.js'
import {
    buildSlashSuggestionsWithDiagnostics,
    getSlashQuery,
    sanitizeAriaId,
    SlashMenu,
    type SlashSuggestion,
} from './SlashMenu.js'
import { QuickModelPicker } from './QuickModelPicker.js'
import { isTurnCompleted } from '../utils/turnCompletion.js'
import {
    AttachMenu,
    ATTACH_MENU_ITEMS,
    type AttachMenuItemId,
} from './AttachMenu.js'
import { rendererEventBus } from '@/plugins/platform/eventBus'
import {
    useComposerControls,
    useAttachmentProviders,
    runSubmitPreprocessors,
} from '@/plugins/platform/contributions/composer'

/** Max raw File.size accepted before reading bytes (25 MiB). */
export const MAX_IMAGE_INPUT_BYTES = 25 * 1024 * 1024

interface ControlErrorBoundaryProps {
    id: string
    children: ReactNode
}

interface ControlErrorBoundaryState {
    hasError: boolean
}

class ControlErrorBoundary extends Component<
    ControlErrorBoundaryProps,
    ControlErrorBoundaryState
> {
    constructor(props: ControlErrorBoundaryProps) {
        super(props)
        this.state = { hasError: false }
    }

    static getDerivedStateFromError(): ControlErrorBoundaryState {
        return { hasError: true }
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error(`[ComposerControl] Error rendering control "${this.props.id}":`, error, info)
    }

    render() {
        if (this.state.hasError) {
            return null
        }
        return this.props.children
    }
}

export type ComposerAttachmentKind = 'image' | 'file' | 'folder'

export type {
    ComposerAttachment,
    ComposerImage,
    ComposerProps,
    ComposerRunStatus,
    ComposerSendPayload,
    DimensionProbe,
}

const ACCEPTED_MIME = new Set<SupportedImageMimeType>([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/bmp',
])

function isPdf(fileName: string): boolean {
    return /\.pdf$/i.test(fileName)
}

function isCodeFile(fileName: string): boolean {
    return /\.(tsx?|jsx?|py|go|rs|c|cpp|h|hpp|java|html|css|scss|sass|less|json|yaml|yml|toml|sh|bash|zsh|sql|graphql|vue|svelte|rb|php|swift|kt)$/i.test(
        fileName,
    )
}

function getFileExtLabel(fileName: string): string {
    const ext = fileName.split('.').pop()
    if (!ext || ext === fileName) return ''
    return ext.toUpperCase()
}

function getFileMimeOrExt(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase()
    if (ext === 'pdf') return 'application/pdf'
    if (ext === 'json') return 'application/json'
    if (ext === 'zip') return 'application/zip'
    if (ext === 'txt') return 'text/plain'
    if (ext === 'md') return 'text/markdown'
    return ext ? `text/${ext}` : 'application/octet-stream'
}

const TEXTAREA_MAX_HEIGHT = 160
const TERMINAL_RUN = new Set(['idle', 'done', 'error', 'aborted', ''])

function isRunActive(
    runStatus: ComposerRunStatus | undefined,
    isStreaming: boolean,
): boolean {
    if (isStreaming) return true
    if (!runStatus) return false
    return !TERMINAL_RUN.has(runStatus)
}

function getComposerDraftKey(sessionId?: string | null): string {
    return sessionId ? `session:${sessionId}` : 'new-chat'
}

function createId(): string {
    return Math.random().toString(36).slice(2, 11) + Date.now().toString(36)
}

/**
 * Dual-layer floating composer (project bar + input card).
 * Handles real image attachments, slash expansion, and run-time control locks.
 */
const BaseComposer = memo(function BaseComposer({
    sessionId: sessionIdProp,
    onSend,
    isStreaming = false,
    runStatus,
    onStop,
    onResume,
    canResume = false,
    isTurnComplete: isTurnCompleteProp,
    onCompact,
    skills = [],
    prompts = [],
    skillUsageCounts: skillUsageCountsProp,
    imageProcessor,
    dimensionProbe,
    supportsImages: supportsImagesProp,
    className,
}: ComposerProps) {
    const { t } = useTranslation()
    const reactId = useId()
    const ariaSuffix = sanitizeAriaId(reactId)
    const slashListboxId = `slash-menu-${ariaSuffix}`
    const skillListboxId = `skill-menu-${ariaSuffix}`

    const hostServices = useHostServices()
    const settings = useSettings()
    const sessions = useSessions()
    const projects = useProjects()

    const uiState = useUiState()
    const pendingSessionContext =
        uiState?.pendingSessionContext ??
        hostServices?.ui?.getPendingSessionContext?.() ?? {
            projectId: null,
            branch: null,
        }

    const setPendingSessionContext = (ctx: any) => {
        hostServices?.ui?.setPendingSessionContext?.(ctx)
    }

    const pushToast = (message: string, type?: any) => {
        hostServices?.ui?.pushToast?.(message, type)
    }

    const modelId = settings.modelId
    const modelSettings = settings.modelSettings

    const contextControls = useComposerControls('context')
    const toolbarLeftControls = useComposerControls('toolbar-left')
    const toolbarRightControls = useComposerControls('toolbar-right')
    const attachmentProviders = useAttachmentProviders()

    useEffect(() => {
        hostServices?.skillUsage?.fetchUsageCounts?.().catch(() => {})
    }, [hostServices])

    const catalogModels = (hostServices?.models?.getModels?.() ?? []) as ModelCatalogEntry[]
    const rawModels = catalogModels.length > 0 ? catalogModels : FALLBACK_MODEL_CATALOG
    const filteredModels = useMemo(
        () => filterCatalogModels(rawModels, modelSettings),
        [rawModels, modelSettings],
    )
    const models = filteredModels.length > 0 ? filteredModels : rawModels

    const storeSessionId = hostServices?.sessions?.getCurrentSessionId?.() ?? null
    const effectiveSessionId = sessionIdProp !== undefined ? sessionIdProp : storeSessionId

    const legacyDraft = uiState?.composerDraft ?? ''
    const composerDrafts = uiState?.composerDrafts ?? {}
    const composerDraftKey = getComposerDraftKey(effectiveSessionId)
    const initialComposerDraftKeyRef = useRef(composerDraftKey)
    const draft =
        composerDrafts[composerDraftKey] ??
        hostServices?.ui?.getComposerDraft?.(composerDraftKey) ??
        hostServices?.ui?.getComposerDraft?.(effectiveSessionId || 'new-chat') ??
        (initialComposerDraftKeyRef.current === composerDraftKey ? legacyDraft : '')

    const setComposerDraft = (nextDraft: string) => {
        hostServices?.ui?.setComposerDraft?.(composerDraftKey, nextDraft)
        if (effectiveSessionId) {
            hostServices?.ui?.setComposerDraft?.(effectiveSessionId, nextDraft)
        }
    }

    const activeRun = useActiveRun(effectiveSessionId ?? undefined)
    const isRemoteRunning = Boolean(effectiveSessionId && activeRun && activeRun.status !== 'idle')
    const isRunning = isRunActive(runStatus, isStreaming) || isRemoteRunning
    const displayMessages = useDisplayMessages(effectiveSessionId ?? '')
    const effectiveIsTurnComplete =
        isTurnCompleteProp ??
        isTurnCompleted(displayMessages, runStatus, isStreaming)

    const currentSession = useMemo(
        () => (effectiveSessionId ? sessions.find((s) => s.id === effectiveSessionId) ?? null : null),
        [sessions, effectiveSessionId],
    )

    const effectiveModelId = currentSession?.modelId ?? modelId
    const currentModel =
        models.find((model) => model.id === effectiveModelId) ?? models[0]
    const supportsImages =
        supportsImagesProp ??
        Boolean(currentModel?.input?.includes('image'))

    const worktreeSetup = effectiveSessionId
        ? hostServices?.chatMessages?.getWorktreeSetup?.(effectiveSessionId)
        : undefined
    const isSettingUpWorktree = Boolean(
        worktreeSetup &&
            (worktreeSetup.status === 'preparing' ||
                worktreeSetup.status === 'checking_out' ||
                worktreeSetup.status === 'setting_up'),
    )
    const isWorktreeError = Boolean(worktreeSetup && worktreeSetup.status === 'error')
    const isWorktreeBlocked = isSettingUpWorktree || isWorktreeError

    const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
    const images: ComposerImage[] = useMemo(
        () =>
            attachments
                .filter(
                    (
                        a,
                    ): a is ComposerAttachment & {
                        data: string
                        width: number
                        height: number
                        mimeType: string
                    } => a.kind === 'image' && Boolean(a.data),
                )
                .map((a) => ({
                    id: a.id,
                    name: a.name,
                    mimeType: a.mimeType || 'image/jpeg',
                    data: a.data || '',
                    width: a.width || 0,
                    height: a.height || 0,
                    kind: 'image',
                    path: a.path,
                })),
        [attachments],
    )
    const [imageError, setImageError] = useState<string | null>(null)
    const [sending, setSending] = useState(false)
    const [processingCount, setProcessingCount] = useState(0)
    const [slashActiveIndex, setSlashActiveIndex] = useState(0)
    const [slashOpen, setSlashOpen] = useState(true)
    const [skillActiveIndex, setSkillActiveIndex] = useState(0)
    const [skillOpen, setSkillOpen] = useState(true)
    const [attachMenuOpen, setAttachMenuOpen] = useState(false)
    const [attachMenuActiveIndex, setAttachMenuActiveIndex] = useState(0)
    const [quickModelPickerOpen, setQuickModelPickerOpen] = useState(false)
    const [modelPickerActiveIndex, setModelPickerActiveIndex] = useState(0)
    const [modelPickerQuery, setModelPickerQuery] = useState('')
    const [modelPickerCursor, setModelPickerCursor] = useState(0)
    const [draftCursor, setDraftCursor] = useState(draft.length)

    const workLocation: WorkLocation = currentSession
        ? (currentSession.workLocation ?? 'local')
        : (pendingSessionContext.workLocation ?? 'local')
    const environmentId = currentSession
        ? (currentSession.environmentId ?? null)
        : (pendingSessionContext.environmentId ?? null)

    const hasStartedSession = Boolean(effectiveSessionId && currentSession)
    const hasWorktreeOrEnvIssue = workLocation === 'worktree' && isWorktreeError
    const shouldHideContextBar = hasStartedSession && !hasWorktreeOrEnvIssue

    const handleWorkLocationChange = (nextLocation: WorkLocation) => {
        if (effectiveSessionId) {
            hostServices?.sessions?.setWorktree?.(effectiveSessionId, {
                status: currentSession?.worktreeSetup?.status ?? 'idle',
            })
            void hostServices?.sessions?.update?.(effectiveSessionId, {
                workLocation: nextLocation,
            })
        } else {
            setPendingSessionContext({
                ...pendingSessionContext,
                workLocation: nextLocation,
            })
        }
    }

    const handleEnvironmentChange = (nextEnvId: string | null) => {
        if (effectiveSessionId) {
            hostServices?.sessions?.update?.(effectiveSessionId, {
                environmentId: nextEnvId,
            })
        } else {
            setPendingSessionContext({
                ...pendingSessionContext,
                environmentId: nextEnvId,
            })
        }
    }

    const fileInputRef = useRef<HTMLInputElement>(null)
    const textareaRef = useRef<HTMLDivElement>(null)
    const composerCardRef = useRef<HTMLDivElement>(null)
    const mountedRef = useRef(true)
    const processChainRef = useRef(Promise.resolve())
    const processorRef = useRef<ImageProcessor>(
        imageProcessor ?? createBrowserImageProcessor(),
    )
    const dimensionProbeRef = useRef<DimensionProbe | undefined>(dimensionProbe)

    const slashFrozenRef = useRef<{
        skills: readonly Skill[]
        prompts: readonly PromptTemplate[]
    } | null>(null)
    const skillFrozenRef = useRef<readonly Skill[] | null>(null)
    const lastSlashDiagnosticsRef = useRef<string[]>([])
    const isRunningRef = useRef(isRunning)
    isRunningRef.current = isRunning

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
        }
    }, [])

    useEffect(() => {
        if (imageProcessor) processorRef.current = imageProcessor
    }, [imageProcessor])

    useEffect(() => {
        dimensionProbeRef.current = dimensionProbe
    }, [dimensionProbe])

    useEffect(() => {
        const unsub = rendererEventBus.on('composer:toggle-model-selector', () => {
            if (isRunningRef.current) return
            setModelPickerQuery('')
            setModelPickerCursor(0)
            setQuickModelPickerOpen((prev) => {
                const next = !prev
                if (next) {
                    setAttachMenuOpen(false)
                    setModelPickerActiveIndex(0)
                    setTimeout(() => {
                        textareaRef.current?.focus()
                    }, 0)
                }
                return next
            })
        })
        return () => {
            unsub()
        }
    }, [])

    useEffect(() => {
        if (isRunning && quickModelPickerOpen) {
            setQuickModelPickerOpen(false)
            setModelPickerQuery('')
            setModelPickerCursor(0)
        }
    }, [isRunning, quickModelPickerOpen])

    const focusInput = useCallback(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        try {
            const selection = window.getSelection()
            if (selection && el.childNodes.length > 0) {
                const range = document.createRange()
                range.selectNodeContents(el)
                range.collapse(false)
                selection.removeAllRanges()
                selection.addRange(range)
            }
        } catch {}
    }, [])

    useEffect(() => {
        const handleFocus = () => {
            focusInput()
            setTimeout(focusInput, 0)
            setTimeout(focusInput, 50)
        }
        const unsub = rendererEventBus.on('composer:focus', handleFocus)
        return () => {
            unsub()
        }
    }, [focusInput])

    const prevSessionIdRef = useRef<string | null | undefined>(effectiveSessionId)
    useEffect(() => {
        const prevSessionId = prevSessionIdRef.current
        prevSessionIdRef.current = effectiveSessionId
        // Automatically focus composer input when switching to a new session from another session
        if (effectiveSessionId === null && prevSessionId !== null && prevSessionId !== undefined && !isWorktreeBlocked && !sending) {
            focusInput()
            const timer1 = setTimeout(focusInput, 0)
            const timer2 = setTimeout(focusInput, 50)
            return () => {
                clearTimeout(timer1)
                clearTimeout(timer2)
            }
        }
    }, [effectiveSessionId, isWorktreeBlocked, sending, focusInput])

    const filteredPickerModels = useMemo(() => {
        if (!quickModelPickerOpen) return []
        const sorted = sortModelsByName(models)
        const query = modelPickerQuery.trim().toLowerCase()
        if (!query) return sorted

        return sorted.filter((model) => {
            const labelMatch = (model.label || model.id).toLowerCase().includes(query)
            const idMatch = model.id.toLowerCase().includes(query)
            const descMatch =
                model.description?.toLowerCase().includes(query) ?? false
            return labelMatch || idMatch || descMatch
        })
    }, [quickModelPickerOpen, modelPickerQuery, models])

    const handleSelectQuickModel = (model: ModelCatalogEntry) => {
        hostServices?.settings?.setModelId?.(model.id)
        const normalized = normalizeModelPreferences(
            model,
            currentSession?.reasoningEffort ?? settings.reasoningLevel,
            currentSession?.speed ?? settings.speed,
        )
        hostServices?.settings?.setReasoningLevel?.(normalized.reasoningLevel)
        if (effectiveSessionId && hostServices?.sessions?.setSessionRuntimeSettings) {
            hostServices.sessions.setSessionRuntimeSettings(effectiveSessionId, {
                modelId: model.id,
                reasoningEffort: normalized.reasoningLevel,
                speed: normalized.speed,
            })
        }
        setModelPickerQuery('')
        setModelPickerCursor(0)
        setQuickModelPickerOpen(false)
        textareaRef.current?.focus()
    }

    const handleSelectAttachMenuItem = async (id: AttachMenuItemId) => {
        setAttachMenuOpen(false)
        if (id === 'files') {
            const title = t('composer.attachMenu.filesAndFolders', { defaultValue: 'Files & Folders' })
            if (hostServices?.fileSystem?.selectFilesAndFolders) {
                try {
                    const selected = await hostServices.fileSystem.selectFilesAndFolders(title)
                    if (selected && selected.length > 0) {
                        void processSelectedNativeItems(selected)
                    }
                    return
                } catch {
                    fileInputRef.current?.click()
                }
            } else {
                fileInputRef.current?.click()
            }
            return
        }

        const matchedProvider = attachmentProviders.find((p) => p.id === id)
        if (matchedProvider && typeof matchedProvider.select === 'function') {
            try {
                const results = await matchedProvider.select({
                    sessionId: effectiveSessionId,
                    projectPath: selectedProject?.path ?? undefined,
                })
                if (results && results.length > 0) {
                    void processSelectedNativeItems(
                        results.map((r) => ({
                            name: r.name,
                            path: r.path || r.name,
                            isDirectory: Boolean((r as any).isDirectory),
                        })),
                    )
                    return
                }
            } catch (err) {
                console.error(`[Composer] Attachment provider "${id}" select error:`, err)
            }
        }
    }

    const projectId = currentSession
        ? (currentSession.projectId ?? null)
        : pendingSessionContext.projectId
    const branch = currentSession
        ? (currentSession.branch ?? null)
        : pendingSessionContext.branch
    const selectedProject = useMemo(
        () => projects.find((project) => project.id === projectId) ?? null,
        [projects, projectId],
    )
    const controlsLocked = isRunning || sending
    const isProcessingAttachments = processingCount > 0

    const slashQuery = getSlashQuery(draft)

    const previewResources = slashFrozenRef.current ?? { skills, prompts }
    const previewBuild =
        slashQuery === null
            ? { suggestions: [] as SlashSuggestion[], diagnostics: [] as string[] }
            : buildSlashSuggestionsWithDiagnostics({
                  query: slashQuery,
                  skills: previewResources.skills,
                  prompts: previewResources.prompts,
                  compactDescription: t('slash.compact.description', { defaultValue: 'Compact conversation context' }),
              })
    const previewHasMatches = previewBuild.suggestions.length > 0
    const menuActuallyOpen =
        slashOpen && slashQuery !== null && previewHasMatches

    if (menuActuallyOpen) {
        if (!slashFrozenRef.current) {
            slashFrozenRef.current = {
                skills: skills.slice() as Skill[],
                prompts: prompts.slice() as PromptTemplate[],
            }
        }
    } else if (slashFrozenRef.current) {
        slashFrozenRef.current = null
    }

    const finalResources = slashFrozenRef.current ?? { skills, prompts }
    const slashBuild =
        slashQuery === null
            ? { suggestions: [] as SlashSuggestion[], diagnostics: [] as string[] }
            : finalResources === previewResources
                ? previewBuild
                : buildSlashSuggestionsWithDiagnostics({
                      query: slashQuery,
                      skills: finalResources.skills,
                      prompts: finalResources.prompts,
                      compactDescription: t('slash.compact.description', { defaultValue: 'Compact conversation context' }),
                  })

    const slashSuggestions: SlashSuggestion[] = slashBuild.suggestions.map(
        (item, index) => ({
            ...item,
            id: `${slashListboxId}-opt-${item.group}-${index}-${sanitizeAriaId(item.command)}`,
        }),
    )
    lastSlashDiagnosticsRef.current = slashBuild.diagnostics

    const showSlashMenu =
        !quickModelPickerOpen &&
        slashOpen &&
        slashQuery !== null &&
        slashSuggestions.length > 0
    const activeSlashOptionId = showSlashMenu
        ? slashSuggestions[
              ((slashActiveIndex % slashSuggestions.length) +
                  slashSuggestions.length) %
                  slashSuggestions.length
          ]?.id
        : undefined

    const skillQuery = showSlashMenu ? null : getSkillQuery(draft, draftCursor)
    const previewSkillResources = skillFrozenRef.current ?? skills
    const storeUsageCounts = useSkillUsageCounts()
    const effectiveUsageCounts = skillUsageCountsProp ?? storeUsageCounts

    const previewSkillSuggestions =
        skillQuery === null
            ? ([] as SkillSuggestion[])
            : buildSkillSuggestions({
                  query: skillQuery,
                  skills: previewSkillResources,
                  usageCounts: effectiveUsageCounts,
              })
    const skillMenuHasMatches = previewSkillSuggestions.length > 0
    const skillMenuActuallyOpen =
        skillOpen && skillQuery !== null && skillMenuHasMatches

    if (skillMenuActuallyOpen) {
        if (!skillFrozenRef.current) {
            skillFrozenRef.current = skills.slice() as Skill[]
        }
    } else if (skillFrozenRef.current) {
        skillFrozenRef.current = null
    }

    const finalSkillResources = skillFrozenRef.current ?? skills
    const skillBuild =
        skillQuery === null
            ? ([] as SkillSuggestion[])
            : finalSkillResources === previewSkillResources
                ? previewSkillSuggestions
                : buildSkillSuggestions({
                      query: skillQuery,
                      skills: finalSkillResources,
                      usageCounts: effectiveUsageCounts,
                  })
    const skillSuggestions: SkillSuggestion[] = skillBuild.map((item, index) => ({
        ...item,
        id: `${skillListboxId}-opt-${index}-${sanitizeAriaId(item.name)}`,
    }))
    const showSkillMenu =
        !quickModelPickerOpen &&
        skillOpen &&
        skillQuery !== null &&
        skillSuggestions.length > 0
    const activeSkillOptionId = showSkillMenu
        ? skillSuggestions[
              ((skillActiveIndex % skillSuggestions.length) +
                  skillSuggestions.length) %
                  skillSuggestions.length
          ]?.id
        : undefined

    useEffect(() => {
        setSlashActiveIndex(0)
        if (slashQuery !== null) setSlashOpen(true)
    }, [slashQuery])

    useEffect(() => {
        setSkillActiveIndex(0)
        if (skillQuery !== null) setSkillOpen(true)
    }, [skillQuery])

    const shownSlashDiagnosticsRef = useRef<string>('')
    useEffect(() => {
        if (!showSlashMenu) {
            shownSlashDiagnosticsRef.current = ''
            return
        }
        const key = lastSlashDiagnosticsRef.current.join('|')
        if (!key || key === shownSlashDiagnosticsRef.current) return
        shownSlashDiagnosticsRef.current = key
        for (const message of lastSlashDiagnosticsRef.current) {
            pushToast(t('composer.resourceWarning', { message, defaultValue: message }))
        }
    }, [showSlashMenu, slashSuggestions, pushToast, t])

    useEffect(() => {
        if (!effectiveSessionId) return
        const session = sessions.find((item) => item.id === effectiveSessionId)
        const nextProjectId = session?.projectId ?? null
        const nextBranch = session?.branch ?? null
        if (
            pendingSessionContext.projectId === nextProjectId &&
            pendingSessionContext.branch === nextBranch
        ) {
            return
        }
        setPendingSessionContext({
            ...pendingSessionContext,
            projectId: nextProjectId,
            branch: nextBranch,
        })
    }, [effectiveSessionId, sessions, pendingSessionContext])

    const imagesBlocked = images.length > 0 && !supportsImages
    const hasContent = draft.trim().length > 0 || attachments.length > 0
    const canSend =
        hasContent &&
        !sending &&
        !imagesBlocked &&
        !isProcessingAttachments &&
        !isWorktreeBlocked

    const handleProjectChange = (next: string | null) => {
        const switching = next !== projectId
        const nextBranch = next && !switching ? branch : null
        setPendingSessionContext({
            projectId: next,
            branch: nextBranch,
            ...(pendingSessionContext.workLocation !== undefined
                ? { workLocation: pendingSessionContext.workLocation }
                : {}),
            ...(pendingSessionContext.environmentId !== undefined
                ? { environmentId: pendingSessionContext.environmentId }
                : {}),
        })
        if (effectiveSessionId) {
            hostServices?.sessions?.setProject?.(effectiveSessionId, next)
            if (!next || switching) {
                hostServices?.sessions?.setBranch?.(effectiveSessionId, nextBranch)
            }
        }
    }

    const handleBranchChange = (next: string | null) => {
        setPendingSessionContext({
            ...pendingSessionContext,
            projectId,
            branch: next,
        })
        if (effectiveSessionId) {
            hostServices?.sessions?.setBranch?.(effectiveSessionId, next)
        }
    }

    const expandSendText = (
        raw: string,
        promptsSnap: readonly PromptTemplate[],
    ): { text: string; isCompact: boolean; focus: string } => {
        const trimmed = raw.trim()
        if (trimmed === '/compact' || trimmed.startsWith('/compact ')) {
            const focus =
                trimmed === '/compact' ? '' : trimmed.slice('/compact'.length).trim()
            return { text: trimmed, isCompact: true, focus }
        }
        if (trimmed.startsWith('/skill:') || trimmed.startsWith('$')) {
            return {
                text: trimmed,
                isCompact: false,
                focus: '',
            }
        }
        if (trimmed.startsWith('/')) {
            return {
                text: expandPromptTemplate(trimmed, promptsSnap),
                isCompact: false,
                focus: '',
            }
        }
        return { text: trimmed, isCompact: false, focus: '' }
    }

    const handleSubmit = async (overrideFollowUpMode?: 'steer' | 'queue') => {
        if (sending || imagesBlocked || isProcessingAttachments || isWorktreeBlocked) return

        const raw = draft
        const trimmed = raw.trim()
        if (!trimmed && attachments.length === 0) return

        const promptsSnap = (
            showSlashMenu && slashFrozenRef.current
                ? slashFrozenRef.current.prompts
                : prompts
        ).slice() as PromptTemplate[]

        const expanded = expandSendText(raw, promptsSnap)
        if (expanded.isCompact) {
            if (isRunning) return
            if (!onCompact) {
                const message = t('composer.compactUnavailable', { defaultValue: 'Compact is unavailable' })
                if (mountedRef.current) {
                    setImageError(message)
                    pushToast(message, 'error')
                }
                return
            }
            try {
                await onCompact(expanded.focus)
                if (!mountedRef.current) return
                setComposerDraft('')
                setSlashOpen(false)
                setSkillOpen(false)
                setImageError(null)
            } catch (error) {
                if (!mountedRef.current) return
                const message =
                    error instanceof Error
                        ? error.message
                        : t('composer.compactFailed', { defaultValue: 'Compact failed' })
                setImageError(message)
                pushToast(message, 'error')
            }
            return
        }

        let sendText = expanded.text
        if (!sendText.trim() && attachments.length > 0) {
            const nonImg = attachments.filter((a) => a.kind !== 'image')
            if (nonImg.length > 0) {
                sendText = nonImg
                    .map((a) => (a.path ? `@${a.path}` : `@${a.name}`))
                    .join(' ')
            }
        }

        const effectiveFollowUpMode =
            overrideFollowUpMode ??
            (settings?.editor?.followUpMode === 'queue' ? 'queue' : 'steer')

        const payload: ComposerSendPayload = {
            text: sendText,
            images: images.map((image) => ({ ...image })),
            attachments: attachments.map((att) => ({ ...att })),
            projectId,
            branch,
            workLocation,
            environmentId,
            ...(isRunning ? { followUpMode: effectiveFollowUpMode } : {}),
        }

        setSending(true)
        try {
            const preprocessed = runSubmitPreprocessors(
                payload as any,
                undefined,
                { sessionId: effectiveSessionId, projectId, prompts: promptsSnap } as any,
            )

            const executeSend = (resolvedPayload: ComposerSendPayload) => {
                const dollarMatches = (resolvedPayload.text || sendText).matchAll(
                    /\$([a-zA-Z0-9_-]+)/g,
                )
                for (const match of dollarMatches) {
                    const skillName = match[1]
                    if (skillName && !/^\d+$/.test(skillName)) {
                        hostServices?.skillUsage?.recordUsage?.(skillName)
                    }
                }
                return onSend(resolvedPayload)
            }

            if (preprocessed && typeof (preprocessed as any).then === 'function') {
                const resolved = (await preprocessed) as unknown as ComposerSendPayload
                await executeSend(resolved)
            } else {
                await executeSend(preprocessed as unknown as ComposerSendPayload)
            }

            if (!mountedRef.current) return
            setComposerDraft('')
            setAttachments([])
            setImageError(null)
            setSlashOpen(false)
            setSkillOpen(false)
            setPendingSessionContext({ projectId: null, branch: null })
        } catch (error) {
            if (!mountedRef.current) return
            if (error instanceof Error && error.name === 'AbortError') return
            const message =
                error instanceof Error
                    ? error.message
                    : t('composer.sendFailed', { defaultValue: 'Send failed' })
            setImageError(message)
            pushToast(message, 'error')
        } finally {
            if (mountedRef.current) setSending(false)
        }
    }

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return

        if (attachMenuOpen) {
            if (event.key === 'ArrowDown') {
                event.preventDefault()
                setAttachMenuActiveIndex(
                    (index) => (index + 1) % ATTACH_MENU_ITEMS.length,
                )
                return
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault()
                setAttachMenuActiveIndex(
                    (index) =>
                        (index - 1 + ATTACH_MENU_ITEMS.length) %
                        ATTACH_MENU_ITEMS.length,
                )
                return
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                const selected = ATTACH_MENU_ITEMS[attachMenuActiveIndex]
                if (selected) {
                    handleSelectAttachMenuItem(selected.id)
                }
                return
            }
            if (event.key === 'Escape') {
                event.preventDefault()
                setAttachMenuOpen(false)
                return
            }
        }

        if (quickModelPickerOpen) {
            if (event.key === 'ArrowDown') {
                event.preventDefault()
                if (filteredPickerModels.length > 0) {
                    setModelPickerActiveIndex(
                        (index) => (index + 1) % filteredPickerModels.length,
                    )
                }
                return
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault()
                if (filteredPickerModels.length > 0) {
                    setModelPickerActiveIndex(
                        (index) =>
                            (index - 1 + filteredPickerModels.length) %
                            filteredPickerModels.length,
                    )
                }
                return
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                const safeIndex =
                    filteredPickerModels.length > 0
                        ? ((modelPickerActiveIndex % filteredPickerModels.length) +
                              filteredPickerModels.length) %
                          filteredPickerModels.length
                        : 0
                const item = filteredPickerModels[safeIndex]
                if (item) {
                    handleSelectQuickModel(item)
                }
                return
            }
            if (event.key === 'Escape') {
                event.preventDefault()
                setModelPickerQuery('')
                setModelPickerCursor(0)
                setQuickModelPickerOpen(false)
                return
            }
        }

        if (showSlashMenu) {
            if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSlashActiveIndex((index) => (index + 1) % slashSuggestions.length)
                return
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSlashActiveIndex(
                    (index) =>
                        (index - 1 + slashSuggestions.length) % slashSuggestions.length,
                )
                return
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                const item = slashSuggestions[slashActiveIndex]
                if (item) applySlashSuggestion(item)
                return
            }
            if (event.key === 'Escape') {
                event.preventDefault()
                setSlashOpen(false)
                return
            }
        }

        if (showSkillMenu) {
            if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSkillActiveIndex((index) => (index + 1) % skillSuggestions.length)
                return
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSkillActiveIndex(
                    (index) =>
                        (index - 1 + skillSuggestions.length) % skillSuggestions.length,
                )
                return
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                const item = skillSuggestions[skillActiveIndex]
                if (item) applySkillSuggestion(item)
                return
            }
            if (event.key === 'Escape') {
                event.preventDefault()
                setSkillOpen(false)
                return
            }
        }

        const sendShortcut = settings?.editor?.sendShortcut
        const followUpModeSetting = (settings?.editor?.followUpMode === 'queue' ? 'queue' : 'steer') as 'steer' | 'queue'
        const isReverseFollowUp =
            isRunning &&
            event.key === 'Enter' &&
            event.shiftKey &&
            (event.metaKey || event.ctrlKey)

        if (isReverseFollowUp) {
            event.preventDefault()
            const reversedMode = followUpModeSetting === 'steer' ? 'queue' : 'steer'
            void handleSubmit(reversedMode)
            return
        }

        const shouldSend =
            sendShortcut === 'cmdEnter'
                ? event.key === 'Enter' && (event.metaKey || event.ctrlKey)
                : event.key === 'Enter' && !event.shiftKey

        if (shouldSend) {
            event.preventDefault()
            void handleSubmit()
        }
    }

    const applySlashSuggestion = (item: SlashSuggestion) => {
        setComposerDraft(item.insertText)
        setSlashOpen(false)
        textareaRef.current?.focus()
    }

    const applySkillSuggestion = (item: SkillSuggestion) => {
        hostServices?.skillUsage?.recordUsage?.(item.name)
        const inserted = insertSkillAtCaret(draft, item.name, draftCursor)
        setComposerDraft(inserted.text)
        setDraftCursor(inserted.cursor)
        setSkillOpen(false)
        textareaRef.current?.focus()
    }

    const processSelectedNativeItems = (
        items: Array<{ name: string; path: string; isDirectory: boolean }>,
    ) => {
        processChainRef.current = processChainRef.current
            .then(async () => {
                if (!mountedRef.current) return
                setProcessingCount((count) => count + 1)
                try {
                    for (const item of items) {
                        if (!mountedRef.current) return
                        if (item.isDirectory) {
                            const folderAttachment: ComposerAttachment = {
                                id: createId(),
                                name: item.name,
                                path: item.path,
                                kind: 'folder',
                                mimeType: 'directory',
                            }
                            setAttachments((prev) => [...prev, folderAttachment])
                            continue
                        }

                        const isImgExt = /\.(jpe?g|png|gif|webp|bmp)$/i.test(item.name)
                        if (isImgExt && hostServices?.fileSystem?.readFile) {
                            try {
                                const fileData =
                                    await hostServices.fileSystem.readFile(item.path)
                                const bytes = base64ToBytes(fileData.dataBase64)
                                if (bytes) {
                                    const detected = detectImageMimeType(bytes)
                                    if (detected && ACCEPTED_MIME.has(detected)) {
                                        const result =
                                            await processorRef.current.process(
                                                bytes,
                                                detected,
                                            )
                                        if (result.ok) {
                                            const reportedWidth =
                                                result.width ?? result.originalWidth
                                            const reportedHeight =
                                                result.height ?? result.originalHeight
                                            let dimensions: {
                                                width: number
                                                height: number
                                            } | null = null
                                            if (
                                                isPositiveInt(reportedWidth) &&
                                                isPositiveInt(reportedHeight)
                                            ) {
                                                dimensions = {
                                                    width: reportedWidth,
                                                    height: reportedHeight,
                                                }
                                            } else {
                                                const processedBytes =
                                                    base64ToBytes(result.data)
                                                if (processedBytes) {
                                                    dimensions =
                                                        await resolveImageDimensions({
                                                            resultWidth: reportedWidth,
                                                            resultHeight:
                                                                reportedHeight,
                                                            bytes: processedBytes,
                                                            mimeType: result.mimeType,
                                                            probe:
                                                                dimensionProbeRef.current,
                                                        })
                                                }
                                            }
                                            if (dimensions) {
                                                const imageAttachment: ComposerAttachment =
                                                    {
                                                        id: createId(),
                                                        name: item.name,
                                                        path: item.path,
                                                        kind: 'image',
                                                        mimeType: result.mimeType,
                                                        data: result.data,
                                                        width: dimensions.width,
                                                        height: dimensions.height,
                                                    }
                                                setAttachments((prev) => [
                                                    ...prev,
                                                    imageAttachment,
                                                ])
                                                setImageError(null)
                                                continue
                                            }
                                        }
                                    }
                                }
                            } catch {
                                // Fallback to regular file attachment
                            }
                        }

                        const fileAttachment: ComposerAttachment = {
                            id: createId(),
                            name: item.name,
                            path: item.path,
                            kind: 'file',
                            mimeType: getFileMimeOrExt(item.name),
                        }
                        setAttachments((prev) => [...prev, fileAttachment])
                    }
                } finally {
                    if (mountedRef.current) {
                        setProcessingCount((count) => Math.max(0, count - 1))
                    }
                }
            })
            .catch(() => {})
    }

    const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files
        if (!files || files.length === 0) return
        const list = Array.from(files)
        event.target.value = ''
        enqueueFiles(list)
    }

    const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
        const clipboard = event.clipboardData
        const files = Array.from(clipboard.files ?? [])
            .filter((file) => file.type.startsWith('image/'))
        if (files.length === 0) {
            for (const item of Array.from(clipboard.items ?? [])) {
                if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
                const file = item.getAsFile()
                if (file) files.push(file)
            }
        }
        if (files.length === 0) return
        // Consume image pastes so clipboard HTML/text is not inserted as well.
        event.preventDefault()
        if (controlsLocked || isWorktreeBlocked || quickModelPickerOpen) return
        enqueueFiles(files)
    }

    const enqueueFiles = (list: File[]) => {
        processChainRef.current = processChainRef.current
            .then(async () => {
                if (!mountedRef.current) return
                setProcessingCount((count) => count + 1)
                try {
                    for (const file of list) {
                        if (!mountedRef.current) return
                        try {
                            const isImgClaimed =
                                file.type.startsWith('image/') ||
                                /\.(jpe?g|png|gif|webp|bmp)$/i.test(file.name)

                            if (isImgClaimed) {
                                if (file.size > MAX_IMAGE_INPUT_BYTES) {
                                    const message = t('composer.imageTooLarge', {
                                        name: file.name,
                                        max: Math.floor(
                                            MAX_IMAGE_INPUT_BYTES / (1024 * 1024),
                                        ),
                                        defaultValue: `Image ${file.name} is too large`,
                                    })
                                    if (mountedRef.current) {
                                        setImageError(message)
                                        pushToast(message, 'error')
                                    }
                                    continue
                                }

                                const buffer = await file.arrayBuffer()
                                if (!mountedRef.current) return
                                const bytes = new Uint8Array(buffer)
                                const detected = detectImageMimeType(bytes)
                                if (!detected || !ACCEPTED_MIME.has(detected)) {
                                    if (mountedRef.current) {
                                        const message = t(
                                            'composer.imageUnsupportedType',
                                            {
                                                name: file.name,
                                                defaultValue: `Unsupported image format: ${file.name}`,
                                            },
                                        )
                                        setImageError(message)
                                        pushToast(message, 'error')
                                    }
                                    continue
                                }

                                const result =
                                    await processorRef.current.process(
                                        bytes,
                                        detected,
                                    )
                                if (!mountedRef.current) return
                                if (!result.ok) {
                                    const message =
                                        result.message ||
                                        t('composer.imageProcessFailed', { defaultValue: 'Failed to process image' })
                                    setImageError(message)
                                    pushToast(message, 'error')
                                    continue
                                }

                                let dimensions: {
                                    width: number
                                    height: number
                                } | null = null
                                const reportedWidth =
                                    result.width ?? result.originalWidth
                                const reportedHeight =
                                    result.height ?? result.originalHeight
                                if (
                                    isPositiveInt(reportedWidth) &&
                                    isPositiveInt(reportedHeight)
                                ) {
                                    dimensions = {
                                        width: reportedWidth,
                                        height: reportedHeight,
                                    }
                                } else {
                                    const processedBytes = base64ToBytes(
                                        result.data,
                                    )
                                    if (!processedBytes) {
                                        const message = t(
                                            'composer.imageProcessFailed',
                                            { defaultValue: 'Failed to process image' },
                                        )
                                        setImageError(message)
                                        pushToast(message, 'error')
                                        continue
                                    }
                                    dimensions = await resolveImageDimensions({
                                        resultWidth: reportedWidth,
                                        resultHeight: reportedHeight,
                                        bytes: processedBytes,
                                        mimeType: result.mimeType,
                                        probe: dimensionProbeRef.current,
                                    })
                                }
                                if (!mountedRef.current) return
                                if (!dimensions) {
                                    const message = t(
                                        'composer.imageMissingDimensions',
                                        {
                                            name: file.name,
                                            defaultValue: `Missing image dimensions for ${file.name}`,
                                        },
                                    )
                                    setImageError(message)
                                    pushToast(message, 'error')
                                    continue
                                }

                                const imageAttachment: ComposerAttachment = {
                                    id: createId(),
                                    name: file.name,
                                    path: (file as unknown as { path?: string }).path,
                                    kind: 'image',
                                    mimeType: result.mimeType,
                                    data: result.data,
                                    width: dimensions.width,
                                    height: dimensions.height,
                                }
                                setAttachments((prev) => [
                                    ...prev,
                                    imageAttachment,
                                ])
                                setImageError(null)
                                continue
                            }

                            const fileAttachment: ComposerAttachment = {
                                id: createId(),
                                name: file.name,
                                path: (file as unknown as { path?: string }).path,
                                kind: 'file',
                                mimeType: file.type || getFileMimeOrExt(file.name),
                            }
                            setAttachments((prev) => [...prev, fileAttachment])
                        } catch (error) {
                            if (!mountedRef.current) return
                            const message =
                                error instanceof Error
                                    ? error.message
                                    : t('composer.imageProcessFailed', { defaultValue: 'Failed to process image' })
                            setImageError(message)
                            pushToast(message, 'error')
                        }
                    }
                } finally {
                    if (mountedRef.current) {
                        setProcessingCount((count) => Math.max(0, count - 1))
                    }
                }
            })
            .catch(() => {})
    }

    const removeAttachment = (id: string) => {
        setAttachments((prev) => prev.filter((item) => item.id !== id))
    }

    const hasAnyMenuOpen =
        attachMenuOpen ||
        showSlashMenu ||
        showSkillMenu ||
        quickModelPickerOpen

    return (
        <div
            className={cn(
                'pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-6 pb-6',
                hasAnyMenuOpen ? 'z-[60]' : 'z-20',
                className,
            )}
        >
            <div
                data-element="composer-container"
                className="pointer-events-auto flex w-full max-w-3xl flex-col items-center gap-0 select-none"
            >
                <div
                    className={cn(
                        'relative z-10 flex w-[calc(100%-1.25rem)] flex-wrap items-center gap-1.5',
                        'rounded-t-[16px] rounded-b-none border-0',
                        'bg-[var(--bg-composer-bar)] px-2.5 pt-[7px] backdrop-blur-md',
                        'pb-[22px] mb-[-18px]',
                        (shouldHideContextBar ||
                            quickModelPickerOpen ||
                            attachMenuOpen ||
                            showSkillMenu) &&
                            'hidden',
                    )}
                >
                    <ExtensionSlot
                        name="composer.bar.left"
                        props={{ projectId, branch, disabled: controlsLocked }}
                    />
                    {contextControls.map((ctrl) => {
                        const ControlComponent = ctrl.component
                        return (
                            <ControlErrorBoundary key={ctrl.id} id={ctrl.id}>
                                <ControlComponent
                                    sessionId={effectiveSessionId}
                                    disabled={controlsLocked}
                                    projectId={projectId}
                                    branch={branch}
                                    workLocation={workLocation}
                                    environmentId={environmentId}
                                    onChange={
                                        ctrl.id === 'project-picker'
                                            ? handleProjectChange
                                            : ctrl.id === 'work-location-picker'
                                                ? handleWorkLocationChange
                                                : ctrl.id === 'environment-picker'
                                                    ? handleEnvironmentChange
                                                    : ctrl.id === 'branch-picker'
                                                        ? handleBranchChange
                                                        : undefined
                                    }
                                />
                            </ControlErrorBoundary>
                        )
                    })}
                    <ExtensionSlot
                        name="composer.bar.right"
                        props={{ projectId, branch, disabled: controlsLocked }}
                    />
                </div>

                <div
                    ref={composerCardRef}
                    className={cn(
                        'w-full transform-gpu',
                        hasAnyMenuOpen ? 'relative z-[60]' : 'relative z-20',
                        'rounded-[var(--radius-composer)] border border-[var(--border-composer)]',
                        'bg-[var(--bg-composer)] shadow-[0_12px_40px_rgba(0,0,0,0.35)] backdrop-blur-md',
                    )}
                >
                    {quickModelPickerOpen && !isRunning ? (
                        <QuickModelPicker
                            models={filteredPickerModels}
                            currentModelId={effectiveModelId}
                            activeIndex={modelPickerActiveIndex}
                            onActiveIndexChange={setModelPickerActiveIndex}
                            onSelect={handleSelectQuickModel}
                            onClose={() => {
                                setModelPickerQuery('')
                                setModelPickerCursor(0)
                                setQuickModelPickerOpen(false)
                            }}
                        />
                    ) : null}

                    {attachMenuOpen ? (
                        <AttachMenu
                            anchorRef={composerCardRef}
                            activeIndex={attachMenuActiveIndex}
                            onActiveIndexChange={setAttachMenuActiveIndex}
                            onSelect={handleSelectAttachMenuItem}
                            onClose={() => setAttachMenuOpen(false)}
                        />
                    ) : null}

                    {showSlashMenu ? (
                        <SlashMenu
                            id={slashListboxId}
                            suggestions={slashSuggestions}
                            activeIndex={slashActiveIndex}
                            onActiveIndexChange={setSlashActiveIndex}
                            onSelect={applySlashSuggestion}
                            onClose={() => setSlashOpen(false)}
                        />
                    ) : null}

                    {showSkillMenu ? (
                        <SkillMenu
                            id={skillListboxId}
                            suggestions={skillSuggestions}
                            activeIndex={skillActiveIndex}
                            onActiveIndexChange={setSkillActiveIndex}
                            onSelect={applySkillSuggestion}
                            onClose={() => setSkillOpen(false)}
                            preferredPlacement="above"
                        />
                    ) : null}

                    <ExtensionSlot
                        name="composer.menus"
                        props={{ draft, disabled: sending }}
                    />

                    {attachments.length > 0 ? (
                        <div className="flex flex-wrap gap-2 px-4 pt-3">
                            {attachments.map((attachment) => {
                                if (
                                    attachment.kind === 'image' &&
                                    attachment.data
                                ) {
                                    return (
                                        <div
                                            key={attachment.id}
                                            className={cn(
                                                'group relative size-14 shrink-0 overflow-hidden rounded-xl',
                                                'border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-xs',
                                                imagesBlocked &&
                                                    'border-[var(--accent-orange)] ring-1 ring-[var(--accent-orange)]/50',
                                            )}
                                            title={attachment.name}
                                        >
                                            <img
                                                src={`data:${attachment.mimeType};base64,${attachment.data}`}
                                                alt={attachment.name}
                                                className="h-full w-full object-cover object-center select-none"
                                            />
                                            <span className="truncate sr-only">
                                                {attachment.name}
                                            </span>
                                            {imagesBlocked ? (
                                                <span
                                                    data-testid="image-unsupported"
                                                    className="absolute inset-x-0 bottom-0 bg-[var(--accent-orange)]/90 px-1 py-0.5 text-center text-[9px] font-medium text-white backdrop-blur-xs"
                                                    title={t(
                                                        'composer.imageUnsupportedModel',
                                                        { defaultValue: 'Current model does not support images' },
                                                    )}
                                                >
                                                    {t(
                                                        'composer.imageUnsupportedBadge',
                                                        { defaultValue: 'Images unsupported' },
                                                    )}
                                                </span>
                                            ) : null}
                                            <button
                                                type="button"
                                                className="absolute top-1 right-1 flex size-4.5 items-center justify-center rounded-full bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm transition-transform hover:scale-110 active:scale-95 disabled:pointer-events-none cursor-pointer"
                                                aria-label={t(
                                                    'composer.removeAttachment',
                                                    {
                                                        name: attachment.name,
                                                        defaultValue: `Remove ${attachment.name}`,
                                                    },
                                                )}
                                                onClick={() =>
                                                    removeAttachment(
                                                        attachment.id,
                                                    )
                                                }
                                                disabled={sending}
                                            >
                                                <X className="size-3 stroke-[2.5]" />
                                            </button>
                                        </div>
                                    )
                                }

                                return (
                                    <div
                                        key={attachment.id}
                                        className={cn(
                                            'group relative flex h-14 min-w-[140px] max-w-[220px] items-center gap-2.5 rounded-xl',
                                            'border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2.5 py-2 shadow-xs',
                                        )}
                                        title={
                                            attachment.path || attachment.name
                                        }
                                    >
                                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-black/25 dark:bg-white/5 border border-white/5">
                                            {attachment.kind === 'folder' ? (
                                                <Folder
                                                    className="size-5 text-[var(--text-muted)]"
                                                    aria-hidden
                                                />
                                            ) : isPdf(attachment.name) ? (
                                                <div className="flex h-6 w-5.5 flex-col items-center justify-center rounded-[3px] bg-[#ef4444] text-white shadow-xs font-bold text-[8px] leading-none select-none">
                                                    <span>PDF</span>
                                                </div>
                                            ) : isCodeFile(attachment.name) ? (
                                                <FileCode
                                                    className="size-5 text-blue-400"
                                                    aria-hidden
                                                />
                                            ) : (
                                                <FileText
                                                    className="size-5 text-[var(--text-muted)]"
                                                    aria-hidden
                                                />
                                            )}
                                        </div>
                                        <div className="flex min-w-0 flex-1 flex-col justify-center pr-4">
                                            <span className="truncate text-[13px] font-medium text-[var(--text-primary)] leading-tight">
                                                {attachment.name}
                                            </span>
                                            <span className="truncate text-[11px] text-[var(--text-muted)] leading-tight mt-0.5">
                                                {attachment.kind === 'folder'
                                                    ? t(
                                                          'composer.folderAttachment',
                                                          { defaultValue: 'Folder' },
                                                      )
                                                    : isPdf(attachment.name)
                                                      ? 'PDF'
                                                      : getFileExtLabel(
                                                            attachment.name,
                                                        ) ||
                                                        t(
                                                            'composer.fileAttachment',
                                                            { defaultValue: 'File' },
                                                        )}
                                            </span>
                                        </div>
                                        <button
                                            type="button"
                                            className="absolute top-1 right-1 flex size-4.5 items-center justify-center rounded-full bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm transition-transform hover:scale-110 active:scale-95 disabled:pointer-events-none cursor-pointer"
                                            aria-label={t(
                                                'composer.removeAttachment',
                                                {
                                                    name: attachment.name,
                                                    defaultValue: `Remove ${attachment.name}`,
                                                },
                                            )}
                                            onClick={() =>
                                                removeAttachment(attachment.id)
                                            }
                                            disabled={sending}
                                        >
                                            <X className="size-3 stroke-[2.5]" />
                                        </button>
                                    </div>
                                )
                            })}
                        </div>
                    ) : null}

                    {imageError ? (
                        <p className="px-4 pt-2 text-[12px] text-[var(--accent-orange)]">
                            {imageError}
                        </p>
                    ) : null}

                    {isProcessingAttachments ? (
                        <p
                            data-testid="composer-processing-attachments"
                            className="px-4 pt-2 text-[12px] text-[var(--text-muted)]"
                        >
                            {t('composer.processingAttachments', { defaultValue: 'Processing attachments...' })}
                        </p>
                    ) : null}

                    {imagesBlocked ? (
                        <p
                            data-testid="image-unsupported-message"
                            className="px-4 pt-2 text-[12px] text-[var(--accent-orange)]"
                        >
                            {t('composer.imageUnsupportedModel', { defaultValue: 'Current model does not support images' })}
                        </p>
                    ) : null}

                    <div className="flex w-full items-start gap-1.5 px-4 pb-2 pt-3">
                        <SkillDraftEditor
                            editorRef={textareaRef}
                            value={quickModelPickerOpen ? modelPickerQuery : draft}
                            cursor={quickModelPickerOpen ? modelPickerCursor : draftCursor}
                            skills={skills}
                            disabled={sending || isWorktreeBlocked}
                            maxHeight={TEXTAREA_MAX_HEIGHT}
                            placeholder={
                                quickModelPickerOpen
                                    ? t(
                                          'composer.quickModelPicker.placeholder',
                                          { defaultValue: 'Type or select a model' },
                                      )
                                    : isSettingUpWorktree
                                      ? t(
                                            'composer.waitingWorktreeSetup',
                                            { defaultValue: 'Waiting for worktree setup...' },
                                        )
                                      : isWorktreeError
                                        ? t(
                                              'worktree.setupFailedPlaceholder',
                                              { defaultValue: 'Worktree setup failed, please retry or continue anyway' },
                                          )
                                        : t('composer.placeholder', { defaultValue: 'Type a message...' })
                            }
                            ariaLabel={
                                quickModelPickerOpen
                                    ? t(
                                          'composer.quickModelPicker.placeholder',
                                          { defaultValue: 'Type or select a model' },
                                      )
                                    : isSettingUpWorktree
                                      ? t(
                                            'composer.waitingWorktreeSetup',
                                            { defaultValue: 'Waiting for worktree setup...' },
                                        )
                                      : isWorktreeError
                                        ? t(
                                              'worktree.setupFailedPlaceholder',
                                              { defaultValue: 'Worktree setup failed, please retry or continue anyway' },
                                          )
                                        : t('composer.placeholder', { defaultValue: 'Type a message...' })
                            }
                            onChange={(next, cursor) => {
                                if (quickModelPickerOpen) {
                                    setModelPickerQuery(next)
                                    setModelPickerCursor(cursor)
                                } else {
                                    setComposerDraft(next)
                                    setDraftCursor(cursor)
                                }
                            }}
                            onKeyDown={handleKeyDown}
                            onPaste={handlePaste}
                            ariaControls={
                                showSlashMenu
                                    ? slashListboxId
                                    : showSkillMenu
                                        ? skillListboxId
                                        : undefined
                            }
                            ariaExpanded={showSlashMenu || showSkillMenu}
                            ariaActivedescendant={
                                showSlashMenu
                                    ? activeSlashOptionId
                                    : showSkillMenu
                                        ? activeSkillOptionId
                                        : undefined
                            }
                            ariaAutocomplete={
                                showSlashMenu || showSkillMenu ? 'list' : undefined
                            }
                            role={showSlashMenu || showSkillMenu ? 'combobox' : undefined}
                        />
                    </div>

                    <div className="flex items-center gap-1 px-2 pb-2">
                        <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            hidden
                            onChange={(event) => {
                                void handleFiles(event)
                            }}
                        />

                        <ExtensionSlot
                            name="composer.toolbar.left"
                            props={{ disabled: controlsLocked }}
                        />

                        {toolbarLeftControls.map((ctrl) => {
                            const ControlComponent = ctrl.component
                            const isAttach = ctrl.id === 'composer-attach'
                            return (
                                <ControlErrorBoundary key={ctrl.id} id={ctrl.id}>
                                    <ControlComponent
                                        sessionId={effectiveSessionId}
                                        disabled={
                                            isAttach
                                                ? false
                                                : controlsLocked
                                        }
                                        onToggleAttachMenu={() => {
                                            setAttachMenuOpen((prev) => {
                                                const next = !prev
                                                if (next) {
                                                    setAttachMenuActiveIndex(0)
                                                    setQuickModelPickerOpen(false)
                                                    setSlashOpen(false)
                                                    setSkillOpen(false)
                                                    setTimeout(() => {
                                                        textareaRef.current?.focus()
                                                    }, 0)
                                                }
                                                return next
                                            })
                                        }}
                                    />
                                </ControlErrorBoundary>
                            )
                        })}

                        <ExtensionSlot
                            name="composer.toolbar.actions"
                            props={{ disabled: controlsLocked }}
                        />

                        <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1">
                            {toolbarRightControls.map((ctrl) => {
                                const ControlComponent = ctrl.component
                                const isModelSelect = ctrl.id === 'model-select'
                                return (
                                    <ControlErrorBoundary key={ctrl.id} id={ctrl.id}>
                                        <ControlComponent
                                            sessionId={effectiveSessionId}
                                            disabled={isModelSelect ? sending : controlsLocked}
                                            isRunning={isRunning}
                                        />
                                    </ControlErrorBoundary>
                                )
                            })}
                            <ExtensionSlot
                                name="composer.toolbar.right"
                                props={{
                                    disabled: controlsLocked,
                                    sessionId: effectiveSessionId,
                                    isRunning,
                                }}
                            />

                            {isRunning && !hasContent ? (
                                <button
                                    type="button"
                                    aria-label={t('composer.stop', { defaultValue: 'Stop' })}
                                    onClick={() => onStop?.()}
                                    className={cn(
                                        'flex size-8 items-center justify-center rounded-full',
                                        'bg-[var(--text-primary)] text-[var(--bg-app)]',
                                        'transition-opacity hover:opacity-90',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                                    )}
                                >
                                    <Square className="size-3.5 fill-current" />
                                </button>
                            ) : isRunning && hasContent ? (
                                <button
                                    type="button"
                                    aria-label={
                                        (settings?.editor?.followUpMode === 'queue' ? 'queue' : 'steer') === 'queue'
                                            ? t('settings.editor.followUpMode.queue', { defaultValue: 'Queue' })
                                            : t('settings.editor.followUpMode.steer', { defaultValue: 'Steer' })
                                    }
                                    title={
                                        (settings?.editor?.followUpMode === 'queue' ? 'queue' : 'steer') === 'queue'
                                            ? t('settings.editor.followUpMode.queue', { defaultValue: 'Queue' })
                                            : t('settings.editor.followUpMode.steer', { defaultValue: 'Steer' })
                                    }
                                    disabled={!canSend}
                                    onClick={() => {
                                        void handleSubmit()
                                    }}
                                    className={cn(
                                        'flex size-8 shrink-0 items-center justify-center rounded-full transition-opacity',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                                        canSend
                                            ? 'bg-[var(--text-primary)] text-[var(--bg-app)] hover:opacity-90'
                                            : 'bg-[var(--bg-sidebar-hover)] text-[var(--text-muted)]',
                                    )}
                                >
                                    <ArrowUp className="size-4" />
                                </button>
                            ) : canResume && !hasContent && !effectiveIsTurnComplete ? (
                                <button
                                    type="button"
                                    aria-label={t('composer.resume', { defaultValue: 'Resume' })}
                                    onClick={() => {
                                        void onResume?.()
                                    }}
                                    className={cn(
                                        'flex size-8 shrink-0 items-center justify-center rounded-full transition-opacity',
                                        'bg-[var(--text-primary)] text-[var(--bg-app)] hover:opacity-90',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                                    )}
                                >
                                    <Play className="size-3.5 fill-current" />
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    aria-label={t('composer.send', { defaultValue: 'Send' })}
                                    disabled={!canSend}
                                    onClick={() => {
                                        void handleSubmit()
                                    }}
                                    className={cn(
                                        'flex size-8 shrink-0 items-center justify-center rounded-full transition-opacity',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                                        canSend
                                            ? 'bg-[var(--text-primary)] text-[var(--bg-app)] hover:opacity-90'
                                            : 'bg-[var(--bg-sidebar-hover)] text-[var(--text-muted)]',
                                    )}
                                >
                                    <ArrowUp className="size-4" />
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
})

export const Composer = createExtensibleComponent('Composer', BaseComposer)
export { BaseComposer }

function isPositiveInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
}

async function resolveImageDimensions(args: {
    resultWidth?: number
    resultHeight?: number
    bytes: Uint8Array
    mimeType: string
    probe?: DimensionProbe
}): Promise<{ width: number; height: number } | null> {
    if (isPositiveInt(args.resultWidth) && isPositiveInt(args.resultHeight)) {
        return { width: args.resultWidth, height: args.resultHeight }
    }

    if (args.probe) {
        try {
            const probed = await args.probe(args.bytes, args.mimeType)
            if (
                probed &&
                isPositiveInt(probed.width) &&
                isPositiveInt(probed.height)
            ) {
                return { width: probed.width, height: probed.height }
            }
        } catch {
            // fall through to createImageBitmap
        }
    }

    if (typeof createImageBitmap !== 'function') return null
    let bitmap: ImageBitmap | undefined
    try {
        const copy = new Uint8Array(args.bytes.byteLength)
        copy.set(args.bytes)
        const blob = new Blob([copy.buffer], { type: args.mimeType })
        bitmap = (await createImageBitmap(blob)) as ImageBitmap
        const width = bitmap.width
        const height = bitmap.height
        if (isPositiveInt(width) && isPositiveInt(height)) {
            return { width, height }
        }
        return null
    } catch {
        return null
    } finally {
        if (bitmap) {
            try {
                bitmap.close()
            } catch {
                // ignore close failures
            }
        }
    }
}
