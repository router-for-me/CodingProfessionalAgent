import { describe, expect, it } from 'vitest'
import type { DisplayMessagePart } from '../types.js'
import {
  groupCompactActivityParts,
  hasVisibleTurnContent,
  isSkillRead,
  skillDisplayName,
  summarizeToolActivity,
  titleFromArgs,
  trailingAssistantText,
} from './toolActivity.js'

describe('skill detection', () => {
  it('treats SKILL.md reads as skill activity', () => {
    expect(
      isSkillRead('read', { path: '/skills/gh-issue/SKILL.md' }),
    ).toBe(true)
    expect(isSkillRead('read', { path: 'src/main.go' })).toBe(false)
    expect(isSkillRead('bash', { path: '/skills/gh-issue/SKILL.md' })).toBe(
      false,
    )
  })

  it('humanizes the skill folder name', () => {
    expect(skillDisplayName({ path: '/skills/gh-issue/SKILL.md' })).toBe(
      'Gh Issue',
    )
  })
})

describe('summarizeToolActivity', () => {
  const t: any = (key: string, options?: any) => {
    if (key === 'tool.summary.skillRead') return `Read ${options?.name} skill`
    if (key === 'tool.summary.runningCommand') return `Running ${options?.command}`
    if (key === 'tool.summary.loadedCommand') return 'Loaded tools and ran a command'
    if (key === 'tool.summary.readingFile') return `Reading ${options?.name}`
    if (key === 'tool.summary.settingSessionTitle') return `Setting session title to ${options?.title}`
    if (key === 'tool.summary.settingSessionTitleGeneric') return 'Setting session title'
    if (key === 'tool.summary.setSessionTitle') return `Set session title to ${options?.title}`
    if (key === 'tool.summary.setSessionTitleGeneric') return 'Set session title'
    if (key === 'tool.summary.updatingTodoList') return 'Updating todo list'
    return options?.defaultValue ?? key
  }

  it('summarizes a completed skill read', () => {
    const summary = summarizeToolActivity(
      {
        id: '1',
        name: 'read',
        args: { path: '/skills/gh-issue/SKILL.md' },
        status: 'done',
      },
      t,
    )
    expect(summary.kind).toBe('skill')
    expect(summary.text).toBe('Read Gh Issue skill')
  })

  it('summarizes bash as a loaded command when done', () => {
    const summary = summarizeToolActivity(
      {
        id: '2',
        name: 'bash',
        args: { command: 'gh issue view 1' },
        status: 'done',
      },
      t,
    )
    expect(summary.text).toBe('Loaded tools and ran a command')
  })

  it('summarizes pwsh and powershell as command activity', () => {
    const pwshRunning = summarizeToolActivity(
      {
        id: '2a',
        name: 'pwsh',
        args: { command: 'Get-ChildItem' },
        status: 'running',
      },
      t,
    )
    expect(pwshRunning.kind).toBe('command')
    expect(pwshRunning.text).toBe('Running Get-ChildItem')

    const psDone = summarizeToolActivity(
      {
        id: '2b',
        name: 'powershell',
        args: { command: 'dir' },
        status: 'done',
      },
      t,
    )
    expect(psDone.kind).toBe('command')
    expect(psDone.text).toBe('Loaded tools and ran a command')
  })

  it('summarizes a running file read', () => {
    const summary = summarizeToolActivity(
      {
        id: '3',
        name: 'read',
        args: { path: 'openai_images_handlers.go' },
        status: 'running',
      },
      t,
    )
    expect(summary.text).toBe('Reading openai_images_handlers.go')
  })

  it('summarizes set_session_title and title when running and done', () => {
    const runningSummary = summarizeToolActivity(
      {
        id: '4a',
        name: 'title',
        args: { title: 'Fix bug and optimize performance' },
        status: 'running',
      },
      t,
    )
    expect(runningSummary.kind).toBe('other')
    expect(runningSummary.running).toBe(true)
    expect(runningSummary.text).toBe('Setting session title to Fix bug and optimize performance')

    const doneSummary = summarizeToolActivity(
      {
        id: '4b',
        name: 'title',
        args: { title: 'Fix bug and optimize performance' },
        status: 'done',
      },
      t,
    )
    expect(doneSummary.kind).toBe('other')
    expect(doneSummary.running).toBe(false)
    expect(doneSummary.text).toBe('Set session title to Fix bug and optimize performance')

    const runningTodo = summarizeToolActivity(
      {
        id: '4todo',
        name: 'todo',
        args: { operation: 'write' },
        status: 'running',
      },
      t,
    )
    expect(runningTodo.kind).toBe('other')
    expect(runningTodo.running).toBe(true)
    expect(runningTodo.text).toBe('Updating todo list')
  })

  it('summarizes set_session_title without title argument gracefully', () => {
    const runningNoTitle = summarizeToolActivity(
      {
        id: '4c',
        name: 'set_session_title',
        args: {},
        status: 'running',
      },
      t,
    )
    expect(runningNoTitle.text).toBe('Setting session title')

    const doneNoTitle = summarizeToolActivity(
      {
        id: '4d',
        name: 'set_session_title',
        args: {},
        status: 'done',
      },
      t,
    )
    expect(doneNoTitle.text).toBe('Set session title')
  })

  it('extracts and trims title from args with length truncation', () => {
    expect(titleFromArgs({ title: '  My New Session Title  ' })).toBe('My New Session Title')
    expect(titleFromArgs({})).toBeUndefined()
    expect(titleFromArgs({ title: '' })).toBeUndefined()
    const longTitle = 'a'.repeat(100)
    const truncated = titleFromArgs({ title: longTitle })
    expect(truncated?.length).toBe(62)
    expect(truncated?.endsWith('…')).toBe(true)
  })
})

