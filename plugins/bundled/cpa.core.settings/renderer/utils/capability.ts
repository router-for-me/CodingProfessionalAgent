import type { PluginCapabilityClient } from '@cpa/plugin-api'

let settingsCapabilityClient: PluginCapabilityClient | null = null

export function setSettingsCapabilityClient(
    client: PluginCapabilityClient | null | undefined,
): void {
    settingsCapabilityClient = client ?? null
}

export function getSettingsCapabilityClient(): PluginCapabilityClient | null {
    return settingsCapabilityClient
}
