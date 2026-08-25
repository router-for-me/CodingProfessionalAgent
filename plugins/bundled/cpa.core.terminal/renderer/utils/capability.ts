import type { PluginCapabilityClient } from '@cpa/plugin-api'

let terminalCapabilityClient: PluginCapabilityClient | null = null

export function setTerminalCapabilityClient(
    client: PluginCapabilityClient | null | undefined,
): void {
    terminalCapabilityClient = client ?? null
}

export function getTerminalCapabilityClient(): PluginCapabilityClient | null {
    return terminalCapabilityClient
}
