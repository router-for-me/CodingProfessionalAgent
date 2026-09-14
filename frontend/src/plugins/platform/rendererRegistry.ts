import { ContributionRegistry } from '@cpa/plugin-kernel'
import type {
    AgentTarget,
    AgentToolContribution,
    AttachmentProvider,
    ChatRendererContribution,
    CommandContribution,
    ComponentWrapperContribution,
    ComposerControlContribution,
    ComposerSubmitPreprocessorContribution,
    ContributionKind,
    FloatingContribution,
    HookContribution,
    HookEventName,
    ModelCatalogProviderContribution,
    PanelContribution,
    PanelTabContribution,
    PluginIdentity,
    ProtocolMiddleware,
    ProtocolProvider,
    ResourceKind,
    ResourceProvider,
    SelectChatRendererOptions,
    SettingsGroupContribution,
    SettingsSectionContribution,
    SlotContribution,
    SystemPromptContribution,
    ToolFactoryContribution,
    ToolRiskLevel,
} from '@cpa/plugin-api'
import { matchChatRenderer } from '@cpa/plugin-ui'

const DIRECT_OWNER: PluginIdentity = Object.freeze({
    id: 'cpa.runtime.direct',
    version: '1.0.0',
})

const NON_SLOT_EXACT_KEYS = new Set<string>([
    'slot',
    'floating',
    'floatings',
    'component-wrapper',
    'panel',
    'panelTabs',
    'settings-group',
    'settings.groups',
    'settings',
    'settings.sections',
    'action',
    'commands',
    'tool-factory',
    'agentTools',
    'resource-provider',
    'resourceProviders',
    'hook',
    'systemPrompts',
    'protocol',
    'protocolProviders',
    'protocol-middleware',
    'protocolMiddlewares',
    'composer',
    'composer.controls',
    'composer.attachments',
    'composer.preprocessors',
    'chat-renderer',
    'chat.renderers',
    'model-catalog',
    'modelCatalogProviders',
])

const NON_SLOT_PREFIXES = [
    'floating:',
    'panel:',
    'settings-group:',
    'settings:',
    'action:',
    'tool-factory:',
    'resource-provider:',
    'hook:',
    'protocol:',
    'protocol-middleware:',
    'componentWrapper:',
    'component-wrapper:',
    'composer:',
    'chat-renderer:',
    'model-catalog:',
]

/**
 * Universal Renderer registry that bridges the plugin kernel's ContributionRegistry
 * with cached snapshot references, typed selectors, and reactive subscriptions for React.
 */
export class RendererRegistry {
    readonly kernelRegistry: ContributionRegistry
    private directDisposers = new Map<string, () => void>()
    private listeners = new Map<string, Set<() => void>>()
    private unsubs: Array<() => void> = []

    // Snapshot reference caches for React useSyncExternalStore stability
    private cachedSlots = new Map<string, readonly SlotContribution<any>[]>()
    private cachedFloatings: readonly FloatingContribution<any>[] | null = null
    private cachedComponentWrappers = new Map<string, readonly ComponentWrapperContribution<any>[]>()
    private cachedPanelTabs: readonly PanelTabContribution<any>[] | null = null
    private cachedSettingsGroups: readonly SettingsGroupContribution[] | null = null
    private cachedSettingsSections: readonly SettingsSectionContribution[] | null = null
    private cachedCommands: readonly CommandContribution[] | null = null
    private cachedAgentTools = new Map<AgentTarget, readonly AgentToolContribution[]>()
    private cachedToolFactories = new Map<AgentTarget, readonly ToolFactoryContribution[]>()
    private cachedResourceProviders = new Map<string, readonly ResourceProvider<any>[]>()
    private cachedHookContributions = new Map<string, readonly HookContribution[]>()
    private cachedSystemPrompts = new Map<AgentTarget, readonly SystemPromptContribution[]>()
    private cachedProtocolProviders: readonly ProtocolProvider[] | null = null
    private cachedProtocolMiddlewares: readonly ProtocolMiddleware[] | null = null
    private cachedComposerControls = new Map<string, readonly ComposerControlContribution[]>()
    private cachedAttachmentProviders: readonly AttachmentProvider[] | null = null
    private cachedSubmitPreprocessors: readonly ComposerSubmitPreprocessorContribution[] | null = null
    private cachedChatRenderers: readonly ChatRendererContribution<any>[] | null = null
    private cachedModelCatalogProviders: readonly ModelCatalogProviderContribution[] | null = null

    constructor(kernelRegistry: ContributionRegistry = new ContributionRegistry()) {
        this.kernelRegistry = kernelRegistry
        this.setupKernelSubscriptions()
    }

    private setupKernelSubscriptions(): void {
        const kinds: ContributionKind[] = [
            'slot',
            'floating',
            'component-wrapper',
            'panel',
            'settings-group',
            'settings',
            'action',
            'tool-factory',
            'resource-provider',
            'hook',
            'protocol',
            'protocol-middleware',
            'view',
            'navigation',
            'composer',
            'chat-renderer',
            'model-catalog',
        ]
        for (const kind of kinds) {
            const un = this.kernelRegistry.subscribe(kind, () => {
                this.invalidateCaches(kind)
                this.notifyKind(kind)
            })
            this.unsubs.push(un)
        }
    }

