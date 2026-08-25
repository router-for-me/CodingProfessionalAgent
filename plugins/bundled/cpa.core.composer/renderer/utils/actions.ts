import type { ActionExecutionContext } from '@cpa/plugin-api'
import {
    filterCatalogModels,
    getReasoningOptions,
    normalizeModelPreferences,
} from './modelMenuOptions.js'
import { FALLBACK_MODEL_CATALOG } from '../types.js'

export function executeCycleReasoningEffort(context: ActionExecutionContext): string | null {
    const services = context.services
    const currentSessionId = services.sessions?.getCurrentSessionId?.() ?? null
    const currentSessions = services.sessions?.getSnapshot?.() ?? []
    const currentSession = currentSessionId
        ? currentSessions.find((s: any) => s.id === currentSessionId)
        : undefined

    const settings = services.settings?.getSnapshot?.()
    const selectedModelId = settings?.modelId
    const selectedReasoningLevel = settings?.reasoningLevel ?? 'off'
    const modelId = currentSession?.modelId ?? selectedModelId

    const catalogModels = (services.models?.getModels?.() ?? []) as any[]
    const models = catalogModels.length > 0 ? catalogModels : FALLBACK_MODEL_CATALOG
    const currentModel = models.find((m) => m.id === modelId)
    const options = getReasoningOptions(currentModel)

    if (options.length === 0) return null

    const currentLevel = currentSession?.reasoningEffort ?? selectedReasoningLevel
    const currentIndex = options.findIndex((opt) => opt.id === currentLevel)
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % options.length
    const nextOption = options[nextIndex]

    services.settings?.setReasoningLevel?.(nextOption.id)

    if (currentSessionId && services.sessions?.setSessionRuntimeSettings) {
        services.sessions.setSessionRuntimeSettings(currentSessionId, {
            modelId: currentModel?.id,
            reasoningEffort: nextOption.id,
            speed: currentSession?.speed ?? settings?.speed ?? 'standard',
        })
    }

    return nextOption.id
}

export function executeNextModel(context: ActionExecutionContext): string | null {
    const services = context.services
    const currentSessionId = services.sessions?.getCurrentSessionId?.() ?? null
    if (currentSessionId) {
        const activeRun = services.sessions?.getActiveRun?.(currentSessionId)
        if (activeRun && activeRun.status !== 'idle') {
            return null
        }
    }

    const currentSessions = services.sessions?.getSnapshot?.() ?? []
    const currentSession = currentSessionId
        ? currentSessions.find((s: any) => s.id === currentSessionId)
        : undefined

    const settings = services.settings?.getSnapshot?.()
    const modelId = currentSession?.modelId ?? settings?.modelId
    const modelSettings = settings?.modelSettings

    const rawModels = (services.models?.getModels?.() ?? []) as any[]
    const catalogModels = rawModels.length > 0 ? rawModels : FALLBACK_MODEL_CATALOG
    const models = filterCatalogModels(catalogModels, modelSettings)

    if (models.length === 0) return null

    const currentIndex = models.findIndex((m) => m.id === modelId)
    if (currentIndex < 0) {
        const nextModel = models[0]
        services.settings?.setModelId?.(nextModel.id)
        const normalized = normalizeModelPreferences(
            nextModel,
            currentSession?.reasoningEffort ?? settings?.reasoningLevel ?? 'off',
            currentSession?.speed ?? settings?.speed ?? 'standard',
        )
        services.settings?.setReasoningLevel?.(normalized.reasoningLevel)
        if (currentSessionId && services.sessions?.setSessionRuntimeSettings) {
            services.sessions.setSessionRuntimeSettings(currentSessionId, {
                modelId: nextModel.id,
                reasoningEffort: normalized.reasoningLevel,
                speed: normalized.speed,
            })
        }
        return nextModel.id
    }

    if (currentIndex >= models.length - 1) {
        return null
    }

    const nextModel = models[currentIndex + 1]
    services.settings?.setModelId?.(nextModel.id)
    const normalized = normalizeModelPreferences(
        nextModel,
        currentSession?.reasoningEffort ?? settings?.reasoningLevel ?? 'off',
        currentSession?.speed ?? settings?.speed ?? 'standard',
    )
    services.settings?.setReasoningLevel?.(normalized.reasoningLevel)
    if (currentSessionId && services.sessions?.setSessionRuntimeSettings) {
        services.sessions.setSessionRuntimeSettings(currentSessionId, {
            modelId: nextModel.id,
            reasoningEffort: normalized.reasoningLevel,
            speed: normalized.speed,
        })
    }
    return nextModel.id
}

export function executePreviousModel(context: ActionExecutionContext): string | null {
    const services = context.services
    const currentSessionId = services.sessions?.getCurrentSessionId?.() ?? null
    if (currentSessionId) {
        const activeRun = services.sessions?.getActiveRun?.(currentSessionId)
        if (activeRun && activeRun.status !== 'idle') {
            return null
        }
    }

    const currentSessions = services.sessions?.getSnapshot?.() ?? []
    const currentSession = currentSessionId
        ? currentSessions.find((s: any) => s.id === currentSessionId)
        : undefined

    const settings = services.settings?.getSnapshot?.()
    const modelId = currentSession?.modelId ?? settings?.modelId
    const modelSettings = settings?.modelSettings

    const rawModels = (services.models?.getModels?.() ?? []) as any[]
    const catalogModels = rawModels.length > 0 ? rawModels : FALLBACK_MODEL_CATALOG
    const models = filterCatalogModels(catalogModels, modelSettings)

    if (models.length === 0) return null

    const currentIndex = models.findIndex((m) => m.id === modelId)
    if (currentIndex < 0) {
        const prevModel = models[0]
        services.settings?.setModelId?.(prevModel.id)
        const normalized = normalizeModelPreferences(
            prevModel,
            currentSession?.reasoningEffort ?? settings?.reasoningLevel ?? 'off',
            currentSession?.speed ?? settings?.speed ?? 'standard',
        )
        services.settings?.setReasoningLevel?.(normalized.reasoningLevel)
        if (currentSessionId && services.sessions?.setSessionRuntimeSettings) {
            services.sessions.setSessionRuntimeSettings(currentSessionId, {
                modelId: prevModel.id,
                reasoningEffort: normalized.reasoningLevel,
                speed: normalized.speed,
            })
        }
        return prevModel.id
    }

    if (currentIndex <= 0) {
        return null
    }

    const prevModel = models[currentIndex - 1]
    services.settings?.setModelId?.(prevModel.id)
    const normalized = normalizeModelPreferences(
        prevModel,
        currentSession?.reasoningEffort ?? settings?.reasoningLevel ?? 'off',
        currentSession?.speed ?? settings?.speed ?? 'standard',
    )
    services.settings?.setReasoningLevel?.(normalized.reasoningLevel)
    if (currentSessionId && services.sessions?.setSessionRuntimeSettings) {
        services.sessions.setSessionRuntimeSettings(currentSessionId, {
            modelId: prevModel.id,
            reasoningEffort: normalized.reasoningLevel,
            speed: normalized.speed,
        })
    }
    return prevModel.id
}
