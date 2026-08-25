import { PluginEventBus } from '@cpa/plugin-kernel'

/**
 * Singleton instance of the platform event bus for the renderer process.
 */
export const rendererEventBus = new PluginEventBus()
