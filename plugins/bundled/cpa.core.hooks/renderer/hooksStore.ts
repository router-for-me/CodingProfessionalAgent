/**
 * Pure Zustand store for managing Hook UI state.
 * Contains no I/O or getDefaultHostServices calls.
 */

import { create } from 'zustand'
import type {
    HookEventName,
    HookHandlerConfig,
    HookMetadata,
    HooksConfigFile,
} from '@cpa/plugin-api'

export interface HooksState {
    loading: boolean
    userConfigFile: HooksConfigFile | null
    userConfigPath: string | null
    userHooks: HookMetadata[]
    projectConfigs: Record<
        string,
        { file: HooksConfigFile; path: string; hooks: HookMetadata[] }
    >
    selectedSource: 'root' | 'user' | string
    learnMoreOpen: boolean
    editorOpen: boolean
    editingHook: {
        source: 'user' | string
        groupIndex?: number
        handlerIndex?: number
        eventName: HookEventName
        matcher: string
        handler: HookHandlerConfig
    } | null

    setLoading: (loading: boolean) => void
    setHooksData: (data: {
        userConfigFile: HooksConfigFile | null
        userConfigPath: string | null
        userHooks: HookMetadata[]
        projectConfigs: Record<string, { file: HooksConfigFile; path: string; hooks: HookMetadata[] }>
    }) => void
    setSelectedSource: (source: 'root' | 'user' | string) => void
    setLearnMoreOpen: (open: boolean) => void
    openCreateEditor: (source: 'user' | string, eventName?: HookEventName) => void
    openEditEditor: (hook: HookMetadata) => void
    closeEditor: () => void
}

export const useHooksStore = create<HooksState>((set) => ({
    loading: false,
    userConfigFile: null,
    userConfigPath: null,
    userHooks: [],
    projectConfigs: {},
    selectedSource: 'root',
    learnMoreOpen: false,
    editorOpen: false,
    editingHook: null,

    setLoading: (loading: boolean) => set({ loading }),

    setHooksData: (data) =>
        set({
            userConfigFile: data.userConfigFile,
            userConfigPath: data.userConfigPath,
            userHooks: data.userHooks,
            projectConfigs: data.projectConfigs,
            loading: false,
        }),

    setSelectedSource: (source: 'root' | 'user' | string) => set({ selectedSource: source }),

    setLearnMoreOpen: (open: boolean) => set({ learnMoreOpen: open }),

    openCreateEditor: (source: 'user' | string, eventName: HookEventName = 'PreToolUse') => {
        set({
            editorOpen: true,
            editingHook: {
                source,
                eventName,
                matcher: '',
                handler: {
                    type: 'command',
                    command: '',
                    timeout: 30,
                    async: false,
                },
            },
        })
    },

    openEditEditor: (hook: HookMetadata) => {
        const source =
            hook.source === 'user'
                ? 'user'
                : hook.sourcePath
                      .replace(/\/\.cpa\/hooks\.json$/, '')
                      .replace(/\/\.codex\/hooks\.json$/, '')
        set({
            editorOpen: true,
            editingHook: {
                source,
                eventName: hook.eventName,
                matcher: hook.matcher ?? '',
                handler: { ...hook.handler },
            },
        })
    },

    closeEditor: () => set({ editorOpen: false, editingHook: null }),
}))
