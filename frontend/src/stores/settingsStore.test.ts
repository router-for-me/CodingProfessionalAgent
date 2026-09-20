import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/types/models'
import { useSettingsStore } from './settingsStore'

describe('settingsStore', () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  })

  it('toggles resumeUnfinishedConversations', () => {
    expect(useSettingsStore.getState().settings.resumeUnfinishedConversations).toBe(true)
    useSettingsStore.getState().setResumeUnfinishedConversations(false)
    expect(useSettingsStore.getState().settings.resumeUnfinishedConversations).toBe(false)
    useSettingsStore.getState().setResumeUnfinishedConversations(true)
    expect(useSettingsStore.getState().settings.resumeUnfinishedConversations).toBe(true)
  })

  it('toggles preventSleep', () => {
    expect(useSettingsStore.getState().settings.preventSleep).toBe(true)
    useSettingsStore.getState().setPreventSleep(false)
    expect(useSettingsStore.getState().settings.preventSleep).toBe(false)
    useSettingsStore.getState().setPreventSleep(true)
    expect(useSettingsStore.getState().settings.preventSleep).toBe(true)
  })

  it('hydrates preventSleep properly', () => {
    useSettingsStore.getState().hydrate({ preventSleep: false })
    expect(useSettingsStore.getState().settings.preventSleep).toBe(false)

    useSettingsStore.getState().hydrate({ preventSleep: true })
    expect(useSettingsStore.getState().settings.preventSleep).toBe(true)
  })

  it('hydrates resumeUnfinishedConversations properly', () => {
    useSettingsStore.getState().hydrate({ resumeUnfinishedConversations: false })
    expect(useSettingsStore.getState().settings.resumeUnfinishedConversations).toBe(false)

    useSettingsStore.getState().hydrate({ resumeUnfinishedConversations: true })
    expect(useSettingsStore.getState().settings.resumeUnfinishedConversations).toBe(true)
  })

  it('updates git settings and hydrates properly', () => {
    expect(useSettingsStore.getState().settings.git?.branchPrefix).toBe('cpa/')
    useSettingsStore.getState().setGitSettings({
      branchPrefix: 'feat/',
      mergeMethod: 'squash',
      alwaysForcePush: true,
    })
    expect(useSettingsStore.getState().settings.git?.branchPrefix).toBe('feat/')
    expect(useSettingsStore.getState().settings.git?.mergeMethod).toBe('squash')
    expect(useSettingsStore.getState().settings.git?.alwaysForcePush).toBe(true)

    useSettingsStore.getState().hydrate({
      git: {
        branchPrefix: 'my-prefix/',
        mergeMethod: 'merge',
        alwaysForcePush: false,
        createDraftPr: false,
        reviewPresentation: 'inline',
        autoMergeWhenReady: true,
        autoMergeInstructions: 'merge when ready',
        commitInstructions: 'commit instructions',
        prInstructions: 'pr instructions',
      },
    })
    expect(useSettingsStore.getState().settings.git?.branchPrefix).toBe('my-prefix/')
    expect(useSettingsStore.getState().settings.git?.createDraftPr).toBe(false)
    expect(useSettingsStore.getState().settings.git?.reviewPresentation).toBe('inline')
    expect(useSettingsStore.getState().settings.git?.autoMergeWhenReady).toBe(true)
  })

  it('updates worktree settings and hydrates properly', () => {
    expect(useSettingsStore.getState().settings.worktrees?.rootDir).toBe(
      '~/.coding-professional-agent/worktrees'
    )
    useSettingsStore.getState().setWorktreeSettings({
      rootDir: '/custom/worktrees',
      fetchUpstream: true,
      autoDeleteOld: false,
      deleteLimit: 30,
    })
    expect(useSettingsStore.getState().settings.worktrees?.rootDir).toBe(
      '/custom/worktrees'
    )
    expect(useSettingsStore.getState().settings.worktrees?.fetchUpstream).toBe(
      true
    )
    expect(useSettingsStore.getState().settings.worktrees?.autoDeleteOld).toBe(
      false
    )
    expect(useSettingsStore.getState().settings.worktrees?.deleteLimit).toBe(30)

    useSettingsStore.getState().hydrate({
      worktrees: {
        rootDir: '/another/path',
        fetchUpstream: false,
        autoDeleteOld: true,
        deleteLimit: 5,
      },
    })
    expect(useSettingsStore.getState().settings.worktrees?.rootDir).toBe(
      '/another/path'
    )
    expect(useSettingsStore.getState().settings.worktrees?.deleteLimit).toBe(5)
  })

  it('updates editor settings and hydrates properly', () => {
    expect(useSettingsStore.getState().settings.editor).toEqual({
      showContextUsage: true,
      sendShortcut: 'cmdEnter',
      followUpMode: 'steer',
    })

    useSettingsStore.getState().setEditorSettings({
      showContextUsage: false,
      sendShortcut: 'enter',
    })
    expect(useSettingsStore.getState().settings.editor?.showContextUsage).toBe(false)
    expect(useSettingsStore.getState().settings.editor?.sendShortcut).toBe('enter')
    expect(useSettingsStore.getState().settings.editor?.followUpMode).toBe('steer')

    useSettingsStore.getState().hydrate({
      editor: {
        showContextUsage: true,
        sendShortcut: 'cmdEnter',
        followUpMode: 'queue',
      },
    })
    expect(useSettingsStore.getState().settings.editor).toEqual({
      showContextUsage: true,
      sendShortcut: 'cmdEnter',
      followUpMode: 'queue',
    })
  })

  it('updates subagent settings and hydrates roles properly', () => {
    expect(useSettingsStore.getState().settings.subagents?.enabled).toBe(true)
    expect(useSettingsStore.getState().settings.subagents?.concurrency).toBe(10)
    expect(Array.isArray(useSettingsStore.getState().settings.subagents?.roles)).toBe(true)

    const customRoles = [
      {
        id: 'tester-1',
        name: 'QA Specialist',
        description: 'Performs automated and manual testing verification.',
        modelId: 'gpt-5.5',
        reasoningEffort: 'high',
      },
    ]

    useSettingsStore.getState().setSubagentSettings({
      concurrency: 15,
      roles: customRoles,
    })

    expect(useSettingsStore.getState().settings.subagents?.concurrency).toBe(15)
    expect(useSettingsStore.getState().settings.subagents?.roles).toEqual(customRoles)

    // Hydrating partial subagents without roles preserves existing roles
    useSettingsStore.getState().hydrate({
      subagents: {
        enabled: true,
        concurrency: 20,
        maxPerSession: 5,
        maxDepth: 3,
      },
    })
    expect(useSettingsStore.getState().settings.subagents?.concurrency).toBe(20)
    expect(useSettingsStore.getState().settings.subagents?.roles).toEqual(customRoles)

    // Hydrating with explicit empty roles list preserves empty list
    useSettingsStore.getState().hydrate({
      subagents: {
        enabled: true,
        concurrency: 20,
        maxPerSession: 5,
        maxDepth: 3,
        roles: [],
      },
    })
    expect(useSettingsStore.getState().settings.subagents?.roles).toEqual([])
  })

  it('updates and hydrates modelSettings with defaultTtl, cacheWarming, and per-model ttl', () => {
    const initial = useSettingsStore.getState().settings.modelSettings
    expect(initial?.enableAll).toBe(true)
    expect(initial?.defaultTtl).toBe(300)
    expect(initial?.cacheWarming).toEqual({
      mode: 'off',
      maxWarmingTime: 3600,
    })

    useSettingsStore.getState().setModelSettings({
      defaultTtl: 600,
      cacheWarming: {
        mode: 'streaming',
        maxWarmingTime: 1800,
      },
      models: {
        'model-a': {
          enabled: true,
          ttl: 120,
        },
      },
    })

    const updated = useSettingsStore.getState().settings.modelSettings
    expect(updated?.defaultTtl).toBe(600)
    expect(updated?.cacheWarming).toEqual({
      mode: 'streaming',
      maxWarmingTime: 1800,
    })
    expect(updated?.models?.['model-a']?.ttl).toBe(120)

    useSettingsStore.getState().hydrate({
      modelSettings: {
        enableAll: false,
        defaultTtl: 450,
        models: {
          'model-b': {
            enabled: false,
            ttl: 200,
          },
        },
        cacheWarming: {
          mode: 'idle',
          maxWarmingTime: 7200,
        },
      },
    })

    const hydrated = useSettingsStore.getState().settings.modelSettings
    expect(hydrated?.enableAll).toBe(false)
    expect(hydrated?.defaultTtl).toBe(450)
    expect(hydrated?.models?.['model-b']?.ttl).toBe(200)
    expect(hydrated?.cacheWarming).toEqual({
      mode: 'idle',
      maxWarmingTime: 7200,
    })
  })

  it('updates and hydrates headlessCloseAction correctly', () => {
    expect(useSettingsStore.getState().settings.headlessCloseAction).toBe('continue_headless')

    useSettingsStore.getState().setHeadlessCloseAction('quit')
    expect(useSettingsStore.getState().settings.headlessCloseAction).toBe('quit')

    useSettingsStore.getState().hydrate({
      headlessCloseAction: 'continue_headless',
    })
    expect(useSettingsStore.getState().settings.headlessCloseAction).toBe('continue_headless')
  })
})


