import { definePluginEntry } from '@cpa/plugin-sdk'
import type {
    ActionContribution,
    PluginContext,
    SettingsSectionContribution,
} from '@cpa/plugin-api'
import { Boxes } from '@cpa/plugin-ui'
import { WorktreesSection } from './components/WorktreesSection.js'

export { WorktreesSection }

export const worktreeRendererEntry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        // 1. Register Worktrees Settings Section
        context.register<SettingsSectionContribution>({
            kind: 'settings',
            id: 'worktrees',
            value: {
                id: 'worktrees',
                groupId: 'code',
                order: 50,
                labelKey: 'settings.nav.worktrees',
                icon: Boxes,
                component: WorktreesSection,
                keywords: ['worktrees', 'git worktree', 'isolation', 'branches'],
                items: [
                    {
                        id: 'rootDir',
                        labelKey: 'settings.worktrees.rootDir',
                        descriptionKey: 'settings.worktrees.rootDir.desc',
                        keywords: ['root dir', 'directory'],
                    },
                    {
                        id: 'fetchUpstream',
                        labelKey: 'settings.worktrees.fetchUpstream',
                        descriptionKey: 'settings.worktrees.fetchUpstream.desc',
                        keywords: ['fetch upstream'],
                    },
                    {
                        id: 'autoDeleteOld',
                        labelKey: 'settings.worktrees.autoDeleteOld',
                        descriptionKey: 'settings.worktrees.autoDeleteOld.desc',
                        keywords: ['auto delete'],
                    },
                    {
                        id: 'deleteLimit',
                        labelKey: 'settings.worktrees.deleteLimit',
                        descriptionKey: 'settings.worktrees.deleteLimit.desc',
                        keywords: ['delete limit'],
                    },
                    {
                        id: 'activeWorktrees',
                        labelKey: 'settings.worktrees.activeTitle',
                        keywords: ['managed worktrees'],
                    },
                ],
            },
        })

        // 2. Register Action
        context.register<ActionContribution>({
            kind: 'action',
            id: 'toggle-local-worktree',
            value: {
                id: 'toggle-local-worktree',
                title: 'shortcuts.item.toggleLocalWorktree.title',
                description: 'shortcuts.item.toggleLocalWorktree.desc',
                handler: () => {
                    void context.events?.emit?.('worktree:toggle-local', {})
                },
            },
        })
    },
})

export const entry = worktreeRendererEntry
export default worktreeRendererEntry
