import { create } from 'zustand'
import i18n from '@/i18n'
import {
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
  DEFAULT_MODEL_SETTINGS,
  DEFAULT_GIT_SETTINGS,
  DEFAULT_WORKTREE_SETTINGS,
  DEFAULT_SUBAGENT_SETTINGS,
  DEFAULT_EDITOR_SETTINGS,
  normalizeCompactionThresholdPercent,
  type AppSettings,
  type CliProxyApiSettings,
  type EditorSettings,
  type GitSettings,
  type Locale,
  type ModelSettingsConfig,
  type PersonalityTone,
  type ReasoningLevel,
  type Speed,
  type SubagentsSettings,
  type TerminalPosition,
  type ThemeMode,
  type UserProfileSettings,
  type WebServerSettings,
  type WorktreeSettings,
} from '@/types/models'

interface SettingsState {
  settings: AppSettings
  setTheme: (theme: ThemeMode) => void
  setLocale: (locale: Locale) => void
  setModelId: (modelId: string) => void
  setReasoningLevel: (reasoningLevel: ReasoningLevel) => void
  setSpeed: (speed: Speed) => void
  setCompactionThresholdPercent: (percent: number) => void
  setFastContextCompaction: (enabled: boolean) => void
  setResumeUnfinishedConversations: (enabled: boolean) => void
  setPreventSleep: (enabled: boolean) => void
  setShowInMenuBar: (enabled: boolean) => void
  setShowBottomPanel: (enabled: boolean) => void
  setTerminalPosition: (position: TerminalPosition) => void
  setCliProxyApi: (partial: Partial<CliProxyApiSettings>) => void
  setWebServer: (partial: Partial<WebServerSettings>) => void
  setProfile: (partial: Partial<UserProfileSettings>) => void
  setModelSettings: (partial: Partial<ModelSettingsConfig>) => void
  setModelOrder: (modelOrder: string[]) => void
  setModelEnabled: (modelId: string, enabled: boolean) => void
  setModelReasoningLevelEnabled: (
    modelId: string,
    reasoningLevel: string,
    enabled: boolean,
    allReasoningLevels?: readonly string[],
  ) => void
  setThemePreset: (themePreset: string) => void
  setAccentColor: (accentColor: string) => void
  setBackgroundColor: (backgroundColor: string) => void
  setForegroundColor: (foregroundColor: string) => void
  setUiFontFamily: (uiFontFamily: string) => void
  setUiFontWeight: (uiFontWeight: string) => void
  setCodeFontFamily: (codeFontFamily: string) => void
  setCodeFontWeight: (codeFontWeight: string) => void
  setContrast: (contrast: number) => void
  setCompactMode: (compactMode: boolean) => void
  setShowLineNumbers: (showLineNumbers: boolean) => void
  setWordWrap: (wordWrap: boolean) => void
  setUiScale: (uiScale: number) => void
  setUiFontSize: (uiFontSize: number) => void
  setCodeFontSize: (codeFontSize: number) => void
  setFontSmoothing: (fontSmoothing: boolean) => void
  setLocalMemoryEnabled: (enabled: boolean) => void
  setToolAssistedMemoryEnabled: (enabled: boolean) => void
  setPersonality: (personality: PersonalityTone) => void
  setGitSettings: (partial: Partial<GitSettings>) => void
  setWorktreeSettings: (partial: Partial<WorktreeSettings>) => void
  setSubagentSettings: (partial: Partial<SubagentsSettings>) => void
  setEditorSettings: (partial: Partial<EditorSettings>) => void
  setAppearance: (partial: Partial<AppSettings>) => void
  hydrate: (partial: Partial<AppSettings>) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: { ...DEFAULT_SETTINGS },

  setTheme: (theme) =>
    set((state) => ({
      settings: { ...state.settings, theme },
    })),

  setLocale: (locale) => {
    void i18n.changeLanguage(locale)
    set((state) => ({
      settings: { ...state.settings, locale },
    }))
  },

