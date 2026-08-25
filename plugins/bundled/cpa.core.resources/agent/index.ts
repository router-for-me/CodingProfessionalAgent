import {
    createCapabilityNativeAdapter,
    definePluginEntry,
    loadContextFiles,
    loadPromptTemplates,
    loadSkills,
    type ContextDiagnostic,
    type ContextFile,
    type PromptDiagnostic,
    type PromptSource,
    type PromptTemplate,
    type Skill,
    type SkillDiagnostic,
} from '@cpa/plugin-sdk'
import type {
    PluginContext,
    ResourceProvider,
    ResourceProviderInput,
} from '@cpa/plugin-api'

export {
    loadContextFiles,
    loadSkills,
    loadPromptTemplates,
}

export const resourcesAgentEntry = definePluginEntry({
    runtime: 'agent',
    activate(context: PluginContext) {
        const client = context.capabilityClient ?? ((context as any).capabilities?.invoke ? (context as any).capabilities : undefined)
        const scopedBridge = client ? createCapabilityNativeAdapter(client) : undefined

        context.register<
            ResourceProvider<{
                files?: readonly ContextFile[]
                system?: PromptSource
                appendSystem?: PromptSource
                diagnostics?: readonly ContextDiagnostic[]
            }>
        >({
            kind: 'resource-provider',
            id: 'cpa.core.context',
            value: {
                id: 'cpa.core.context',
                kind: 'context',
                order: 10,
                targetAgent: 'all',
                load: async (input: ResourceProviderInput) => {
                    const bridge = (input.bridge as any) ?? scopedBridge
                    if (!bridge) {
                        return [{ files: [], diagnostics: [] }]
                    }
                    const agentDir = (input.agentDir as string) || ''
                    const cwd = input.cwd as string | undefined
                    const homeDir = input.homeDir as string | undefined

                    if (cwd) {
                        const res = await loadContextFiles(cwd, agentDir, bridge, homeDir)
                        return [res]
                    }
                    const globalOnly = await loadContextFiles(undefined, agentDir, bridge, homeDir)
                    return [globalOnly]
                },
            },
        })

        context.register<
            ResourceProvider<{ skills: readonly Skill[]; diagnostics: readonly SkillDiagnostic[] }>
        >({
            kind: 'resource-provider',
            id: 'cpa.core.skills',
            value: {
                id: 'cpa.core.skills',
                kind: 'skill',
                order: 20,
                targetAgent: 'all',
                load: async (input: ResourceProviderInput) => {
                    const bridge = (input.bridge as any) ?? scopedBridge
                    if (!bridge) {
                        return [{ skills: [], diagnostics: [] }]
                    }
                    const agentDir = (input.agentDir as string) || ''
                    const cwd = input.cwd as string | undefined
                    const homeDir = input.homeDir as string | undefined

                    const res = await loadSkills({
                        cwd,
                        agentDir,
                        homeDir,
                        bridge,
                    })
                    return [res]
                },
            },
        })

        context.register<
            ResourceProvider<{ prompts: readonly PromptTemplate[]; diagnostics: readonly PromptDiagnostic[] }>
        >({
            kind: 'resource-provider',
            id: 'cpa.core.prompt-templates',
            value: {
                id: 'cpa.core.prompt-templates',
                kind: 'prompt-template',
                order: 30,
                targetAgent: 'all',
                load: async (input: ResourceProviderInput) => {
                    const bridge = (input.bridge as any) ?? scopedBridge
                    if (!bridge) {
                        return [{ prompts: [], diagnostics: [] }]
                    }
                    const agentDir = (input.agentDir as string) || ''
                    const cwd = input.cwd as string | undefined
                    const homeDir = input.homeDir as string | undefined

                    const res = await loadPromptTemplates({
                        cwd,
                        agentDir,
                        homeDir,
                        bridge,
                    })
                    return [res]
                },
            },
        })
    },
})

export const entry = resourcesAgentEntry
export default resourcesAgentEntry
