import { describe, expect, it } from 'vitest'
import type { DisplayMessagePart } from '../types.js'
import {
  groupCompactActivityParts,
  hasVisibleTurnContent,
  isSkillRead,
  skillDisplayName,
  summarizeToolActivity,
  titleFromArgs,
  toolDisplayName,
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
  const translations: Record<string, string> = {
    'tool.summary.skillRead': 'Read {{name}} skill',
    'tool.summary.runningCommand': 'Running {{command}}',
    'tool.summary.loadedCommand': 'Loaded tools and ran a command',
    'tool.summary.readingFile': 'Reading {{name}}',
    'tool.summary.settingSessionTitle': 'Setting session title to {{title}}',
    'tool.summary.settingSessionTitleGeneric': 'Setting session title',
    'tool.summary.setSessionTitle': 'Set session title to {{title}}',
    'tool.summary.setSessionTitleGeneric': 'Set session title',
    'tool.summary.updatingTodoList': 'Updating todo list',
    'tool.summary.listingMemories': 'Listing memories',
    'tool.summary.listedMemories': 'Listed memories',
    'tool.summary.readingMemory': 'Reading memory',
    'tool.summary.readMemory': 'Read memory',
    'tool.summary.searchingMemories': 'Searching memories',
    'tool.summary.searchedMemories': 'Searched memories',
    'tool.summary.writingMemory': 'Writing memory',
    'tool.summary.wroteMemory': 'Wrote memory',
    'tool.summary.searchingWeb': 'Searching the web',
    'tool.summary.searchedWeb': 'Searched the web',
    'tool.summary.using': 'Using {{name}}',
    'tool.summary.used': 'Used {{name}}',
    'tool.display.memories_search': 'Memory search',
    'tool.display.memories_add_ad_hoc_note': 'Write memory',
    'tool.display.web_search': 'Web search',
  }
  const t: any = (key: string, options?: any) => {
    const template = translations[key]
    if (!template) return options?.defaultValue ?? key
    return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
      const value = options?.[name]
      return value == null ? '' : String(value)
    })
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

  it('summarizes built-in memory and web search tools without function names', () => {
    const runningSearch = summarizeToolActivity(
      {
        id: 'm1',
        name: 'memories_search',
        args: { queries: ['preference'] },
        status: 'running',
      },
      t,
    )
    expect(runningSearch.kind).toBe('read')
    expect(runningSearch.text).toBe('Searching memories')
    expect(runningSearch.text).not.toContain('memories_search')

    const listed = summarizeToolActivity(
      {
        id: 'm2',
        name: 'memories_list',
        args: {},
        status: 'done',
      },
      t,
    )
    expect(listed.text).toBe('Listed memories')

    const wrote = summarizeToolActivity(
      {
        id: 'm3',
        name: 'memories_add_ad_hoc_note',
        args: { filename: 'note.md', note: 'remember this' },
        status: 'done',
      },
      t,
    )
    expect(wrote.kind).toBe('write')
    expect(wrote.text).toBe('Wrote memory')

    const aliasSearch = summarizeToolActivity(
      {
        id: 'm4',
        name: 'memory_search',
        args: {},
        status: 'done',
      },
      t,
    )
    expect(aliasSearch.text).toBe('Searched memories')

    const webSearch = summarizeToolActivity(
      {
        id: 'w1',
        name: 'web_search',
        args: { query: 'latest release' },
        status: 'running',
      },
      t,
    )
    expect(webSearch.text).toBe('Searching the web')
    expect(webSearch.text).not.toContain('web_search')
  })

  it('uses localized display names for unknown tools instead of raw function names', () => {
    const summary = summarizeToolActivity(
      {
        id: 'u1',
        name: 'custom_plugin_tool',
        args: {},
        status: 'done',
      },
      t,
    )
    expect(summary.text).toBe('Used Custom Plugin Tool')
    expect(summary.text).not.toContain('custom_plugin_tool')
  })

  it('localizes built-in tool display names', () => {
    expect(toolDisplayName('memories_search', t)).toBe('Memory search')
    expect(toolDisplayName('web_search', t)).toBe('Web search')
    expect(toolDisplayName('memory_store', t)).toBe('Write memory')
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