describe('turn content helpers', () => {
  it('ignores thinking and skill reads when detecting first token', () => {
    const parts: DisplayMessagePart[] = [
      { type: 'thinking', thinking: 'plan' },
      {
        type: 'tool_call',
        id: 's1',
        name: 'read',
        args: { path: '/skills/x/SKILL.md' },
        status: 'done',
      },
    ]
    expect(hasVisibleTurnContent(parts)).toBe(false)
    expect(
      hasVisibleTurnContent([
        ...parts,
        { type: 'text', text: 'hello' },
      ]),
    ).toBe(true)
  })

  it('merges tools across thinking and blank text, but splits on body text', () => {
    const parts: DisplayMessagePart[] = [
      { type: 'thinking', thinking: 'plan' },
      {
        type: 'tool_call',
        id: 't1',
        name: 'read',
        args: { path: '/skills/gh-issue/SKILL.md' },
        status: 'done',
      },
      { type: 'thinking', thinking: 'next' },
      { type: 'text', text: '   ' },
      {
        type: 'tool_call',
        id: 't2',
        name: 'bash',
        args: { command: 'gh issue view 1' },
        status: 'done',
      },
      { type: 'text', text: 'Issue summary' },
      {
        type: 'tool_call',
        id: 't3',
        name: 'read',
        args: { path: 'main.go' },
        status: 'done',
      },
    ]
    expect(groupCompactActivityParts(parts)).toEqual([
      { type: 'tools', parts: [parts[1], parts[4]] },
      { type: 'text', text: 'Issue summary' },
      { type: 'tools', parts: [parts[6]] },
    ])
  })

  it('returns trailing text after the last tool', () => {
    const parts: DisplayMessagePart[] = [
      { type: 'text', text: 'first' },
      {
        type: 'tool_call',
        id: 't1',
        name: 'read',
        args: { path: 'a.go' },
        status: 'done',
      },
      { type: 'text', text: 'final answer' },
    ]
    expect(trailingAssistantText(parts)).toBe('final answer')
  })
})
