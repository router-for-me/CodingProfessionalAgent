import { Sparkles } from 'lucide-react'
import { definePluginEntry } from '@cpa/plugin-sdk'
import type { ModelCatalogEntry, PluginContext, ProtocolSessionContext } from '@cpa/plugin-api'
import { ModelsSection } from './components/ModelsSection.js'
import { fetchModelCatalogDirect } from './modelCatalog.js'
import { CodexConnectionManager } from '../agent/codexConnectionManager.js'
import { CodexProtocolSession } from '../agent/CodexProtocolSession.js'

export { ModelsSection, fetchModelCatalogDirect }

export const protocolCodexRendererEntry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        context.registerSettingsSection?.({
            id: 'models',
            groupId: 'code',
            order: 20,
            labelKey: 'settings.nav.models',
            icon: Sparkles,
            component: ModelsSection,
            keywords: ['models', 'llm', 'codex', 'reasoning', 'openai', 'claude'],
            items: [
                {
                    id: 'modelConfig',
                    labelKey: 'settings.models.section',
                    keywords: ['model', 'config'],
                },
                {
                    id: 'enableAll',
                    labelKey: 'settings.models.enableAll',
                    descriptionKey: 'settings.models.enableAll.desc',
                    keywords: ['enable all models', 'reasoning'],
                },
                {
                    id: 'modelList',
                    labelKey: 'settings.models.list.title',
                    keywords: ['model list'],
                },
            ],
        })

        context.registerProtocolProvider?.({
            id: 'codex-responses-ws',
            name: 'CLIProxyAPI Codex Responses WebSocket',
            isDefault: true,
            createConnectionManager: (bridge: unknown) => {
                return new CodexConnectionManager(bridge as any)
            },
            createSession: (options: ProtocolSessionContext) => {
                return new CodexProtocolSession(options)
            },
            createClient: (options: ProtocolSessionContext) => {
                return new CodexProtocolSession(options)
            },
        })

        const createCapabilityTransport = () => {
            if (
                !context.capabilityClient ||
                typeof context.capabilityClient.has !== 'function' ||
                !context.capabilityClient.has('network.http')
            ) {
                return undefined
            }
            return {
                request: async (req: {
                    url: string
                    method?: string
                    headers?: Record<string, string>
                    body?: string
                    timeoutMs?: number
                }) => {
                    return context.capabilityClient!.invoke<{
                        status: number
                        headers: Record<string, string[]>
                        body: string
                    }>('http:request', [
                        {
                            urlString: req.url,
                            method: req.method,
                            headers: req.headers,
                            body: req.body,
                            timeoutMs: req.timeoutMs,
                        },
                    ])
                },
            }
        }

        context.registerModelCatalogProvider?.({
            id: 'cliproxyapi',
            protocolProviderId: 'codex-responses-ws',
            fetchCatalog: (config: any, transport?: any) => {
                const effectiveTransport = transport ?? createCapabilityTransport()
                return fetchModelCatalogDirect(config, effectiveTransport)
            },
            getModelCapabilities: (model: ModelCatalogEntry) => ({
                supportsImages: model.input.includes('image'),
                supportsFast: model.supportsFast,
                reasoningLevels: (model.reasoningLevels ?? []).map((r) => r.id),
                contextWindow: model.contextWindow,
                maxOutputTokens: model.maxTokens,
            }),
        })
    },
})

export const entry = protocolCodexRendererEntry
export default protocolCodexRendererEntry
