import { mkdtemp, mkdir, writeFile, readdir, readFile, stat, realpath, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadSkills } from './skills.js'
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
