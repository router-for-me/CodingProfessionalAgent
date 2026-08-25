import { useEffect, useMemo, useState } from 'react'
import { useHostServices } from '@cpa/plugin-ui'
import type { Skill } from '../types.js'

function parseFrontmatter(raw: string): { frontmatter: Record<string, any>; body: string } {
    if (!raw.startsWith('---')) {
        return { frontmatter: {}, body: raw }
    }
    const end = raw.indexOf('\n---', 3)
    if (end === -1) {
        return { frontmatter: {}, body: raw }
    }
    const yaml = raw.slice(3, end).trim()
    const body = raw.slice(end + 4).replace(/^\r?\n/, '')
    const frontmatter: Record<string, any> = {}

    for (const line of yaml.split(/\r?\n/)) {
        const colon = line.indexOf(':')
        if (colon !== -1) {
            const key = line.slice(0, colon).trim()
            let val: any = line.slice(colon + 1).trim()
            if (val === 'true') val = true
            else if (val === 'false') val = false
            else if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
            else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1)
            frontmatter[key] = val
        }
    }

    return { frontmatter, body }
}

function base64ToUtf8(base64: string): string {
    try {
        const bin = atob(base64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) {
            bytes[i] = bin.charCodeAt(i)
        }
        return new TextDecoder('utf-8').decode(bytes)
    } catch {
        return ''
    }
}

/**
 * Publish discovered composer skills for cross-plugin consumers (e.g. chat
 * message edit) that cannot import useComposerSkills directly.
 */
export function publishComposerSkills(skills: readonly Skill[]): void {
    if (typeof globalThis === 'undefined') return
    ;(globalThis as any).__cpaComposerSkills = skills
}

export function useComposerSkills(customProjectId?: string | null): readonly Skill[] {
    const services = useHostServices()
    const sessions = services?.sessions?.getSnapshot?.() ?? []
    const currentSessionId = services?.sessions?.getCurrentSessionId?.() ?? null
    const pendingContext = services?.ui?.getPendingSessionContext?.() ?? { projectId: null, branch: null }
    const projects = services?.projects?.getSnapshot?.() ?? []

    const cwd = useMemo(() => {
        let projectId: string | null | undefined = customProjectId
        if (projectId === undefined) {
            const session = sessions.find((item: any) => item.id === currentSessionId)
            projectId = session ? (session.projectId ?? null) : pendingContext.projectId
        }
        const project = projects.find((item: any) => item.id === projectId)
        return project ? (project.paths?.[0] || project.path) : undefined
    }, [customProjectId, sessions, currentSessionId, pendingContext.projectId, projects])

    const [skills, setSkills] = useState<readonly Skill[]>([])

    useEffect(() => {
        let cancelled = false
        if (!services?.fileSystem) return

        void (async () => {
            try {
                void services?.skillUsage?.fetchUsageCounts?.()?.catch?.(() => {})
                const fs = services.fileSystem!
                const runtimeInfo = await fs.getRuntimeInfo?.().catch?.(() => null)
                const homeDir = runtimeInfo?.homeDir
                const userConfigDir = runtimeInfo?.userConfigDir
                const discovered: Skill[] = []
                const seen = new Set<string>()

                const scanDir = async (dir: string) => {
                    try {
                        const entries = await fs.readDir?.(dir)
                        if (!entries || !Array.isArray(entries)) return
                        for (const entry of entries) {
                            if (entry.isDirectory) {
                                const skillMdPath = `${entry.path}/SKILL.md`
                                try {
                                    const file = await fs.readFileIfExists?.(skillMdPath) ?? await fs.readFile(skillMdPath).catch(() => null)
                                    if (file && file.dataBase64) {
                                        const content = base64ToUtf8(file.dataBase64)
                                        const { frontmatter, body } = parseFrontmatter(content)
                                        const name = (frontmatter.name || entry.name).toLowerCase()
                                        if (!seen.has(name)) {
                                            seen.add(name)
                                            discovered.push({
                                                name: frontmatter.name || entry.name,
                                                description: frontmatter.description || '',
                                                filePath: skillMdPath,
                                                baseDir: entry.path,
                                                disableModelInvocation: Boolean(frontmatter['disable-model-invocation']),
                                                body,
                                            })
                                        }
                                    }
                                } catch {
                                    // Skip invalid skill file
                                }
                            }
                        }
                    } catch {
                        // Directory does not exist, ignore
                    }
                }

                // 1. App agent skills: <userConfigDir>/coding-professional-agent/agent/skills
                if (userConfigDir) {
                    await scanDir(`${userConfigDir}/coding-professional-agent/agent/skills`)
                }
                // 2. User home skills: <homeDir>/.coding-professional-agent/skills
                if (homeDir) {
                    await scanDir(`${homeDir}/.coding-professional-agent/skills`)
                }
                // 3. Project skills: <cwd>/.cpa/skills
                if (cwd) {
                    await scanDir(`${cwd}/.cpa/skills`)
                }

                if (!cancelled) {
                    publishComposerSkills(discovered)
                    services?.skillUsage?.setAvailableSkills?.(discovered)
                    setSkills(discovered)
                }
            } catch {
                if (!cancelled) {
                    publishComposerSkills([])
                    services?.skillUsage?.setAvailableSkills?.([])
                    setSkills([])
                }
            }
        })()

        return () => {
            cancelled = true
        }
    }, [cwd, services])

    return skills
}
