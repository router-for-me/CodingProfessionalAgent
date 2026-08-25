import { describe, expect, it } from 'vitest'
import {
  collectInvokedSkills,
  getSkillQuery,
  insertSkillAtCaret,
  matchSkillPresentation,
  skillPresentationCommand,
  type Skill,
} from './skillPresentation.js'

const skills: Skill[] = [
  {
    name: 'gh-issue',
    description: 'Triage',
    body: '# GitHub Issue Triage (gh-issue)\n\n## Overview\nUse `gh issue view`.',
  },
]

function userEntry(id: string, text: string) {
  return {
    kind: 'user',
    id,
    sessionId: 's1',
    content: [{ type: 'text', text }],
    createdAt: 100,
  }
}

describe('getSkillQuery', () => {
  it('detects an active $query before the caret', () => {
    expect(getSkillQuery('$')).toBe('')
    expect(getSkillQuery('use $')).toBe('')
    expect(getSkillQuery('$cap')).toBe('cap')
    expect(getSkillQuery('please $alpha')).toBe('alpha')
    expect(getSkillQuery('$cap extra')).toBeNull()
    expect(getSkillQuery('price$100')).toBeNull()
    expect(getSkillQuery('$dehello world', 3)).toBe('de')
  })
})

describe('insertSkillAtCaret', () => {
  it('replaces the active $query token', () => {
    expect(insertSkillAtCaret('$dehello world', 'demo', 3)).toEqual({
      text: '$demo hello world',
      cursor: 6,
    })
    expect(insertSkillAtCaret('use $al', 'alpha')).toEqual({
      text: 'use $alpha ',
      cursor: 11,
    })
  })
})

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
    const entries = [
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
            body: 'FIX',
          },
        ],
      ).map((item) => item.name),
    ).toEqual(['gh-issue', 'fix-issue'])
  })

  it('matches already-expanded skill bodies against the catalog', () => {
    const entries = [
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
    expect(collectInvokedSkills([userEntry('u1', 'hello')], skills)).toEqual([])
  })
})

describe('skillPresentationCommand', () => {
  it('formats command with args', () => {
    expect(
      skillPresentationCommand({
        name: 'gh-issue',
        displayName: 'Gh Issue',
        args: '4937',
      }),
    ).toBe('$gh-issue 4937')
  })

  it('formats command without args', () => {
    expect(
      skillPresentationCommand({
        name: 'gh-issue',
        displayName: 'Gh Issue',
      }),
    ).toBe('$gh-issue')
  })
})
