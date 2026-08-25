import type { ComponentType } from 'react'
import type { PluginIdentity } from './manifest.js'
import type { CapabilityId, CapabilityInvocationContext } from './capabilities.js'
import type { HostServices } from './services.js'
import type { ModelCatalogEntry, ToolResultContentBlock } from './protocol.js'

export type AgentTarget = 'main' | 'subagent' | 'all'

export type ContributionKind =
    | 'service'
    | 'rpc'
    | 'native-event'
    | 'route'
    | 'background-job'
    | 'storage'
    | 'lifecycle'
    | 'slot'
    | 'floating'
    | 'component-wrapper'
    | 'action'
    | 'view'
    | 'navigation'
    | 'settings-group'
    | 'settings'
    | 'panel'
    | 'composer'
    | 'chat-renderer'
    | 'tool-factory'
    | 'resource-provider'
    | 'hook'
    | 'protocol'
    | 'protocol-middleware'
    | 'model-catalog'

export type ContributionKey = `${ContributionKind}/${string}`
export type PluginContributionDeclarations = Partial<Record<ContributionKind, readonly string[]>>

export interface ContributionRegistration<T = unknown> {
    kind: ContributionKind
    id: string
    target?: string
    value: T
    priority?: number
}

export interface OwnedContribution<T = unknown> extends ContributionRegistration<T> {
    owner: PluginIdentity
    ownerToken: symbol
    registrationSequence: number
}

export interface RpcInvocationContext extends CapabilityInvocationContext {
    clientId?: string
}

export interface ServiceCreateContext {
    get<T>(serviceId: string): T
    capabilities: ReadonlySet<CapabilityId>
    getCapability<T>(capabilityId: CapabilityId): T
}

export interface RpcDescriptor {
    method: string
    aliases?: readonly string[]
    ipcChannel?: string
    capability: CapabilityId
    invoke(context: RpcInvocationContext, args: unknown[]): Promise<unknown>
}

export interface ServiceDescriptor<T = unknown> {
    id: string
    dependencies: readonly string[]
    create(context: ServiceCreateContext): T | Promise<T>
    dispose?(service: T): void | Promise<void>
}

export interface WebRouteRequest {
    method: string
    url: string
    headers: Readonly<Record<string, string | string[] | undefined>>
    body?: Uint8Array
}

export interface WebRouteResponse {
    status: number
    headers?: Readonly<Record<string, string>>
    body?: Uint8Array | string
}

export interface WebRouteContribution {
    id: string
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | '*'
    path: string
    order: number
    authenticate: boolean
    handle(context: WebRouteContext): Promise<WebRouteResponse>
}

export interface WebRouteContext {
    request: WebRouteRequest
    rpcContext: RpcInvocationContext
}

export interface PluginStorageTransaction {
    get<T>(key: string): T | undefined
    set<T>(key: string, value: T): void
    delete(key: string): void
}

export interface PluginStorageNamespace {
    get<T>(key: string): Promise<T | undefined>
    set<T>(key: string, value: T): Promise<void>
    delete(key: string): Promise<void>
    transaction<T>(run: (tx: PluginStorageTransaction) => T): Promise<T>
}

export interface PluginStorageContribution {
    openNamespace(pluginId: string, namespaceVersion: number): Promise<PluginStorageNamespace>
}

export interface ActionContext {
    services: HostServices
    pathname: string
    [key: string]: unknown
}

export interface ActionExecutionContext extends ActionContext {
    source: 'shortcut' | 'menu' | 'slash' | 'api'
    [key: string]: unknown
}

export interface ActionPlacement {
    surface: 'menu.user' | 'composer.slash' | 'titlebar' | 'sidebar' | (string & {})
    order: number
}

export interface ActionContribution {
    id: string
    title: string
    description?: string
    category?: string
    icon?: unknown
    handler(context: ActionExecutionContext): void | Promise<void>
    enabled?(context: ActionContext): boolean
    visible?(context: ActionContext): boolean
    defaultShortcuts?: readonly string[]
    placements?: readonly ActionPlacement[]
}