    private invalidateCaches(kind?: ContributionKind | string): void {
        if (!kind || kind === 'slot') {
            this.cachedSlots.clear()
        }
        if (!kind || kind === 'floating') {
            this.cachedFloatings = null
        }
        if (!kind || kind === 'component-wrapper') {
            this.cachedComponentWrappers.clear()
        }
        if (!kind || kind === 'panel') {
            this.cachedPanelTabs = null
        }
        if (!kind || kind === 'settings-group') {
            this.cachedSettingsGroups = null
        }
        if (!kind || kind === 'settings') {
            this.cachedSettingsSections = null
        }
        if (!kind || kind === 'action') {
            this.cachedCommands = null
        }
        if (!kind || kind === 'tool-factory') {
            this.cachedAgentTools.clear()
            this.cachedToolFactories.clear()
        }
        if (!kind || kind === 'resource-provider') {
            this.cachedResourceProviders.clear()
            this.cachedSystemPrompts.clear()
        }
        if (!kind || kind === 'hook') {
            this.cachedHookContributions.clear()
            this.cachedSystemPrompts.clear()
        }
        if (!kind || kind === 'protocol') {
            this.cachedProtocolProviders = null
        }
        if (!kind || kind === 'protocol-middleware') {
            this.cachedProtocolMiddlewares = null
        }
        if (!kind || kind === 'composer') {
            this.cachedComposerControls.clear()
            this.cachedAttachmentProviders = null
            this.cachedSubmitPreprocessors = null
        }
        if (!kind || kind === 'chat-renderer') {
            this.cachedChatRenderers = null
        }
        if (!kind || kind === 'model-catalog') {
            this.cachedModelCatalogProviders = null
        }
    }

    /**
     * Clear all contributions and listeners (primarily for testing teardown).
     */
    clear(): void {
        this.directDisposers.clear()
        this.listeners.clear()
        this.kernelRegistry.clear()
        this.invalidateCaches()
    }

    private notifyKind(kind: ContributionKind, target?: string): void {
        this.invalidateCaches(kind)

        // Notify kind directly
        this.notifyKey(kind)

        // Notify mapped alias keys
        if (kind === 'settings-group') {
            this.notifyKey('settings.groups')
        } else if (kind === 'settings') {
            this.notifyKey('settings.sections')
        } else if (kind === 'floating') {
            this.notifyKey('floatings')
        } else if (kind === 'panel') {
            this.notifyKey('panelTabs')
        } else if (kind === 'hook') {
            this.notifyKey('systemPrompts')
        } else if (kind === 'action') {
            this.notifyKey('commands')
        } else if (kind === 'tool-factory') {
            this.notifyKey('agentTools')
        } else if (kind === 'resource-provider') {
            this.notifyKey('resourceProviders')
            this.notifyKey('resource-provider')
        } else if (kind === 'protocol') {
            this.notifyKey('protocolProviders')
        } else if (kind === 'protocol-middleware') {
            this.notifyKey('protocolMiddlewares')
        } else if (kind === 'composer') {
            this.notifyKey('composer.controls')
            this.notifyKey('composer.attachments')
            this.notifyKey('composer.preprocessors')
        } else if (kind === 'chat-renderer') {
            this.notifyKey('chat.renderers')
            this.notifyKey('chat-renderer')
        } else if (kind === 'model-catalog') {
            this.notifyKey('modelCatalogProviders')
            this.notifyKey('model-catalog')
        }

        if (kind === 'slot') {
            const notifiedKeys = new Set<string>()
            if (target) {
                notifiedKeys.add(target)
                notifiedKeys.add(`slot:${target}`)
            } else {
                for (const key of Array.from(this.listeners.keys())) {
                    if (key.startsWith('slot:')) {
                        notifiedKeys.add(key)
                    } else if (
                        !NON_SLOT_EXACT_KEYS.has(key) &&
                        !NON_SLOT_PREFIXES.some((p) => key.startsWith(p))
                    ) {
                        notifiedKeys.add(key)
                    }
                }
            }
            for (const key of notifiedKeys) {
                this.notifyKey(key)
            }
        } else if (kind === 'component-wrapper') {
            const notifiedKeys = new Set<string>()
            if (target) {
                notifiedKeys.add(target)
                notifiedKeys.add(`component-wrapper:${target}`)
                notifiedKeys.add(`componentWrapper:${target}`)
            } else {
                for (const key of Array.from(this.listeners.keys())) {
                    if (
                        key.startsWith('componentWrapper:') ||
                        key.startsWith('component-wrapper:')
                    ) {
                        notifiedKeys.add(key)
                    }
                }
                const registeredWrappers = this.kernelRegistry.list('component-wrapper')
                for (const item of registeredWrappers) {
                    if (item.target && this.listeners.has(item.target)) {
                        notifiedKeys.add(item.target)
                    }
                }
            }
            for (const key of notifiedKeys) {
                this.notifyKey(key)
            }
        } else if (target) {
            this.notifyKey(target)
            this.notifyKey(`${kind}:${target}`)
        }
    }

    private notifyKey(key: string): void {
        const listeners = this.listeners.get(key)
        if (listeners) {
            for (const listener of Array.from(listeners)) {
                try {
                    listener()
                } catch (err) {
                    console.error(`[RendererRegistry] Listener error on key "${key}":`, err)
                }
            }
        }
    }

    /**
     * Subscribe to changes for a specific contribution kind or custom key.
     */
    subscribe(keyOrKind: string, listener: () => void): () => void {
        let set = this.listeners.get(keyOrKind)
        if (!set) {
            set = new Set()
            this.listeners.set(keyOrKind, set)
        }
        set.add(listener)

        return () => {
            set?.delete(listener)
            if (set && set.size === 0) {
                this.listeners.delete(keyOrKind)
            }
        }
    }

    // ==========================================
    // Typed Query / Selector Methods
    // ==========================================

    /**
     * List slot contributions registered for a specific slot name.
     */
    getSlotContributions<P = Record<string, unknown>>(slotName: string): SlotContribution<P>[] {
        const cached = this.cachedSlots.get(slotName)
        if (cached) {
            return cached as SlotContribution<P>[]
        }

        const items = this.kernelRegistry.list<SlotContribution<P>>('slot', slotName)
        const result = Object.freeze(
            items.map((item) => {
                const raw = item.value as any
                return {
                    id: item.id,
                    pluginId: raw?.pluginId ?? item.owner.id,
                    order: item.priority ?? raw?.order ?? 100,
                    component: raw?.component ?? raw,
                    visible: raw?.visible,
                }
            })
        )
        this.cachedSlots.set(slotName, result)
        return result as SlotContribution<P>[]
    }