  setModelId: (modelId) =>
    set((state) => ({
      settings: { ...state.settings, modelId },
    })),

  setReasoningLevel: (reasoningLevel) =>
    set((state) => ({
      settings: { ...state.settings, reasoningLevel },
    })),

  setSpeed: (speed) =>
    set((state) => ({
      settings: { ...state.settings, speed },
    })),

  setCompactionThresholdPercent: (percent) =>
    set((state) => ({
      settings: {
        ...state.settings,
        compactionThresholdPercent: normalizeCompactionThresholdPercent(percent),
      },
    })),

  setFastContextCompaction: (enabled) =>
    set((state) => ({
      settings: {
        ...state.settings,
        fastContextCompaction: enabled,
      },
    })),

  setResumeUnfinishedConversations: (enabled) =>
    set((state) => ({
      settings: {
        ...state.settings,
        resumeUnfinishedConversations: enabled,
      },
    })),

  setPreventSleep: (enabled) =>
    set((state) => ({
      settings: {
        ...state.settings,
        preventSleep: enabled,
      },
    })),

  setShowInMenuBar: (showInMenuBar) =>
    set((state) => ({
      settings: {
        ...state.settings,
        showInMenuBar,
      },
    })),

  setShowBottomPanel: (showBottomPanel) =>
    set((state) => ({
      settings: {
        ...state.settings,
        showBottomPanel,
      },
    })),

  setTerminalPosition: (terminalPosition) =>
    set((state) => ({
      settings: {
        ...state.settings,
        terminalPosition,
      },
    })),

  setCliProxyApi: (partial) =>
    set((state) => ({
      settings: {
        ...state.settings,
        cliProxyApi: {
          ...state.settings.cliProxyApi,
          ...partial,
        },
      },
    })),

  setWebServer: (partial) =>
    set((state) => ({
      settings: {
        ...state.settings,
        webServer: {
          ...(state.settings.webServer ?? DEFAULT_SETTINGS.webServer!),
          ...partial,
        },
      },
    })),

  setProfile: (partial) =>
    set((state) => ({
      settings: {
        ...state.settings,
        profile: {
          ...(state.settings.profile ?? DEFAULT_PROFILE),
          ...partial,
        },
      },
    })),

  setModelSettings: (partial) =>
    set((state) => ({
      settings: {
        ...state.settings,
        modelSettings: {
          ...(state.settings.modelSettings ?? DEFAULT_MODEL_SETTINGS),
          ...partial,
        },
      },
    })),

  setModelOrder: (modelOrder) =>
    set((state) => ({
      settings: {
        ...state.settings,
        modelSettings: {
          ...(state.settings.modelSettings ?? DEFAULT_MODEL_SETTINGS),
          modelOrder,
        },
      },
    })),

  setModelEnabled: (modelId, enabled) =>
    set((state) => {
      const current = state.settings.modelSettings ?? DEFAULT_MODEL_SETTINGS
      const modelConfig = current.models[modelId] ?? { enabled: true }
      return {
        settings: {
          ...state.settings,
          modelSettings: {
            ...current,
            models: {
              ...current.models,
              [modelId]: {
                ...modelConfig,
                enabled,
              },
            },
          },
        },
      }
    }),

  setModelReasoningLevelEnabled: (modelId, reasoningLevel, enabled, allReasoningLevels) =>
    set((state) => {
      const current = state.settings.modelSettings ?? DEFAULT_MODEL_SETTINGS
      const modelConfig = current.models[modelId] ?? { enabled: true }
      const currentLevels = modelConfig.enabledReasoningLevels
        ? [...modelConfig.enabledReasoningLevels]
        : allReasoningLevels
          ? [...allReasoningLevels]
          : [reasoningLevel]

      let nextLevels: string[]
      if (enabled) {
        if (!currentLevels.includes(reasoningLevel)) {
          nextLevels = [...currentLevels, reasoningLevel]
        } else {
          nextLevels = currentLevels
        }
      } else {
        nextLevels = currentLevels.filter((lvl) => lvl !== reasoningLevel)
      }

      return {
        settings: {
          ...state.settings,
          modelSettings: {
            ...current,
            models: {
              ...current.models,
              [modelId]: {
                ...modelConfig,
                enabledReasoningLevels: nextLevels,
              },
            },
          },
        },
      }
    }),

