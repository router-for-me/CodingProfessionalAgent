import { create } from 'zustand'
import type { AskDecision, AskRequest, AskState } from './types.js'

import { defaultAskController } from './askController.js'

export { AskController, defaultAskController } from './askController.js'

export const useAskStore = create<AskState>((set, get) => ({
    requestsBySession: {},

    setRequest: (sessionId: string, request: AskRequest | null) => {
        if (!sessionId) return
        set((state) => {
            if (!request) {
                if (!(sessionId in state.requestsBySession)) return state
                const next = { ...state.requestsBySession }
                delete next[sessionId]
                return { requestsBySession: next }
            }
            return {
                requestsBySession: {
                    ...state.requestsBySession,
                    [sessionId]: request,
                },
            }
        })
    },

    clearRequest: (sessionId: string, requestId: string) => {
        set((state) => {
            if (state.requestsBySession[sessionId]?.id !== requestId) return state
            const next = { ...state.requestsBySession }
            delete next[sessionId]
            return { requestsBySession: next }
        })
    },

    getRequest: (sessionId: string) => {
        if (!sessionId) return undefined
        return get().requestsBySession[sessionId]
    },

    submitAnswer: (sessionId: string, toolCallId: string, decision: AskDecision) => {
        defaultAskController.submitAnswer(sessionId, toolCallId, decision)
        get().setRequest(sessionId, null)
    },

    cancelCountdown: (sessionId: string, toolCallId: string) => {
        defaultAskController.cancelCountdown(sessionId, toolCallId)
        set((state) => {
            const request = state.requestsBySession[sessionId]
            if (!request || request.toolCallId !== toolCallId || request.countdownDeadline === undefined) return state
            return {
                requestsBySession: {
                    ...state.requestsBySession,
                    [sessionId]: { ...request, countdownDeadline: undefined },
                },
            }
        })
    },

    cancel: (sessionId: string, toolCallId?: string) => {
        defaultAskController.cancel(sessionId, toolCallId)
        get().setRequest(sessionId, null)
    },

    clearSession: (sessionId: string) => {
        defaultAskController.abortSession(sessionId)
        get().setRequest(sessionId, null)
    },

    clearAll: () => {
        defaultAskController.abortAll()
        set({ requestsBySession: {} })
    },
}))

export function __resetAskStoreForTests(): void {
    useAskStore.getState().clearAll()
}