export interface SettingsGroupContribution {
    id: string
    order?: number
    labelKey: string
}

export interface SettingsSubItem {
    id: string
    labelKey: string
    descriptionKey?: string
    keywords?: readonly string[]
}

export interface SettingsSectionContribution {
    id: string
    groupId?: string
    order?: number
    labelKey: string
    icon?: ComponentType<any>
    component: ComponentType<any>
    keywords?: readonly string[]
    items?: readonly SettingsSubItem[]
}

export type RightPanelMode = 'default' | 'hidden' | 'scheduled'

export interface ViewLayout {
    showComposer: boolean
    rightPanelMode: RightPanelMode
    reserveWindowToolbar: boolean
}

export interface NavigationContribution {
    id: string
    viewId: string
    order: number
    labelKey: string
    icon: ComponentType<any>
    path?: string
}

export interface ViewContribution {
    id: string
    path: string
    component: ComponentType<any>
    layout: ViewLayout
}

export interface PanelContext {
    services: HostServices
    activeSessionId?: string
}

export interface PanelOpenContext extends PanelContext {
    instanceId: string
    params?: Record<string, unknown>
}

export type PanelCloseContext = PanelOpenContext

export interface PanelContribution<P = unknown> {
    id: string
    pluginId?: string
    title?: string
    titleKey?: string
    icon: ComponentType<any>
    component: ComponentType<P>
    order?: number
    preferredWidth?: number | ((context: PanelContext) => number | undefined)
    instancePolicy?: 'single' | 'multiple' | 'selection'
    isAvailable?(context: PanelContext): boolean
    hasOpenTabs?(sessionId?: string | null): boolean
    onOpen?(context: PanelOpenContext): void | Promise<void>
    onClose?(context: PanelCloseContext): void | Promise<void>
    selectionCard?: {
        labelKey?: string
        label?: string
        icon?: ComponentType<any>
        shortcutMac?: string
        shortcutOther?: string
        requiresProject?: boolean
        order?: number
    }
    shortcut?: {
        mac: string
        other: string
        keyEventMatch: (event: KeyboardEvent, context: { hasProject: boolean }) => boolean
    }
    headerActionsComponent?: ComponentType<{ sessionId?: string | null; active?: boolean }>
    closable?: boolean
    getDynamicTitle?: (params: Record<string, unknown>, context: Record<string, unknown>) => string | null
    getDynamicIcon?: (params: Record<string, unknown>, context: Record<string, unknown>) => ComponentType<any> | null
}

export interface ComposerControlProps {
    sessionId?: string | null
    disabled: boolean
    [key: string]: unknown
}

export interface AttachmentContext {
    projectPath?: string | null
    sessionId?: string | null
    [key: string]: unknown
}

export interface ComposerAttachment {
    id: string
    name: string
    path?: string
    kind?: string
    mimeType?: string
    data?: string
    width?: number
    height?: number
    [key: string]: unknown
}

export interface ComposerControlContribution {
    id: string
    placement: 'context' | 'toolbar-left' | 'toolbar-right'
    order: number
    component: ComponentType<ComposerControlProps>
    pluginId?: string
    isAvailable?(context: ComposerControlProps): boolean
}

export interface AttachmentProvider {
    id: string
    order: number
    label: string
    labelKey?: string
    description?: string
    descKey?: string
    icon?: ComponentType<any> | any
    select?(context: AttachmentContext): Promise<readonly ComposerAttachment[]>
}

export interface ComposerSubmitContext {
    sessionId?: string | null
    projectId?: string | null
    [key: string]: unknown
}

export interface ComposerSubmitPayload {
    text: string
    images?: readonly any[]
    attachments?: readonly ComposerAttachment[]
    [key: string]: unknown
}

export interface ComposerSubmitPreprocessorContribution {
    id: string
    order: number
    preprocess(
        payload: ComposerSubmitPayload,
        context?: ComposerSubmitContext
    ): Promise<ComposerSubmitPayload> | ComposerSubmitPayload
}

