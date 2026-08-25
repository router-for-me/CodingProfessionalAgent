import { describe, expect, it } from 'vitest'
import { protocolCodexAgentEntry } from './index.js'
import type {
    PluginContext,
    ProtocolProviderContribution,
    ProtocolSessionContext,
} from '@cpa/plugin-api'
import { FakeNativeBridge } from './testUtils.js'

describe('protocolCodexAgentEntry', () => {
    it('registers the codex-responses-ws protocol provider', async () => {
        let providerContribution: ProtocolProviderContribution | null = null

        const mockContext: PluginContext = {
            manifest: {
                id: 'cpa.core.protocol-codex',
                name: 'Codex Protocol Provider',
                version: '1.0.0',
                apiVersion: '1.0.0',
                description: 'Codex protocol provider',
                engines: { cpa: '>=1.0.0' },
            },
            runtime: 'agent',
            register: (contribution: any) => {
                if (contribution.kind === 'protocol') {
                    providerContribution = contribution.value
                }
            },
            getService: () => undefined,
        } as unknown as PluginContext

        protocolCodexAgentEntry.activate(mockContext)

        expect(providerContribution).not.toBeNull()
        expect(providerContribution!.id).toBe('codex-responses-ws')
        expect(providerContribution!.name).toBe('CLIProxyAPI Codex Responses WebSocket')
        expect(providerContribution!.isDefault).toBe(true)

        const fakeBridge = new FakeNativeBridge()
        const manager = providerContribution!.createConnectionManager!(fakeBridge)
        expect(manager).toBeDefined()

        const sessionContext: ProtocolSessionContext = {
            apiKey: 'test-key',
            baseUrl: 'http://localhost:8080',
            sessionId: 'sess-123',
            bridge: fakeBridge,
        }
        const session = await providerContribution!.createSession!(sessionContext)
        expect(session).toBeDefined()
        expect(session.id).toBe('sess-123')
    })
})
