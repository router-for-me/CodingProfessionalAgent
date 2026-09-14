import { describe, expect, it, vi } from 'vitest'
import type { PluginContext, ProtocolProviderContribution } from '@cpa/plugin-api'
import { RunScopedModelInvoker } from '../agent/isolatedModelInvoker.js'
import { protocolCodexAgentEntry } from '../../../../../plugins/bundled/cpa.core.protocol-codex/agent/index.js'
import { parseModelCatalog } from '../../../../../plugins/bundled/cpa.core.protocol-codex/renderer/modelCatalog.js'
import { createWebSearchTool } from '../../../../../plugins/bundled/cpa.core.web-search/agent/webSearchTool.js'

// Exercise the real catalog -> search tool -> isolated invoker -> registered
// protocol provider path, including capability wiring and host-owned accounting.
describe('isolated Gemini web search integration', () => {
    it('keeps the parent call isolated and accounts Gemini usage via the existing invoker', async () => {
        const [model] = parseModelCatalog({ models: [{ id: 'gemini-2.5-flash', cpa_capabilities: { web_search: false } }] })
        const http = vi.fn().mockResolvedValue({ status: 200, body: JSON.stringify({
            candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Grounded findings' }] }, groundingMetadata: {
                webSearchQueries: ['news'], groundingChunks: [{ web: { uri: 'https://example.org/news', title: 'News' } }],
            } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4, totalTokenCount: 11 },
        }) })
        let provider!: ProtocolProviderContribution
        await protocolCodexAgentEntry.activate({
            capabilityClient: { has: (id: string) => id === 'network.http', invoke: http },
            register: (contribution: { value: ProtocolProviderContribution }) => { provider = contribution.value },
        } as unknown as PluginContext)
        const openWebSocket = vi.fn()
        const owner = new RunScopedModelInvoker({
            runSignal: new AbortController().signal,
            sessionId: 'parent-session', allowedModels: [model],
            createSession: async ({ invocationId }) => ({ session: await provider.createSession!({
                sessionId: `isolated-${invocationId}`, baseUrl: 'https://proxy.test/v1', apiKey: 'private-key', bridge: { openWebSocket },
            }) }),
        })
        const tool = createWebSearchTool({
            getSettings: async () => ({ enabled: true, modelId: model.id }), getModels: () => [model], isCatalogReady: () => true,
        })
        try {
            const result = await tool.execute('parent-tool-call', { query: 'news' }, { modelInvoker: owner.forToolCall('parent-tool-call'), cwd: '/private/project' })
            expect(result.isError).toBe(false)
            expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
                status: 'completed', searchModel: model.id, searchExecuted: true, text: 'Grounded findings',
                sources: [{ url: 'https://example.org/news', title: 'News' }],
            })
            expect(http).toHaveBeenCalledOnce()
            expect(http.mock.calls[0][0]).toBe('http:request')
            const request = http.mock.calls[0][1][0]
            expect(request.urlString).toBe('https://proxy.test/v1beta/models/gemini-2.5-flash:generateContent')
            expect(JSON.parse(request.body).contents).toEqual([{ role: 'user', parts: [{ text: 'news' }] }])
            expect(request.body).not.toMatch(/private-key|private\/project|parent-session|parent-tool-call/)
            expect(openWebSocket).not.toHaveBeenCalled()
            expect(owner.takeRecords('parent-tool-call')).toEqual([expect.objectContaining({
                model: model.id, parentToolCallId: 'parent-tool-call', usage: expect.objectContaining({ totalTokens: 11, costKnown: false }),
            })])
            expect(owner.takeRecords('parent-tool-call')).toEqual([])
        } finally {
            await owner.close()
        }
    })
})
