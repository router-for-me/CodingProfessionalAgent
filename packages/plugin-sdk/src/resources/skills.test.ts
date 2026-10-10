import { mkdtemp, mkdir, writeFile, readdir, readFile, stat, realpath, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatSkillsForPrompt, loadSkills, searchSkills } from './skills.js'
import type { NativeBridge } from '../agentAdapter.js'

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const bridge: NativeBridge = {
    readFile,
    realPath: realpath,
    stat: async (path) => ({ isDir: (await stat(path)).isDirectory() }),
    readDir: async (path) => (await readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isDir: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink(),
    })),
}

describe('recursive skill discovery', () => {
    it.each(['missing', 'failing'] as const)('avoids symlink cycles when canonical paths are %s', async (mode) => {
        const root = await mkdtemp(join(tmpdir(), 'cpa-skills-cycle-'))
        roots.push(root)
        await mkdir(join(root, 'skills/parent'), { recursive: true })
        await writeFile(join(root, 'skills/parent/SKILL.md'), '---\nname: parent\ndescription: Parent\n---\nBody')
        await symlink(join(root, 'skills'), join(root, 'skills/parent/cycle'))
        const result = await loadSkills({
            agentDir: root,
            bridge: {
                ...bridge,
                realPath: mode === 'missing' ? undefined : async (path) => {
                    if (path.includes('/cycle')) throw new Error('Cannot resolve cycle')
                    return realpath(path)
                },
            },
        })
        expect(result.skills.map((skill) => skill.name)).toEqual(['parent'])
        expect(result.diagnostics.filter((item) => item.type === 'collision')).toEqual([])
    })

    it('continues below root and nested SKILL.md files while preserving precedence and avoiding cycles', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cpa-skills-'))
        roots.push(root)
        const agentDir = join(root, 'agent')
        const homeDir = join(root, 'home')
        const cwd = join(root, 'project')
        const put = async (dir: string, name: string) => {
            await mkdir(dir, { recursive: true })
            await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\nBody`)
        }
        const skillRoot = join(agentDir, 'skills')
        await put(skillRoot, 'root')
        await put(join(skillRoot, 'parent'), 'parent')
        await put(join(skillRoot, 'parent/group/deep/leaf'), 'leaf')
        await put(join(skillRoot, 'parent/duplicate'), 'parent')
        await put(join(homeDir, '.coding-professional-agent/skills/group/leaf'), 'leaf')
        await put(join(cwd, '.cpa/skills/group/project'), 'project')
        await symlink(skillRoot, join(skillRoot, 'parent/cycle'))
        const result = await loadSkills({ agentDir, homeDir, cwd, bridge })
        expect(result.skills.map((skill) => skill.name)).toEqual(['leaf', 'parent', 'project', 'root'])
        expect(result.skills[0]?.filePath).toBe(join(skillRoot, 'parent/group/deep/leaf/SKILL.md'))
        expect(result.diagnostics.filter((item) => item.type === 'collision')).toHaveLength(2)
    })
})

function skill(name: string, description: string, filePath = `/skills/${name}/SKILL.md`): {
    name: string
    description: string
    filePath: string
    baseDir: string
    disableModelInvocation: boolean
    body: string
} {
    return {
        name,
        description,
        filePath,
        baseDir: `/skills/${name}`,
        disableModelInvocation: false,
        body: 'BODY',
    }
}

describe('searchSkills', () => {
    const catalog = [
        skill('compact', '压缩会话上下文'),
        skill('publish', '发布 npm 包'),
        skill('skill_search', 'Search the skill catalog by name and description'),
        {
            ...skill('secret', '压缩会话上下文'),
            disableModelInvocation: true,
        },
    ]

    it('ranks a Chinese query against description text and hides model-disabled skills', () => {
        const matches = searchSkills(catalog, '压缩')
        expect(matches.map((match) => match.name)).toEqual(['compact'])
        expect(matches[0]).toEqual({
            name: 'compact',
            description: '压缩会话上下文',
            location: '/skills/compact/SKILL.md',
        })
    })

    it('matches underscore names from spaced queries and prefers the name hit', () => {
        const matches = searchSkills([
            skill('notes', 'publish notes about reviews'),
            skill('publish', 'ship packages'),
            ...catalog,
        ], 'publish')
        expect(matches[0]?.name).toBe('publish')
        expect(matches.map((match) => match.name)).toContain('notes')
        expect(searchSkills(catalog, 'skill search').map((match) => match.name)).toEqual(['skill_search'])
    })

    it('caps results at the requested limit', () => {
        expect(searchSkills([
            skill('one', 'shared marker'),
            skill('two', 'shared marker'),
        ], 'shared', 1)).toHaveLength(1)
    })

    it('rejects an empty query and a non-positive limit', () => {
        expect(() => searchSkills(catalog, '   ')).toThrow('query must not be empty')
        expect(() => searchSkills(catalog, 'skill', 0)).toThrow('limit must be greater than zero')
    })
})

describe('formatSkillsForPrompt', () => {
    it('tells the model to search instead of listing skill names or paths', () => {
        const text = formatSkillsForPrompt([
            skill('alpha', 'Alpha work'),
            skill('beta', 'Beta work'),
        ], true, true)
        expect(text).toContain('skill_search')
        expect(text).toContain('2 skills available')
        expect(text).toContain('read tool')
        expect(text).toContain('<skill_names>')
        expect(text).toContain('- alpha')
        expect(text).toContain('- beta')
        expect(text).not.toContain('Alpha work')
        expect(text).not.toContain('Beta work')
        expect(text).not.toContain('/skills/')
        expect(text).not.toContain('<available_skills>')
        const escaped = formatSkillsForPrompt([skill('a<b>&c', 'Unsafe description')], true, true)
        expect(escaped).toContain('- a&lt;b&gt;&amp;c')
        expect(escaped).not.toContain('Unsafe description')
    })

    it('stays empty without a read tool or without model-visible skills', () => {
        const visible = [skill('alpha', 'Alpha work')]
        expect(formatSkillsForPrompt(visible, false, true)).toBe('')
        expect(formatSkillsForPrompt(visible, true, false)).toBe('')
        expect(formatSkillsForPrompt([
            { ...skill('alpha', 'Alpha work'), disableModelInvocation: true },
        ], true, true)).toBe('')
    })
})