  setThemePreset: (themePreset) =>
    set((state) => ({
      settings: { ...state.settings, themePreset },
    })),

  setAccentColor: (accentColor) =>
    set((state) => ({
      settings: { ...state.settings, accentColor },
    })),

  setBackgroundColor: (backgroundColor) =>
    set((state) => ({
      settings: { ...state.settings, backgroundColor },
    })),

  setForegroundColor: (foregroundColor) =>
    set((state) => ({
      settings: { ...state.settings, foregroundColor },
    })),

  setUiFontFamily: (uiFontFamily) =>
    set((state) => ({
      settings: { ...state.settings, uiFontFamily },
    })),

  setUiFontWeight: (uiFontWeight) =>
    set((state) => ({
      settings: { ...state.settings, uiFontWeight },
    })),

  setCodeFontFamily: (codeFontFamily) =>
    set((state) => ({
      settings: { ...state.settings, codeFontFamily },
    })),

  setCodeFontWeight: (codeFontWeight) =>
    set((state) => ({
      settings: { ...state.settings, codeFontWeight },
    })),

  setContrast: (contrast) =>
    set((state) => ({
      settings: { ...state.settings, contrast },
    })),

  setCompactMode: (compactMode) =>
    set((state) => ({
      settings: { ...state.settings, compactMode },
    })),

  setShowLineNumbers: (showLineNumbers) =>
    set((state) => ({
      settings: { ...state.settings, showLineNumbers },
    })),

  setWordWrap: (wordWrap) =>
    set((state) => ({
      settings: { ...state.settings, wordWrap },
    })),

  setUiScale: (uiScale) =>
    set((state) => ({
      settings: { ...state.settings, uiScale },
    })),

  setUiFontSize: (uiFontSize) =>
    set((state) => ({
      settings: { ...state.settings, uiFontSize },
    })),

  setCodeFontSize: (codeFontSize) =>
    set((state) => ({
      settings: { ...state.settings, codeFontSize },
    })),

  setFontSmoothing: (fontSmoothing) =>
    set((state) => ({
      settings: { ...state.settings, fontSmoothing },
    })),

  setLocalMemoryEnabled: (localMemoryEnabled) =>
    set((state) => ({
      settings: { ...state.settings, localMemoryEnabled },
    })),

  setToolAssistedMemoryEnabled: (toolAssistedMemoryEnabled) =>
    set((state) => ({
      settings: { ...state.settings, toolAssistedMemoryEnabled },
    })),

  setPersonality: (personality) =>
    set((state) => ({
      settings: { ...state.settings, personality },
    })),

  setGitSettings: (partial) =>
    set((state) => ({
      settings: {
        ...state.settings,
        git: {
          ...(state.settings.git ?? DEFAULT_GIT_SETTINGS),
          ...partial,
        },
      },
    })),

  setWorktreeSettings: (partial) =>
    set((state) => ({
      settings: {
        ...state.settings,
        worktrees: {
          ...(state.settings.worktrees ?? DEFAULT_WORKTREE_SETTINGS),
          ...partial,
        },
      },
    })),

  setSubagentSettings: (partial) =>
    set((state) => ({
      settings: {
        ...state.settings,
        subagents: {
          ...(state.settings.subagents ?? DEFAULT_SUBAGENT_SETTINGS),
          ...partial,
        },
      },
    })),

  setEditorSettings: (partial) =>
    set((state) => ({
      settings: {
        ...state.settings,
        editor: {
          ...(state.settings.editor ?? DEFAULT_EDITOR_SETTINGS),
          ...partial,
        },
      },
    })),

  setAppearance: (partial) =>
    set((state) => ({
      settings: { ...state.settings, ...partial },
    })),

