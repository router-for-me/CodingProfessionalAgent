export {
    RendererPluginModuleLoader,
    type RendererPluginModuleLoaderOptions,
} from './RendererPluginModuleLoader'

export {
    RendererCapabilityClient,
    type RendererCapabilityClientOptions,
    type CapabilityTransport,
} from './RendererCapabilityClient'

export {
    RendererPluginRuntimeHost,
    type RendererPluginRuntimeHostOptions,
    createRendererRuntimeHost,
    rendererPluginRuntime,
} from './RendererPluginRuntimeHost'

export {
    RendererRegistry,
    rendererRegistry,
} from './rendererRegistry'

export {
    safePluginVisible,
    safePluginEnabled,
    safePluginDynamicTitle,
    safePluginDynamicIcon,
    SafePluginSurface,
    type SafePluginSurfaceProps,
    type PluginErrorSink,
    bindRuntimeHost,
    reportSurfaceError,
} from './safePluginSurface'

export {
    AgentPluginModuleLoader,
} from './AgentPluginModuleLoader'

export {
    AgentPluginRuntimeHost,
    type AgentPluginRuntimeHostOptions,
    createAgentRuntimeHost,
    agentPluginRuntime,
    agentRegistry,
} from './AgentPluginRuntimeHost'

export {
    PluginPlatformCoordinator,
    type PluginPlatformCoordinatorOptions,
    type MainGenerationParticipant,
    type MainGenerationPreparedState,
    type PreparePlatformGenerationOptions,
    pluginPlatformCoordinator,
} from './PluginPlatformCoordinator'

export * from './contributions/composer'