export type SubmitPreprocessorContribution = ComposerSubmitPreprocessorContribution

export type ChatRendererTarget = 'message' | 'part'

export interface ChatRendererContribution<T = unknown> {
    id: string
    priority?: number
    target?: ChatRendererTarget | string
    scope?: ChatRendererTarget | string
    groupKey?: string | ((value: T) => string | undefined)
    matches(value: T): boolean
    component: ComponentType<{ value: T; [key: string]: any }> | ComponentType<any>
    pluginId?: string
}



export interface ToolResult {
    content: ToolResultContentBlock[]
    details?: unknown
    isError?: boolean
    terminate?: boolean
}

export interface ToolExecutionContext {
    signal?: AbortSignal
    cwd?: string
    sessionId?: string
    onUpdate?: (partial: ToolResult) => void
    [key: string]: unknown
}

export interface AgentTool<TArgs extends Record<string, unknown> = Record<string, unknown>> {
    name: string
    label: string
    description: string
    parameters: Record<string, unknown>
    targetAgent?: AgentTarget
    requiresScheduledSession?: boolean
    validate(input: unknown): TArgs
    execute(
        toolCallId: string,
        args: TArgs,
        context: ToolExecutionContext,
    ): Promise<ToolResult>
}

export interface ToolFactoryContext {
    cwd?: string
    platform: 'darwin' | 'linux' | 'win32'
    services: HostServices
    [key: string]: unknown
}

export type ToolRiskLevel = 'read' | 'write' | 'process' | 'network' | 'session'

export interface ToolDescriptor {
    name: string
    label?: string
    description?: string
    parameters?: Record<string, unknown>
    targets?: readonly AgentTarget[]
    order?: number
    riskLevel?: ToolRiskLevel
    requiresApproval?: boolean
    approvalCategory?: string
    requiresScheduledSession?: boolean
    aliases?: readonly string[]
    metadata?: Record<string, unknown>
}

export interface ToolFactoryContribution {
    id: string
    order?: number
    targets?: readonly AgentTarget[]
    riskLevel?: ToolRiskLevel
    requiresApproval?: boolean
    approvalCategory?: string
    requiresScheduledSession?: boolean
    aliases?: readonly string[]
    name?: string
    label?: string
    description?: string
    parameters?: Record<string, unknown>
    metadata?: Record<string, unknown>
    descriptor?: ToolDescriptor
    create(context: ToolFactoryContext): Promise<AgentTool | null | undefined> | AgentTool | null | undefined
}

export type ResourceKind = 'context' | 'skill' | 'prompt-template' | 'system-prompt'

export interface ResourceProviderInput {
    cwd?: string
    projectPath?: string
    projectPaths?: readonly string[]
    sessionId?: string
    agentTarget: AgentTarget
    agentDir?: string
    homeDir?: string
    bridge?: unknown
    tools?: readonly unknown[]
    promptGuidelines?: readonly string[]
    language?: string
    personality?: string
    localMemoryEnabled?: boolean
    worktreePolicy?: unknown
    extensionRegistry?: unknown
    [key: string]: unknown
}

export interface ResourceProvider<T = unknown> {
    id: string
    kind: ResourceKind
    order: number
    targetAgent?: AgentTarget
    load(input: ResourceProviderInput): Promise<readonly T[]> | readonly T[]
}

export type HookEventName =
    | 'SessionStart'
    | 'UserPromptSubmit'
    | 'PreToolUse'
    | 'PermissionRequest'
    | 'PostToolUse'
    | 'PreCompact'
    | 'PostCompact'
    | 'SubagentStart'
    | 'SubagentStop'
    | 'Stop'
    | 'SessionEnd'

export interface HookInput {
    event: HookEventName
    sessionId: string
    payload: Record<string, unknown>
    cwd?: string
    signal?: AbortSignal
    [key: string]: unknown
}