    /**
     * List all registered floating overlay contributions.
     */
    getFloatings<P = Record<string, unknown>>(): FloatingContribution<P>[] {
        if (this.cachedFloatings) {
            return this.cachedFloatings as FloatingContribution<P>[]
        }

        const items = this.kernelRegistry.list<FloatingContribution<P>>('floating')
        this.cachedFloatings = Object.freeze(
            items.map((item) => {
                const raw = item.value as any
                return {
                    id: item.id,
                    pluginId: raw?.pluginId ?? item.owner.id,
                    order: item.priority ?? raw?.order ?? 100,
                    anchor: raw?.anchor,
                    placement: raw?.placement,
                    offset: raw?.offset,
                    component: raw?.component ?? raw,
                    visible: raw?.visible,
                }
            })
        )
        return this.cachedFloatings as FloatingContribution<P>[]
    }

    /**
     * List component wrapper contributions for a specific target component name.
     */
    getComponentWrappers<P extends object = Record<string, unknown>>(
        targetComponent: string
    ): ComponentWrapperContribution<P>[] {
        const cached = this.cachedComponentWrappers.get(targetComponent)
        if (cached) {
            return cached as ComponentWrapperContribution<P>[]
        }

        const items = this.kernelRegistry.list<ComponentWrapperContribution<P>>(
            'component-wrapper',
            targetComponent
        )
        const result = Object.freeze(
            items.map((item) => {
                const raw = item.value as any
                return {
                    id: item.id,
                    pluginId: raw?.pluginId ?? item.owner.id,
                    targetComponent: item.target ?? raw?.targetComponent ?? targetComponent,
                    order: item.priority ?? raw?.order ?? 100,
                    wrapper: raw?.wrapper ?? raw,
                }
            })
        )
        this.cachedComponentWrappers.set(targetComponent, result)
        return result as ComponentWrapperContribution<P>[]
    }

    /**
     * List panel contributions for the right sidebar.
     */
    getPanels<P = unknown>(): PanelContribution<P>[] {
        if (this.cachedPanelTabs) {
            return this.cachedPanelTabs as PanelContribution<P>[]
        }

        const items = this.kernelRegistry.list<PanelContribution<P>>('panel')
        const mapped = items.map((item) => {
            const raw = item.value as any
            return {
                id: item.id,
                pluginId: raw?.pluginId ?? item.owner?.id,
                order: item.priority ?? raw?.order ?? 100,
                title: raw?.title,
                titleKey: raw?.titleKey,
                icon: raw?.icon,
                component: raw?.component ?? raw,
                preferredWidth: raw?.preferredWidth,
                instancePolicy: raw?.instancePolicy ?? 'single',
                isAvailable: raw?.isAvailable ?? raw?.isEnabled,
                hasOpenTabs: raw?.hasOpenTabs,
                onOpen: raw?.onOpen,
                onClose: raw?.onClose,
                headerActionsComponent: raw?.headerActionsComponent,
                closable: raw?.closable,
                selectionCard: raw?.selectionCard,
                shortcut: raw?.shortcut,
                isEnabled: raw?.isEnabled,
                getDynamicTitle: raw?.getDynamicTitle,
                getDynamicIcon: raw?.getDynamicIcon,
            }
        })
        mapped.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
        this.cachedPanelTabs = Object.freeze(mapped)
        return this.cachedPanelTabs as PanelContribution<P>[]
    }

    /**
     * List panel tab contributions for the right sidebar (alias of getPanels).
     */
    getPanelTabs<P = Record<string, unknown>>(): PanelTabContribution<P>[] {
        return this.getPanels<P>() as PanelTabContribution<P>[]
    }

    /**
     * Find a panel contribution by ID.
     */
    getPanel<P = unknown>(id: string): PanelContribution<P> | undefined {
        return this.getPanels<P>().find((tab) => tab.id === id)
    }

    /**
     * Find a panel tab contribution by ID (alias of getPanel).
     */
    getPanelTab<P = Record<string, unknown>>(id: string): PanelTabContribution<P> | undefined {
        return this.getPanel<P>(id) as PanelTabContribution<P> | undefined
    }

    /**
     * Clear all panels.
     */
    clearPanels(): void {
        const panels = this.getPanels()
        for (const panel of panels) {
            this.unregisterPanel(panel.id)
        }
    }

    /**
     * Clear all panel tabs.
     */
    clearPanelTabs(): void {
        this.clearPanels()
    }

    /**
     * List all settings group contributions.
     */
    getSettingsGroups(): SettingsGroupContribution[] {
        if (this.cachedSettingsGroups) {
            return this.cachedSettingsGroups as SettingsGroupContribution[]
        }

        const items = this.kernelRegistry.list<SettingsGroupContribution>('settings-group')
        this.cachedSettingsGroups = Object.freeze(
            items.map((item) => {
                const raw = item.value as any
                return {
                    id: item.id,
                    order: item.priority ?? raw?.order ?? 100,
                    labelKey: raw?.labelKey ?? item.id,
                }
            })
        )
        return this.cachedSettingsGroups as SettingsGroupContribution[]
    }

    /**
     * List all settings section contributions.
     */
    getSettingsSections(): SettingsSectionContribution[] {
        if (this.cachedSettingsSections) {
            return this.cachedSettingsSections as SettingsSectionContribution[]
        }

        const items = this.kernelRegistry.list<SettingsSectionContribution>('settings')
        this.cachedSettingsSections = Object.freeze(
            items.map((item) => {
                const raw = item.value as any
                return {
                    id: item.id,
                    labelKey: raw?.labelKey ?? item.id,
                    icon: raw?.icon,
                    order: item.priority ?? raw?.order ?? 100,
                    component: raw?.component ?? raw,
                    groupId: raw?.groupId,
                    keywords: raw?.keywords,
                    items: raw?.items,
                }
            })
        )
        return this.cachedSettingsSections as SettingsSectionContribution[]
    }