  hydrate: (partial) => {
    if (partial.locale) {
      void i18n.changeLanguage(partial.locale)
    }
    set((state) => {
      const settings = { ...state.settings, ...partial }
      settings.compactionThresholdPercent = normalizeCompactionThresholdPercent(
        settings.compactionThresholdPercent,
      )
      settings.fastContextCompaction =
        typeof settings.fastContextCompaction === 'boolean'
          ? settings.fastContextCompaction
          : DEFAULT_SETTINGS.fastContextCompaction
      settings.resumeUnfinishedConversations =
        typeof settings.resumeUnfinishedConversations === 'boolean'
          ? settings.resumeUnfinishedConversations
          : DEFAULT_SETTINGS.resumeUnfinishedConversations
      settings.preventSleep =
        typeof settings.preventSleep === 'boolean'
          ? settings.preventSleep
          : DEFAULT_SETTINGS.preventSleep
      settings.showInMenuBar =
        typeof settings.showInMenuBar === 'boolean'
          ? settings.showInMenuBar
          : DEFAULT_SETTINGS.showInMenuBar
      settings.showBottomPanel =
        typeof settings.showBottomPanel === 'boolean'
          ? settings.showBottomPanel
          : DEFAULT_SETTINGS.showBottomPanel
      settings.terminalPosition =
        settings.terminalPosition === 'right' || settings.terminalPosition === 'bottom'
          ? settings.terminalPosition
          : DEFAULT_SETTINGS.terminalPosition
      settings.localMemoryEnabled =
        typeof settings.localMemoryEnabled === 'boolean'
          ? settings.localMemoryEnabled
          : DEFAULT_SETTINGS.localMemoryEnabled
      settings.toolAssistedMemoryEnabled =
        typeof settings.toolAssistedMemoryEnabled === 'boolean'
          ? settings.toolAssistedMemoryEnabled
          : DEFAULT_SETTINGS.toolAssistedMemoryEnabled
      settings.personality =
        settings.personality || DEFAULT_SETTINGS.personality
      if (partial.webServer) {
        settings.webServer = {
          ...(state.settings.webServer ?? DEFAULT_SETTINGS.webServer!),
          ...partial.webServer,
        }
      }
      if (partial.profile) {
        settings.profile = {
          ...DEFAULT_PROFILE,
          ...partial.profile,
        }
      }
      if (partial.modelSettings) {
        settings.modelSettings = {
          enableAll:
            typeof partial.modelSettings.enableAll === 'boolean'
              ? partial.modelSettings.enableAll
              : DEFAULT_MODEL_SETTINGS.enableAll,
          models:
            typeof partial.modelSettings.models === 'object' &&
            partial.modelSettings.models !== null
              ? partial.modelSettings.models
              : {},
          modelOrder: Array.isArray(partial.modelSettings.modelOrder)
            ? partial.modelSettings.modelOrder.filter(
                (id): id is string => typeof id === 'string',
              )
            : [],
        }
      }
      if (partial.git) {
        settings.git = {
          ...(state.settings.git ?? DEFAULT_GIT_SETTINGS),
          ...partial.git,
        }
      }
      if (partial.worktrees) {
        settings.worktrees = {
          ...(state.settings.worktrees ?? DEFAULT_WORKTREE_SETTINGS),
          ...partial.worktrees,
        }
      }
      if (partial.subagents) {
        settings.subagents = {
          ...(state.settings.subagents ?? DEFAULT_SUBAGENT_SETTINGS),
          ...partial.subagents,
          roles: Array.isArray(partial.subagents.roles)
            ? partial.subagents.roles
            : (state.settings.subagents?.roles ?? DEFAULT_SUBAGENT_SETTINGS.roles ?? []),
        }
      }
      if (partial.editor) {
        settings.editor = {
          ...(state.settings.editor ?? DEFAULT_EDITOR_SETTINGS),
          ...partial.editor,
        }
      }
      return { settings }
    })
  },
}))