export interface HookResult {
    continue: boolean
    message?: string
    stopReason?: string
    additionalContext?: string
    additionalContexts?: readonly string[]
    updatedInput?: unknown
    systemMessage?: string
    decision?: 'allow' | 'deny' | 'ask'
    permissionMode?: 'allow' | 'deny' | 'ask'
    [key: string]: unknown
}

export interface HookContribution {
    id: string
    event: HookEventName
    order: number
    failureMode: 'open' | 'closed'
    execute(input: HookInput): Promise<HookResult>
}

export interface ModelCapabilities {
    supportsImages?: boolean
    supportsFast?: boolean
    reasoningLevels?: readonly string[]
    contextWindow?: number
    maxOutputTokens?: number
    [key: string]: unknown
}

export interface ModelCatalogProviderContribution {
    id: string
    protocolProviderId: string
    fetchCatalog(config: unknown, transport?: unknown): Promise<readonly ModelCatalogEntry[]>
    getModelCapabilities(model: ModelCatalogEntry): ModelCapabilities
}

/**
 * UI placement options for floating overlay contributions.
 */
export type FloatingPlacement =
    | 'top-center'
    | 'top-start'
    | 'top-end'
    | 'bottom-center'
    | 'bottom-start'
    | 'bottom-end'
    | 'left-center'
    | 'right-center'
    | 'cover'
    | 'cover-bottom'

/**
 * Coordinate offsets for fine-tuning floating overlay position.
 */
export interface FloatingOffset {
    x?: number
    y?: number
}

/**
 * Floating overlay contribution anchored to a designated DOM target.
 */
export interface FloatingContribution<P = Record<string, unknown>> {
    id: string
    pluginId: string
    anchor: string
    placement?: FloatingPlacement
    offset?: FloatingOffset
    order?: number
    component: ComponentType<P>
    visible?: (context: Record<string, unknown>) => boolean
}

/**
 * Wrapper function that enhances or wraps a base component.
 */
export type ComponentWrapperFn<P extends object = Record<string, unknown>> = (
    BaseComponent: ComponentType<P>
) => ComponentType<P>

/**
 * Component wrapper contribution targeting a specific component identifier.
 */
export interface ComponentWrapperContribution<P extends object = Record<string, unknown>> {
    id: string
    pluginId: string
    targetComponent: string
    order?: number
    wrapper: ComponentWrapperFn<P>
}

/**
 * Panel tab contribution rendered in the right-sidebar panel.
 */
export interface PanelTabContribution<P = unknown> extends PanelContribution<P> {
    pluginId?: string
    isEnabled?: (context: {
        projectId?: string | null
        hasProject: boolean
        sessionId?: string | null
    }) => boolean
}

/**
 * UI contribution rendered into a designated slot.
 */
export interface SlotContribution<P = Record<string, unknown>> {
    id: string
    pluginId: string
    order?: number
    component: ComponentType<P>
    visible?: (context: Record<string, unknown>) => boolean
}

/**
 * Executable command contribution.
 */
export interface CommandContribution {
    id: string
    title: string
    category?: string
    keybinding?: string
    handler: (...args: unknown[]) => unknown | Promise<unknown>
}

/**
 * Agent tool contribution callable by LLM agent loop.
 */
export interface AgentToolContribution {
    name: string
    description: string
    parameters: Record<string, unknown>
    /** Explicit target agent scope (defaults to 'all' if omitted). */
    targetAgent?: AgentTarget
    /** If true, the tool is only provided in sessions created by scheduled tasks (scheduleId present). */
    requiresScheduledSession?: boolean
    execute: (args: Record<string, unknown>, context: unknown) => Promise<unknown>
}

/**
 * System prompt / instruction contribution for LLM agents.
 */
export interface SystemPromptContribution {
    id: string
    pluginId?: string
    /** Explicit target agent scope (defaults to 'all' if omitted). */
    targetAgent?: AgentTarget
    /** Direct guideline string to add to system prompt Guidelines section. */
    guideline?: string
    /** Full prompt / instruction text block to append to the system prompt. */
    content?: string
    order?: number
}