    /**
     * List all command contributions.
     */
    getCommands(): CommandContribution[] {
        if (this.cachedCommands) {
            return this.cachedCommands as CommandContribution[]
        }

        const items = this.kernelRegistry.list<CommandContribution>('action')
        this.cachedCommands = Object.freeze(
            items.map((item) => {
                const raw = item.value as any
                return {
                    id: item.id,
                    title: raw?.title ?? item.id,
                    category: raw?.category,
                    keybinding: raw?.keybinding,
                    handler: raw?.handler ?? raw,
                }
            })
        )
        return this.cachedCommands as CommandContribution[]
    }

    /**
     * Find a command contribution by ID.
     */
    getCommand(id: string): CommandContribution | undefined {
        return this.getCommands().find((cmd) => cmd.id === id)
    }

    /**
     * List tool factory contributions, optionally filtered by agent scope.
     */
    getToolFactories(targetAgent: AgentTarget = 'all'): readonly ToolFactoryContribution[] {
        const cached = this.cachedToolFactories.get(targetAgent)
        if (cached) {
            return cached
        }

        const items = this.kernelRegistry.list('tool-factory')
        const factories: ToolFactoryContribution[] = []
        for (const item of items) {
            const val = item.value as any
            if (typeof val?.create === 'function') {
                factories.push({
                    id: val.id ?? item.id,
                    name: val.name ?? val.descriptor?.name ?? val.id ?? item.id,
                    label: val.label ?? val.descriptor?.label,
                    description: val.description ?? val.descriptor?.description,
                    parameters: val.parameters ?? val.descriptor?.parameters,
                    metadata: val.metadata ?? val.descriptor?.metadata,
                    descriptor: val.descriptor,
                    order: item.priority ?? val.order ?? 100,
                    targets: val.targets ?? ['all'],
                    riskLevel: (val.riskLevel as ToolRiskLevel) ?? 'read',
                    requiresApproval: Boolean(val.requiresApproval),
                    approvalCategory: val.approvalCategory,
                    requiresScheduledSession:
                        val.requiresScheduledSession ?? val.descriptor?.requiresScheduledSession,
                    aliases: val.aliases,
                    create: val.create,
                })
            }
        }

        factories.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))

        const filtered =
            targetAgent === 'all'
                ? factories
                : factories.filter((f) =>
                      !f.targets || f.targets.includes('all') || f.targets.includes(targetAgent)
                  )

        const result = Object.freeze(filtered)
        this.cachedToolFactories.set(targetAgent, result)
        return result
    }

    /**
     * Find a tool factory contribution by ID or alias.
     */
    getToolFactory(idOrName: string): ToolFactoryContribution | undefined {
        return this.getToolFactories('all').find(
            (f) => f.id === idOrName || f.aliases?.includes(idOrName)
        )
    }

    /**
     * List agent tool contributions, optionally filtered by agent scope.
     * Uses static descriptors from ToolFactoryContribution without invoking async create().
     */
    getAgentTools(targetAgent: AgentTarget = 'all'): AgentToolContribution[] {
        const cached = this.cachedAgentTools.get(targetAgent)
        if (cached) {
            return cached as AgentToolContribution[]
        }

        const items = this.kernelRegistry.list('tool-factory')
        const tools: AgentToolContribution[] = []
        for (const item of items) {
            const raw = item.value as any
            if (typeof raw?.create === 'function') {
                let name = raw.name ?? raw.descriptor?.name ?? item.id
                let description = raw.description ?? raw.descriptor?.description ?? ''
                let parameters = raw.parameters ?? raw.descriptor?.parameters
                let itemTargetAgent = (raw.targetAgent ??
                    raw.descriptor?.targetAgent ??
                    raw.targets?.[0] ??
                    'all') as AgentTarget

                // If description/parameters were not statically declared on the factory,
                // check if create() can be called synchronously (for legacy in-memory plugins)
                if (!description || !parameters) {
                    try {
                        const syncCreated = raw.create({ platform: 'darwin', services: {} as any })
                        if (syncCreated && typeof syncCreated === 'object' && !(syncCreated instanceof Promise)) {
                            if (!description && syncCreated.description) {
                                description = syncCreated.description
                            }
                            if (!parameters && syncCreated.parameters) {
                                parameters = syncCreated.parameters
                            }
                            if (syncCreated.targetAgent && !raw.targetAgent && !raw.descriptor?.targetAgent) {
                                itemTargetAgent = syncCreated.targetAgent
                            }
                        }
                    } catch {
                        // Ignore
                    }
                }
                if (!parameters) {
                    parameters = { type: 'object', properties: {} }
                }

                tools.push({
                    name,
                    description,
                    parameters,
                    targetAgent: itemTargetAgent,
                    requiresScheduledSession:
                        raw.requiresScheduledSession ?? raw.descriptor?.requiresScheduledSession,
                    execute: async (args: Record<string, unknown>, context: unknown) => {
                        const created = await raw.create(
                            (context ?? { platform: 'darwin', services: {} }) as any,
                        )
                        if (created && typeof created.execute === 'function') {
                            const res = await created.execute('call', args, (context ?? {}) as any)
                            if (res && typeof res === 'object' && Array.isArray((res as any).content)) {
                                const textBlock = (res as any).content.find((b: any) => b.type === 'text')
                                if (textBlock) {
                                    return textBlock.text
                                }
                            }
                            return res
                        }
                        return undefined
                    },
                })
            } else if (raw && typeof raw?.execute === 'function') {
                tools.push(raw as AgentToolContribution)
            }
        }

        const filtered =
            targetAgent === 'all'
                ? tools
                : tools.filter((tool) => (tool.targetAgent ?? 'all') === 'all' || tool.targetAgent === targetAgent)

        const result = Object.freeze(filtered)
        this.cachedAgentTools.set(targetAgent, result)
        return result as AgentToolContribution[]
    }

    /**
     * Find an agent tool contribution by name.
     */
    getAgentTool(name: string): AgentToolContribution | undefined {
        return this.getAgentTools('all').find((t) => t.name === name)
    }

    /**
     * List system prompt contributions, optionally filtered by agent scope.
     */
    getSystemPrompts(targetAgent: AgentTarget = 'all'): SystemPromptContribution[] {
        const cached = this.cachedSystemPrompts.get(targetAgent)
        if (cached) {
            return cached as SystemPromptContribution[]
        }

        const hookItems = this.kernelRegistry.list<any>('hook').filter((item) => typeof item.value?.execute !== 'function')
        const resourceItems = this.kernelRegistry.list<any>('resource-provider').filter((item) => typeof item.value?.execute !== 'function' && (item.value?.content || item.value?.guideline))
        const items = [...hookItems, ...resourceItems]
        const prompts = items
            .filter((item) => typeof (item.value as any)?.execute !== 'function')
            .map((item) => {
                const raw = item.value as any
                return {
                    id: item.id,
                    pluginId: raw?.pluginId ?? item.owner.id,
                    targetAgent: raw?.targetAgent,
                    guideline: raw?.guideline,
                    content: raw?.content,
                    order: item.priority ?? raw?.order ?? 100,
                } as SystemPromptContribution
            })

        const filtered =
            targetAgent === 'all'
                ? prompts
                : prompts.filter((p) => (p.targetAgent ?? 'all') === 'all' || p.targetAgent === targetAgent)

        const result = Object.freeze(filtered)
        this.cachedSystemPrompts.set(targetAgent, result)
        return result as SystemPromptContribution[]
    }

    /**
     * List resource provider contributions, optionally filtered by kind and agent scope.
     */
    getResourceProviders<T = unknown>(
        kind?: ResourceKind,
        targetAgent: AgentTarget = 'all'
    ): readonly ResourceProvider<T>[] {
        const cacheKey = `${kind ?? '__all__'}:${targetAgent}`
        const cached = this.cachedResourceProviders.get(cacheKey)
        if (cached) {
            return cached as readonly ResourceProvider<T>[]
        }

        const items = this.kernelRegistry.list('resource-provider')
        const providers: ResourceProvider<T>[] = []
        for (const item of items) {
            const val = item.value as any
            if (typeof val?.load === 'function') {
                providers.push({
                    id: val.id ?? item.id,
                    kind: val.kind ?? 'context',
                    order: item.priority ?? val.order ?? 100,
                    targetAgent: val.targetAgent,
                    load: val.load,
                })
            }
        }

        providers.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))

        let filtered = providers
        if (kind) {
            filtered = filtered.filter((p) => p.kind === kind)
        }
        if (targetAgent !== 'all') {
            filtered = filtered.filter(
                (p) => !p.targetAgent || p.targetAgent === 'all' || p.targetAgent === targetAgent
            )
        }

        const result = Object.freeze(filtered)
        this.cachedResourceProviders.set(cacheKey, result)
        return result as readonly ResourceProvider<T>[]
    }

    /**
     * Find a resource provider contribution by ID.
     */
    getResourceProvider<T = unknown>(id: string): ResourceProvider<T> | undefined {
        return this.getResourceProviders<T>().find((p) => p.id === id)
    }

    /**
     * List protocol provider contributions.
     */
    getProtocolProviders(): ProtocolProvider[] {
        if (this.cachedProtocolProviders) {
            return this.cachedProtocolProviders as ProtocolProvider[]
        }

        const items = this.kernelRegistry.list<ProtocolProvider>('protocol')
        this.cachedProtocolProviders = Object.freeze(items.map((item) => item.value as ProtocolProvider))
        return this.cachedProtocolProviders as ProtocolProvider[]
    }

    /**
     * Find a protocol provider by ID, or return latest registered default provider if ID omitted.
     */
    getProtocolProvider(id?: string): ProtocolProvider | undefined {
        if (id) {
            return this.kernelRegistry.get<ProtocolProvider>('protocol', id)
        }
        const providers = this.getProtocolProviders()
        for (let i = providers.length - 1; i >= 0; i--) {
            if (providers[i].isDefault) {
                return providers[i]
            }
        }
        return providers[0]
    }

    /**
     * List protocol middleware contributions.
     */
    getProtocolMiddlewares(): ProtocolMiddleware[] {
        if (this.cachedProtocolMiddlewares) {
            return this.cachedProtocolMiddlewares as ProtocolMiddleware[]
        }

        const items = this.kernelRegistry.list<ProtocolMiddleware>('protocol-middleware')
        this.cachedProtocolMiddlewares = Object.freeze(items.map((item) => item.value as ProtocolMiddleware))
        return this.cachedProtocolMiddlewares as ProtocolMiddleware[]
    }

    /**
     * List composer control contributions, optionally filtered by placement.
     */
    getComposerControls(
        placement?: 'context' | 'toolbar-left' | 'toolbar-right'
    ): ComposerControlContribution[] {
        const cacheKey = placement ?? '__all__'
        const cached = this.cachedComposerControls.get(cacheKey)
        if (cached) {
            return cached as ComposerControlContribution[]
        }

        const items = this.kernelRegistry.list<ComposerControlContribution>('composer')
        const controls = items
            .filter((item) => {
                const raw = item.value as any
                const target = item.target
                return (
                    (target && target.startsWith('control')) ||
                    raw?.placement !== undefined
                )
            })
            .map((item) => {
                const raw = item.value as any
                return {
                    id: item.id,
                    pluginId: raw?.pluginId ?? item.owner?.id,
                    placement: raw?.placement ?? (item.target?.replace('control:', '') as any) ?? 'context',
                    order: item.priority ?? raw?.order ?? 100,
                    component: raw?.component ?? raw,
                    isAvailable: raw?.isAvailable,
                } as ComposerControlContribution
            })

        let filtered = controls
        if (placement) {
            filtered = controls.filter((c) => c.placement === placement)
            filtered.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
        } else {
            const placementWeight: Record<string, number> = {
                context: 1,
                'toolbar-left': 2,
                'toolbar-right': 3,
            }
            filtered.sort((a, b) => {
                const wA = placementWeight[a.placement] ?? 99
                const wB = placementWeight[b.placement] ?? 99
                if (wA !== wB) return wA - wB
                return (a.order ?? 100) - (b.order ?? 100)
            })
        }

        const result = Object.freeze(filtered)
        this.cachedComposerControls.set(cacheKey, result)
        return result as ComposerControlContribution[]
    }

    /**
     * Find a composer control by ID.
     */
    getComposerControl(id: string): ComposerControlContribution | undefined {
        return this.getComposerControls().find((ctrl) => ctrl.id === id)
    }

    /**
     * List all attachment providers.
     */
    getAttachmentProviders(): AttachmentProvider[] {
        if (this.cachedAttachmentProviders) {
            return this.cachedAttachmentProviders as AttachmentProvider[]
        }

        const items = this.kernelRegistry.list<AttachmentProvider>('composer', 'attachment')
        const fallbackItems =
            items.length > 0
                ? items
                : this.kernelRegistry
                      .list<AttachmentProvider>('composer')
                      .filter((i) => (i.value as any)?.select)
        const mapped = fallbackItems.map((item) => {
            const raw = item.value as any
            return {
                id: item.id,
                order: item.priority ?? raw?.order ?? 100,
                label: raw?.label ?? item.id,
                labelKey: raw?.labelKey,
                description: raw?.description,
                descKey: raw?.descKey,
                icon: raw?.icon,
                submenu: raw?.submenu,
                select: raw?.select ?? (typeof raw === 'function' ? raw : undefined),
            } as AttachmentProvider
        })
        mapped.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
        this.cachedAttachmentProviders = Object.freeze(mapped)
        return this.cachedAttachmentProviders as AttachmentProvider[]
    }

    /**
     * Find an attachment provider by ID.
     */
    getAttachmentProvider(id: string): AttachmentProvider | undefined {
        return this.getAttachmentProviders().find((p) => p.id === id)
    }

    /**
     * List all submit preprocessors.
     */
    getSubmitPreprocessors(): ComposerSubmitPreprocessorContribution[] {
        if (this.cachedSubmitPreprocessors) {
            return this.cachedSubmitPreprocessors as ComposerSubmitPreprocessorContribution[]
        }

        const items = this.kernelRegistry.list<ComposerSubmitPreprocessorContribution>(
            'composer',
            'submit-preprocessor'
        )
        const fallbackItems =
            items.length > 0
                ? items
                : this.kernelRegistry
                      .list<ComposerSubmitPreprocessorContribution>('composer')
                      .filter((i) => (i.value as any)?.preprocess)
        const mapped = fallbackItems.map((item) => {
            const raw = item.value as any
            return {
                id: item.id,
                order: item.priority ?? raw?.order ?? 100,
                preprocess: raw?.preprocess ?? raw,
            } as ComposerSubmitPreprocessorContribution
        })
        mapped.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
        this.cachedSubmitPreprocessors = Object.freeze(mapped)
        return this.cachedSubmitPreprocessors as ComposerSubmitPreprocessorContribution[]
    }

    /**
     * Find a submit preprocessor by ID.
     */
    getSubmitPreprocessor(id: string): ComposerSubmitPreprocessorContribution | undefined {
        return this.getSubmitPreprocessors().find((p) => p.id === id)
    }

    // ==========================================
    // Direct / Imperative Registration Helpers
    // ==========================================

    private registerDirect<T>(
        kind: ContributionKind,
        id: string,
        value: T,
        target?: string,
        priority: number = 100
    ): () => void {
        const key = `${kind}:${target ?? ''}:${id}`
        const existingDisposer = this.directDisposers.get(key)
        if (existingDisposer) {
            existingDisposer()
        }

        const tx = this.kernelRegistry.beginActivation(DIRECT_OWNER)
        tx.register(kind, id, value, { target, priority })
        const disposers = tx.commit()

        const disposerFn = () => {
            for (const d of disposers) {
                try {
                    d()
                } catch {
                    // Ignore disposer error
                }
            }
            this.directDisposers.delete(key)
        }

        this.directDisposers.set(key, disposerFn)

        return disposerFn
    }

    registerSlot<P = Record<string, unknown>>(
        slotName: string,
        contribution: SlotContribution<P>
    ): () => void {
        return this.registerDirect(
            'slot',
            contribution.id,
            contribution,
            slotName,
            contribution.order ?? 100
        )
    }

    unregisterSlot(slotName: string, id: string): void {
        const key = `slot:${slotName}:${id}`
        const disposer = this.directDisposers.get(key)
        if (disposer) {
            disposer()
        }
    }

    registerFloating<P = Record<string, unknown>>(
        contribution: FloatingContribution<P>
    ): () => void {
        return this.registerDirect(
            'floating',
            contribution.id,
            contribution,
            undefined,
            contribution.order ?? 100
        )
    }

    unregisterFloating(id: string): void {
        const key = `floating::${id}`
        const disposer = this.directDisposers.get(key)
        if (disposer) {
            disposer()
        }
    }

    registerComponentWrapper<P extends object = Record<string, unknown>>(
        contribution: ComponentWrapperContribution<P>
    ): () => void {
        return this.registerDirect(
            'component-wrapper',
            contribution.id,
            contribution,
            contribution.targetComponent,
            contribution.order ?? 100
        )
    }

    unregisterComponentWrapper(targetComponent: string, id: string): void {
        const key = `component-wrapper:${targetComponent}:${id}`
        const disposer = this.directDisposers.get(key)
        if (disposer) {
            disposer()
        }
    }

    registerPanel<P = unknown>(
        contribution: PanelContribution<P>
    ): () => void {
        return this.registerDirect(
            'panel',
            contribution.id,
            contribution,
            undefined,
            contribution.order ?? 100
        )
    }

    unregisterPanel(id: string): void {
        const key = `panel::${id}`
        const disposer = this.directDisposers.get(key)
        if (disposer) {
            disposer()
        }
    }

    registerPanelTab<P = Record<string, unknown>>(
        contribution: PanelTabContribution<P>
    ): () => void {
        return this.registerPanel(contribution)
    }

    unregisterPanelTab(id: string): void {
        this.unregisterPanel(id)
    }

    registerSettingsGroup(contribution: SettingsGroupContribution): () => void {
        return this.registerDirect(
            'settings-group',
            contribution.id,
            contribution,
            undefined,
            contribution.order ?? 100
        )
    }

    unregisterSettingsGroup(id: string): void {
        const key = `settings-group::${id}`
        const disposer = this.directDisposers.get(key)
        if (disposer) {
            disposer()
        }
    }

    registerSettingsSection(contribution: SettingsSectionContribution): () => void {
        return this.registerDirect(
            'settings',
            contribution.id,
            contribution,
            undefined,
            contribution.order ?? 100
        )
    }

    unregisterSettingsSection(id: string): void {
        const key = `settings::${id}`
        const disposer = this.directDisposers.get(key)
        if (disposer) {
            disposer()
        }
    }

    registerCommand(contribution: CommandContribution): () => void {
        return this.registerDirect('action', contribution.id, contribution, undefined, 100)
    }

    unregisterCommand(id: string): void {
        const key = `action::${id}`
        const disposer = this.directDisposers.get(key)
        if (disposer) {
            disposer()
        }
    }

    registerAgentTool(contribution: AgentToolContribution): () => void {
        return this.registerDirect('tool-factory', contribution.name, contribution, undefined, 100)
    }

    unregisterAgentTool(name: string): void {
        const key = `tool-factory::${name}`
        const disposer = this.directDisposers.get(key)
        if (disposer) {
            disposer()
        }
    }

    registerToolFactory(contribution: ToolFactoryContribution): () => void {
        return this.registerDirect(
            'tool-factory',
            contribution.id,
            contribution,
            undefined,
            contribution.order ?? 100
        )
    }

    unregisterToolFactory(id: string): void {
        const key = `tool-factory::${id}`
        const disposer = this.directDisposers.get(key)
        if (disposer) {
            disposer()
        }
    }


    /**
     * List hook contributions, optionally filtered by event name.
     */
    getHookContributions(event?: HookEventName): readonly HookContribution[] {
        const cacheKey = event ?? '__all__'
        const cached = this.cachedHookContributions.get(cacheKey)
        if (cached) {
            return cached
        }

        const items = this.kernelRegistry.list('hook')
        const hooks: HookContribution[] = []
        for (const item of items) {
            const val = item.value as any
            if (typeof val?.execute === 'function') {
                hooks.push({
                    id: val.id ?? item.id,
                    event: val.event ?? item.target,
                    order: item.priority ?? val.order ?? 100,
                    failureMode: val.failureMode ?? 'open',
                    execute: val.execute,
                })
            }
        }

        hooks.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))

        const filtered = event ? hooks.filter((h) => h.event === event) : hooks
        const result = Object.freeze(filtered)
        this.cachedHookContributions.set(cacheKey, result)
        return result
    }

    /**
     * Register a hook contribution.
     */
    registerHook(contribution: HookContribution): () => void {
        return this.registerDirect(
            'hook',
            contribution.id,
            contribution,
            contribution.event,
            contribution.order ?? 100
        )
    }

    /**
     * Unregister a hook contribution.
     */
    unregisterHook(id: string): void {
        for (const [key, disposer] of Array.from(this.directDisposers.entries())) {
            if (key.startsWith('hook:') && key.endsWith(`:${id}`)) {
                disposer()
            }
        }
        const directKey = `hook::${id}`
        const directDisposer = this.directDisposers.get(directKey)
        if (directDisposer) {
            directDisposer()
        }
    }

    registerSystemPrompt(contribution: SystemPromptContribution): () => void {
        return this.registerDirect(
            'hook',
            contribution.id,
            contribution,
            undefined,
            contribution.order ?? 100
        )
    }

    unregisterSystemPrompt(id: string): void {
        const key = `hook::${id}`
        const disposer = this.directDisposers.get(key)
        if (disposer) {
            disposer()
        }
    }

    registerResourceProvider<T = unknown>(provider: ResourceProvider<T>): () => void {
        return this.registerDirect(
            'resource-provider',
            provider.id,
            provider,
            undefined,
            provider.order ?? 100
        )
    }

    unregisterResourceProvider(id: string): void {
        const key = `resource-provider::${id}`
        const disposer = this.directDisposers.get(key)
        if (disposer) {
            disposer()
        }
    }

    registerProtocolProvider(provider: ProtocolProvider): () => void {
        return this.registerDirect('protocol', provider.id, provider, undefined, 100)
    }

    unregisterProtocolProvider(id: string): void {
        const key = `protocol::${id}`
        const disposer = this.directDisposers.get(key)
        if (disposer) {
            disposer()
        }
    }

    registerProtocolMiddleware(middleware: ProtocolMiddleware): () => void {
        return this.registerDirect(
            'protocol-middleware',
            middleware.id,
            middleware,
            undefined,
            middleware.order ?? 100
        )
    }

    unregisterProtocolMiddleware(id: string): void {
        const key = `protocol-middleware::${id}`
        const disposer = this.directDisposers.get(key)
        if (disposer) {
            disposer()
        }
    }

    registerComposerControl(contribution: ComposerControlContribution): () => void {
        return this.registerDirect(
            'composer',
            contribution.id,
            contribution,
            `control:${contribution.placement}`,
            contribution.order ?? 100
        )
    }

    unregisterComposerControl(id: string): void {
        for (const [key, disposer] of Array.from(this.directDisposers.entries())) {
            if (key.startsWith('composer:control:') && key.endsWith(`:${id}`)) {
                disposer()
            }
        }
    }

    registerAttachmentProvider(provider: AttachmentProvider): () => void {
        return this.registerDirect(
            'composer',
            provider.id,
            provider,
            'attachment',
            provider.order ?? 100
        )
    }

    unregisterAttachmentProvider(id: string): void {
        const key = `composer:attachment:${id}`
        const disposer = this.directDisposers.get(key)
        if (disposer) {
            disposer()
        }
    }

    registerSubmitPreprocessor(preprocessor: ComposerSubmitPreprocessorContribution): () => void {
        return this.registerDirect(
            'composer',
            preprocessor.id,
            preprocessor,
            'submit-preprocessor',
            preprocessor.order ?? 100
        )
    }

    unregisterSubmitPreprocessor(id: string): void {
        const key = `composer:submit-preprocessor:${id}`
        const disposer = this.directDisposers.get(key)
        if (disposer) {
            disposer()
        }
    }

    /**
     * List all chat renderer contributions sorted by priority.
     */
    getChatRenderers<T = unknown>(): readonly ChatRendererContribution<T>[] {
        if (this.cachedChatRenderers) {
            return this.cachedChatRenderers as readonly ChatRendererContribution<T>[]
        }

        const items = this.kernelRegistry.list<ChatRendererContribution<T>>('chat-renderer')
        const mapped = items.map((item) => {
            const raw = item.value as any
            const target = raw?.target ?? (item as any).target ?? raw?.scope ?? (item as any).scope
            const scope = raw?.scope ?? (item as any).scope ?? target
            const groupKey = raw?.groupKey ?? (item as any).groupKey
            return {
                id: item.id,
                pluginId: raw?.pluginId ?? item.owner?.id,
                priority: item.priority ?? raw?.priority ?? 100,
                target,
                scope,
                groupKey,
                matches: raw?.matches ?? (() => false),
                component: raw?.component ?? raw,
            } as ChatRendererContribution<T>
        })
        mapped.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
        this.cachedChatRenderers = Object.freeze(mapped)
        return this.cachedChatRenderers as readonly ChatRendererContribution<T>[]
    }

    /**
     * List all message renderer contributions (alias of getChatRenderers).
     */
    getMessageRenderers<T = unknown>(): readonly ChatRendererContribution<T>[] {
        return this.getChatRenderers<T>()
    }

    /**
     * Select the highest priority matching chat renderer for the given value.
     */
    selectChatRenderer<T = unknown>(
        value: T,
        options?: SelectChatRendererOptions,
    ): ChatRendererContribution<T> | undefined {
        const renderers = this.getChatRenderers<T>()
        return matchChatRenderer(renderers, value, options)
    }

    /**
     * Select the highest priority matching message renderer for the given message (alias of selectChatRenderer).
     */
    selectMessageRenderer<T = unknown>(
        message: T,
        options?: SelectChatRendererOptions,
    ): ChatRendererContribution<T> | undefined {
        return this.selectChatRenderer<T>(message, options)
    }

    /**
     * Register a chat renderer contribution.
     */
    registerChatRenderer<T = unknown>(contribution: ChatRendererContribution<T>): () => void {
        return this.registerDirect(
            'chat-renderer',
            contribution.id,
            contribution,
            undefined,
            contribution.priority ?? 100
        )
    }

    /**
     * Unregister a chat renderer contribution.
     */
    unregisterChatRenderer(id: string): void {
        const key = `chat-renderer::${id}`
        const disposer = this.directDisposers.get(key)
        if (disposer) {
            disposer()
        }
    }

    /**
     * Register a message renderer contribution (alias of registerChatRenderer).
     */
    registerMessageRenderer<T = unknown>(contribution: ChatRendererContribution<T>): () => void {
        return this.registerChatRenderer(contribution)
    }

    /**
     * Unregister a message renderer contribution (alias of unregisterChatRenderer).
     */
    unregisterMessageRenderer(id: string): void {
        this.unregisterChatRenderer(id)
    }

    /**
     * List model catalog provider contributions.
     */
    getModelCatalogProviders(): readonly ModelCatalogProviderContribution[] {
        if (this.cachedModelCatalogProviders) {
            return this.cachedModelCatalogProviders
        }

        const items = this.kernelRegistry.list<ModelCatalogProviderContribution>('model-catalog')
        this.cachedModelCatalogProviders = Object.freeze(
            items.map((item) => item.value as ModelCatalogProviderContribution)
        )
        return this.cachedModelCatalogProviders
    }

    /**
     * Find a model catalog provider by ID or protocolProviderId.
     */
    getModelCatalogProvider(id?: string): ModelCatalogProviderContribution | undefined {
        const providers = this.getModelCatalogProviders()
        if (id) {
            return providers.find((p) => p.id === id || p.protocolProviderId === id)
        }
        return providers[0]
    }

    /**
     * Register a model catalog provider contribution.
     */
    registerModelCatalogProvider(
        provider: ModelCatalogProviderContribution
    ): () => void {
        return this.registerDirect(
            'model-catalog',
            provider.id,
            provider,
            provider.protocolProviderId,
            100
        )
    }

    /**
     * Unregister a model catalog provider contribution.
     */
    unregisterModelCatalogProvider(id: string): void {
        const key = `model-catalog::${id}`
        const disposer = this.directDisposers.get(key)
        if (disposer) {
            disposer()
        }
        for (const [k, d] of Array.from(this.directDisposers.entries())) {
            if (k.startsWith('model-catalog:') && k.endsWith(`:${id}`)) {
                d()
            }
        }
    }
}

/**
 * Singleton authoritative renderer registry instance.
 */
export const rendererRegistry = new RendererRegistry()
