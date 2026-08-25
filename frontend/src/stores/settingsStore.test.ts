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

  it('hydrates resumeUnfinishedConversations properly', () => {
    useSettingsStore.getState().hydrate({ resumeUnfinishedConversations: false })
    expect(useSettingsStore.getState().settings.resumeUnfinishedConversations).toBe(false)

    useSettingsStore.getState().hydrate({ resumeUnfinishedConversations: true })
    expect(useSettingsStore.getState().settings.resumeUnfinishedConversations).toBe(true)
  })

  it('updates git settings and hydrates properly', () => {
    expect(useSettingsStore.getState().settings.git?.branchPrefix).toBe('codex/')
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
})
