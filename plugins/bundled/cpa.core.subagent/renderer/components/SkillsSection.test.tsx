import i18n from '@/i18n'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HostServicesProvider } from '@cpa/plugin-ui'
import { SkillsSection, type SkillItem } from './SkillsSection.js'
import type { AppSettings, SkillsSettings } from '@cpa/plugin-api'

const sampleSkills: SkillItem[] = [
    {
        name: 'gh-issue',
        description: 'Triage GitHub issues in repository',
        filePath: '/home/user/.coding-professional-agent/skills/gh-issue/SKILL.md',
        baseDir: '/home/user/.coding-professional-agent/skills/gh-issue',
    },
    {
        name: 'fix-issue',
        description: 'Implement automated GitHub issue fixes',
        filePath: '/home/user/.coding-professional-agent/skills/fix-issue/SKILL.md',
        baseDir: '/home/user/.coding-professional-agent/skills/fix-issue',
    },
    {
        name: 'code-review',
        description: 'Review pull requests with AI',
        filePath: '/home/user/.coding-professional-agent/skills/code-review/SKILL.md',
        baseDir: '/home/user/.coding-professional-agent/skills/code-review',
    },
]

describe('SkillsSection', () => {
    let mockSettings: AppSettings
    let mockUpdate: ReturnType<typeof vi.fn>
    let mockSetSkillsSettings: ReturnType<typeof vi.fn>
    let mockOpenSettings: ReturnType<typeof vi.fn>
    let mockAvailableSkills: SkillItem[]
    let listeners: Set<(settings: AppSettings) => void>

    beforeEach(async () => {
        await i18n.changeLanguage('zh-CN')
        listeners = new Set()
        mockUpdate = vi.fn((patch: Partial<AppSettings>) => {
            mockSettings = { ...mockSettings, ...patch }
            listeners.forEach((l) => l(mockSettings))
            return Promise.resolve()
        })
        mockSetSkillsSettings = vi.fn((partial: Partial<SkillsSettings>) => {
            mockSettings = {
                ...mockSettings,
                skills: { ...(mockSettings.skills ?? { defaultMode: 'auto' }), ...partial },
            }
            listeners.forEach((l) => l(mockSettings))
        })
        mockOpenSettings = vi.fn()
        mockAvailableSkills = [...sampleSkills]
        mockSettings = {
            theme: 'dark',
            locale: 'zh-CN',
            skills: {
                defaultMode: 'auto',
                skills: {
                    'fix-issue': 'explicit',
                },
            },
        } as any
    })

    function renderComponent() {
        const services: any = {
            settings: {
                getSnapshot: () => mockSettings,
                subscribe: (fn: any) => {
                    listeners.add(fn)
                    return () => listeners.delete(fn)
                },
                update: mockUpdate,
                setSkillsSettings: mockSetSkillsSettings,
            },
            skillUsage: {
                getAvailableSkills: () => mockAvailableSkills,
                subscribeAvailableSkills: vi.fn(() => () => {}),
                setAvailableSkills: vi.fn(),
            },
            ui: {
                openSettings: mockOpenSettings,
            },
            fileSystem: {
                getRuntimeInfo: vi.fn().mockResolvedValue({
                    homeDir: '/home/user',
                    userConfigDir: '/home/user/.config',
                }),
                readDir: vi.fn().mockResolvedValue([]),
            },
            projects: {
                getSnapshot: () => [],
            },
            sessions: {
                getSnapshot: () => [],
                getCurrentSessionId: () => null,
            },
        }

        return render(
            <HostServicesProvider services={services}>
                <SkillsSection />
            </HostServicesProvider>,
        )
    }

    it('renders the header correctly', () => {
        renderComponent()

        expect(screen.getByRole('heading', { level: 1, name: '技能' })).toBeDefined()
        expect(
            screen.getByText('配置技能的默认调用模式与独立技能的注册与展开策略。'),
        ).toBeDefined()
    })

    it('displays the default mode control and updates when changed', async () => {
        renderComponent()

        expect(screen.getByText('基础设置')).toBeDefined()
        expect(screen.getByText('默认使用模式')).toBeDefined()

        const defaultModeSelect = screen.getByRole('combobox', {
            name: '默认使用模式',
        })
        expect(defaultModeSelect).toBeDefined()
        expect(defaultModeSelect.textContent).toContain('自动注册')

        fireEvent.click(defaultModeSelect)

        const explicitOption = await screen.findByRole('option', { name: '显性使用' })
        fireEvent.click(explicitOption)

        expect(mockSetSkillsSettings).toHaveBeenCalledWith(
            expect.objectContaining({ defaultMode: 'explicit' }),
        )
    })

    it('offers exactly the three supported trigger shortcuts', async () => {
        renderComponent()
        const select = screen.getByRole('combobox', { name: '技能触发快捷键' })
        expect(select).toHaveTextContent('$')
        fireEvent.click(select)
        expect(screen.getAllByRole('option').map((item) => item.textContent)).toEqual(['$', '#', '/'])
        fireEvent.click(screen.getByRole('option', { name: '#' }))
        expect(mockSetSkillsSettings).toHaveBeenCalledWith(expect.objectContaining({ trigger: '#' }))
    })

    it('lists all skills with name, description, and directory', () => {
        renderComponent()

        expect(screen.getByText('gh-issue')).toBeDefined()
        expect(screen.getByText('Triage GitHub issues in repository')).toBeDefined()
        expect(
            screen.getByText('/home/user/.coding-professional-agent/skills/gh-issue'),
        ).toBeDefined()

        expect(screen.getByText('fix-issue')).toBeDefined()
        expect(screen.getByText('Implement automated GitHub issue fixes')).toBeDefined()
        expect(
            screen.getByText('/home/user/.coding-professional-agent/skills/fix-issue'),
        ).toBeDefined()

        expect(screen.getByText('code-review')).toBeDefined()
    })

    it('filters skills according to the search query', () => {
        renderComponent()

        const searchInput = screen.getByPlaceholderText('搜索技能名称、描述或目录...')
        fireEvent.change(searchInput, { target: { value: 'fix' } })

        expect(screen.getByText('fix-issue')).toBeDefined()
        expect(screen.queryByText('gh-issue')).toBeNull()
        expect(screen.queryByText('code-review')).toBeNull()
    })

    it('shows empty search state when no skills match', () => {
        renderComponent()

        const searchInput = screen.getByPlaceholderText('搜索技能名称、描述或目录...')
        fireEvent.change(searchInput, { target: { value: 'non-existing-keyword' } })

        expect(screen.getByText('未找到匹配的技能')).toBeDefined()
    })

    it('changes a specific skill mode when an option is selected', async () => {
        renderComponent()

        const ghIssueSelect = screen.getByRole('combobox', {
            name: '为 gh-issue 选择使用模式',
        })
        expect(ghIssueSelect).toBeDefined()

        fireEvent.click(ghIssueSelect)

        // Verifies the option label is purely "全局设置" without suffixes like "(自动注册)"
        const defaultOption = await screen.findByRole('option', { name: '全局设置' })
        expect(defaultOption).toBeDefined()
        expect(defaultOption.textContent).toBe('全局设置')

        const disabledOption = await screen.findByRole('option', { name: '禁用' })
        fireEvent.click(disabledOption)

        expect(mockSetSkillsSettings).toHaveBeenCalledWith(
            expect.objectContaining({
                skills: expect.objectContaining({ 'gh-issue': 'disabled' }),
            }),
        )
    })
})
