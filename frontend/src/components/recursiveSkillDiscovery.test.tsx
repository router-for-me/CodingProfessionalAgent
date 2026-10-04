import '@/i18n'
import { createElement } from 'react'
import { render, renderHook, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HostServicesProvider } from '@cpa/plugin-ui'
import { useComposerSkills } from '../../../plugins/bundled/cpa.core.composer/renderer/utils/useComposerSkills.js'
import { SkillsSection } from '../../../plugins/bundled/cpa.core.subagent/renderer/components/SkillsSection.js'

function createServices() {
    const root = '/config/coding-professional-agent/agent/skills'
    const directories: Record<string, string[]> = {
        [root]: ['parent', 'empty', 'broken'],
        [`${root}/parent`]: ['group', 'duplicate'],
        [`${root}/parent/group`]: ['deep'],
        [`${root}/empty`]: ['leaf'],
        [`${root}/broken`]: ['child'],
        '/home/.coding-professional-agent/skills': ['duplicate'],
        '/project/.cpa/skills': ['group'],
        '/project/.cpa/skills/group': ['project'],
    }
    const files: Record<string, string> = {
        [`${root}/SKILL.md`]: 'root',
        [`${root}/parent/SKILL.md`]: 'parent',
        [`${root}/parent/group/deep/SKILL.md`]: 'deep',
        [`${root}/parent/duplicate/SKILL.md`]: 'PARENT',
        [`${root}/empty/leaf/SKILL.md`]: 'leaf',
        [`${root}/broken/child/SKILL.md`]: 'child',
        '/home/.coding-professional-agent/skills/duplicate/SKILL.md': 'PARENT',
        '/project/.cpa/skills/group/project/SKILL.md': 'project',
    }
    let available: any[] = []
    const services: any = {
        fileSystem: {
            getRuntimeInfo: async () => ({ userConfigDir: '/config', homeDir: '/home' }),
            readDir: async (path: string) => [
                ...(directories[path] ?? []).map((name) => ({
                    name, path: `${path}/${name}`, isDirectory: true, isFile: false,
                })),
                // A provider may expose a repeated directory or a directory symlink.
                ...(path === `${root}/parent` ? [
                    { name: 'cycle', path: root, isDirectory: true, isFile: false },
                    { name: 'link', path: `${path}/link`, isDirectory: true, isFile: false, isSymbolicLink: true },
                ] : []),
            ],
            readFile: async (path: string) => {
                if (!(path in files)) throw new Error('ENOENT')
                return { dataBase64: btoa(`---\nname: ${files[path]}\ndescription: Description ${files[path]}\n---\nBody`) }
            },
        },
        projects: { getSnapshot: () => [{ id: 'p', path: '/project' }] },
        sessions: { getSnapshot: () => [{ id: 's', projectId: 'p' }], getCurrentSessionId: () => 's' },
        skillUsage: {
            getAvailableSkills: () => available,
            setAvailableSkills: (skills: any[]) => { available = skills },
        },
    }
    return { services, getAvailable: () => available, root }
}

describe('recursive UI skill discovery', () => {
    it('publishes root and deeply nested composer skills without replacing first same-name matches', async () => {
        const { services, root } = createServices()
        const { result, unmount } = renderHook(() => useComposerSkills(), {
            wrapper: ({ children }) => createElement(HostServicesProvider, { services, children }),
        })
        await waitFor(() => expect(result.current.map((skill) => skill.name).sort()).toEqual([
            'child', 'deep', 'leaf', 'parent', 'project', 'root',
        ]))
        expect(result.current.find((skill) => skill.name === 'parent')?.filePath).toBe(`${root}/parent/SKILL.md`)
        unmount()
        delete (globalThis as any).__cpaComposerSkills
    })

    it('shows deeply nested skills in settings when no composer catalog exists', async () => {
        const { services, getAvailable, root } = createServices()
        render(createElement(HostServicesProvider, { services, children: createElement(SkillsSection) }))
        await waitFor(() => expect(getAvailable().map((skill) => skill.name).sort()).toEqual([
            'child', 'deep', 'leaf', 'parent', 'project', 'root',
        ]))
        expect(screen.getByText('deep')).toBeDefined()
        expect(getAvailable().find((skill) => skill.name === 'parent')?.filePath).toBe(`${root}/parent/SKILL.md`)
    })
})
