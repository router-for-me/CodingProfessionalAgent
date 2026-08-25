import { describe, expect, it } from 'vitest'
import type { Skill } from '@cpa/plugin-sdk'
import type { ConversationEntry } from '@/features/agent-runtime/session/types'
import {
  collectInvokedSkills,
  matchSkillPresentation,
} from './skillPresentation'

const skills: Skill[] = [
  {
    name: 'gh-issue',
    description: 'Triage',
    filePath: '/skills/gh-issue/SKILL.md',
    baseDir: '/skills/gh-issue',
    disableModelInvocation: false,
    body: '# GitHub Issue Triage (gh-issue)\n\n## Overview\nUse `gh issue view`.',
  },
]

describe('matchSkillPresentation', () => {
  it('folds $name commands', () => {
    expect(matchSkillPresentation('$gh-issue 4937', skills)).toEqual({
      name: 'gh-issue',
      displayName: 'Gh Issue',
      args: '4937',
    })
  })

  it('folds already-expanded skill bodies in the user bubble', () => {
    const text =
      '# GitHub Issue Triage (gh-issue)\n\n## Overview\nUse `gh issue view`.\n\nUser: 4937 describe this'
    expect(matchSkillPresentation(text, skills)).toEqual({
      name: 'gh-issue',
      displayName: 'Gh Issue',
      args: '4937 describe this',
    })
  })
})

describe('collectInvokedSkills', () => {
  it('returns unique skills in first-seen order from the current entries', () => {
    const entries: ConversationEntry[] = [
      userEntry('u1', '$gh-issue 4937'),
      userEntry('u2', 'plain question'),
      userEntry('u3', '/skill:fix-issue please'),
      userEntry('u4', '$gh-issue again'),
    ]
    expect(collectInvokedSkills(entries, skills).map((item) => item.name)).toEqual(
      ['gh-issue', 'fix-issue'],
    )
  })

  it('collects every inline skill from a mixed user message', () => {
    expect(
      collectInvokedSkills(
        [userEntry('u1', 'hello $gh-issue 4937 then $fix-issue please')],
        [
          ...skills,
          {
            name: 'fix-issue',
            description: 'Fix',
            filePath: '/skills/fix-issue/SKILL.md',
            baseDir: '/skills/fix-issue',
            disableModelInvocation: false,
            body: 'FIX',
          },
        ],
      ).map((item) => item.name),
    ).toEqual(['gh-issue', 'fix-issue'])
  })

  it('matches already-expanded skill bodies against the catalog', () => {
    const entries: ConversationEntry[] = [
      userEntry(
        'u1',
        '# GitHub Issue Triage (gh-issue)\n\n## Overview\nUse `gh issue view`.\n\nUser: 4937',
      ),
    ]
    expect(collectInvokedSkills(entries, skills).map((item) => item.name)).toEqual(
      ['gh-issue'],
    )
  })

  it('returns nothing when no skill was invoked', () => {
    expect(
      collectInvokedSkills([userEntry('u1', 'hello')], skills),
    ).toEqual([])
  })
})

function userEntry(id: string, text: string): ConversationEntry {
  return {
    id,
    sessionId: 'sess-1',
    kind: 'user',
    version: 1,
    createdAt: 1,
    content: [{ type: 'text', text }],
  }
}
