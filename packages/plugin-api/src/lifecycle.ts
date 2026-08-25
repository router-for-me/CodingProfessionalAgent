import type { CapabilityId, PluginCapabilityClient } from './capabilities.js'
import type { ContributionRegistration } from './contributions.js'
import type { PluginManifest } from './manifest.js'
import type { ServiceToken } from './services.js'

export interface PluginEventBus {
    emit<T = unknown>(eventName: string, payload?: T): Promise<void>
    on<T = unknown>(eventName: string, listener: (payload: T) => void | Promise<void>): () => void
}

export interface PluginContext {
    manifest: PluginManifest
    generation: number
    capabilities: ReadonlySet<CapabilityId>
    capabilityClient?: PluginCapabilityClient
    events: PluginEventBus
    register<T>(registration: ContributionRegistration<T>): () => void
    getService<T>(serviceOrToken: ServiceToken<T> | string): T
    registerSlotComponent?<P = Record<string, unknown>>(slotId: string, contribution: any): () => void
    registerFloating?<P = Record<string, unknown>>(contribution: any): () => void
    registerComponentWrapper?<P extends object = Record<string, unknown>>(contribution: any): () => void
    registerPanel?<P = unknown>(contribution: any): () => void
    registerPanelTab?<P = unknown>(contribution: any): () => void
    registerView?(contribution: any): () => void
    registerNavigationItem?(contribution: any): () => void
    registerAction?(contribution: any): () => void
    registerCommand?(contribution: any): () => void
    registerAgentTool?(contribution: any): () => void
    registerToolFactory?(contribution: any): () => void
    registerHook?(contribution: any): () => void
    registerSystemPrompt?(contribution: any): () => void
    registerResourceProvider?<T = unknown>(provider: any): () => void
    registerSettingsGroup?(contribution: any): () => void
    registerSettingsSection?(contribution: any): () => void
    registerProtocolProvider?(provider: any): () => void
    registerProtocolMiddleware?(middleware: any): () => void
    registerModelCatalogProvider?(provider: any): () => void
    registerComposerControl?(contribution: any): () => void
    registerAttachmentProvider?(provider: any): () => void
    registerSubmitPreprocessor?(preprocessor: any): () => void
    registerChatRenderer?<T = unknown>(contribution: any): () => void
    registerMessageRenderer?<T = unknown>(contribution: any): () => void
}

export type PluginInvocationResult<T> =
    | { ok: true; value: T }
    | { ok: false; error: Error }
