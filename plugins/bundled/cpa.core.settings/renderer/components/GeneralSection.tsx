import { useMemo } from 'react'
import {
    useHostService,
    useSettings,
    useTranslation,
} from '@cpa/plugin-ui'
import {
    SettingsServiceToken,
    isMacPlatform,
    type EditorFollowUpMode,
    type EditorSendShortcut,
    type EditorSettings,
    type Locale,
    type Speed,
    type TerminalPosition,
} from '@cpa/plugin-api'
import {
    SegmentedControl,
    SettingsCard,
    SettingsPercentInput,
    SettingsRow,
    SettingsSection,
    SettingsSelect,
    ToggleSwitch,
} from './SettingsControls.js'
import { UpdateSection } from './UpdateSection.js'

const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
    showContextUsage: true,
    sendShortcut: 'cmdEnter',
    followUpMode: 'steer',
}

/**
 * CPA-style General settings: permissions + general preferences.
 * Language and core settings are wired to SettingsService.
 */
export function GeneralSection() {
    const { t } = useTranslation()
    const settingsService = useHostService(SettingsServiceToken)
    const settings = useSettings()

    const locale = settings.locale ?? 'zh-CN'
    const setLocale = (val: Locale) => settingsService?.setLocale?.(val)

    const compactionThresholdPercent = settings.compactionThresholdPercent ?? 80
    const setCompactionThresholdPercent = (val: number) =>
        settingsService?.setCompactionThresholdPercent?.(val)

    const fastContextCompaction = settings.fastContextCompaction ?? true
    const setFastContextCompaction = (val: boolean) =>
        settingsService?.setFastContextCompaction?.(val)

    const resumeUnfinishedConversations = settings.resumeUnfinishedConversations ?? true
    const setResumeUnfinishedConversations = (val: boolean) =>
        settingsService?.setResumeUnfinishedConversations?.(val)

    const preventSleep = settings.preventSleep ?? true
    const setPreventSleep = (val: boolean) =>
        settingsService?.setPreventSleep?.(val)

    const showInMenuBar = settings.showInMenuBar ?? true
    const setShowInMenuBar = (val: boolean) =>
        settingsService?.setShowInMenuBar?.(val)

    const showBottomPanel = settings.showBottomPanel ?? true
    const setShowBottomPanel = (val: boolean) =>
        settingsService?.setShowBottomPanel?.(val)

    const terminalPosition = settings.terminalPosition ?? 'bottom'
    const setTerminalPosition = (val: TerminalPosition) =>
        settingsService?.setTerminalPosition?.(val)

    const speed = settings.speed ?? 'standard'
    const setSpeed = (val: Speed) => settingsService?.setSpeed?.(val)

    const editor: EditorSettings = settings.editor ?? DEFAULT_EDITOR_SETTINGS
    const setEditorSettings = (partial: Partial<EditorSettings>) =>
        settingsService?.setEditorSettings?.(partial)

    const isMac = useMemo(() => isMacPlatform(), [])
    const showContextUsage = editor.showContextUsage ?? DEFAULT_EDITOR_SETTINGS.showContextUsage
    const sendShortcut = (editor.sendShortcut ?? DEFAULT_EDITOR_SETTINGS.sendShortcut) as EditorSendShortcut
    const followUpMode = (editor.followUpMode ?? DEFAULT_EDITOR_SETTINGS.followUpMode) as EditorFollowUpMode

    const sendShortcutOptions = useMemo(
        () => [
            {
                value: 'cmdEnter' as const,
                label: isMac
                    ? t('settings.editor.sendShortcut.cmdEnter.mac', '⌘ + Enter to send')
                    : t('settings.editor.sendShortcut.cmdEnter.other', 'Ctrl + Enter to send'),
            },
            {
                value: 'enter' as const,
                label: t('settings.editor.sendShortcut.enter', 'Enter to send'),
            },
        ],
        [isMac, t],
    )

    const followUpOptions = useMemo(
        () => [
            {
                value: 'queue' as const,
                label: t('settings.editor.followUpMode.queue', 'Queue'),
            },
            {
                value: 'steer' as const,
                label: t('settings.editor.followUpMode.steer', 'Steer'),
            },
        ],
        [t],
    )

    const followUpDesc = isMac
        ? t(
              'settings.editor.followUpMode.desc.mac',
              'Queue follow-up messages while CPA is running, or steer the current run. Press ⇧⌘↵ for the opposite on a single message',
          )
        : t(
              'settings.editor.followUpMode.desc.other',
              'Queue follow-up messages while CPA is running, or steer the current run. Press Shift+Ctrl+Enter for the opposite on a single message',
          )

    return (
        <div className="mx-auto w-full max-w-[760px] space-y-6 px-8 pt-8 pb-12">
            <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
                {t('settings.nav.general')}
            </h1>

            <SettingsSection id="setting-permissions" title={t('settings.general.permissions')}>
                <SettingsCard>
                    <SettingsRow
                        id="setting-defaultPermissions"
                        title={t('settings.general.defaultPermissions')}
                        description={t('settings.general.defaultPermissions.desc')}
                        control={
                            <ToggleSwitch
                                checked={true}
                                disabled={true}
                                label={t('settings.general.defaultPermissions')}
                                onChange={() => {}}
                            />
                        }
                        last
                    />
                </SettingsCard>
            </SettingsSection>

            <SettingsSection title={t('settings.general.section')}>
                <SettingsCard>
                    <SettingsRow
                        id="setting-language"
                        title={t('settings.language')}
                        description={t('settings.general.language.desc')}
                        control={
                            <SettingsSelect<Locale>
                                ariaLabel={t('settings.language')}
                                value={locale}
                                options={[
                                    {
                                        value: 'zh-CN',
                                        label: t('settings.language.zh-CN'),
                                    },
                                    {
                                        value: 'en',
                                        label: t('settings.language.en'),
                                    },
                                ]}
                                onChange={setLocale}
                            />
                        }
                    />
                    <SettingsRow
                        id="setting-compactionThreshold"
                        title={t('settings.general.compactionThreshold')}
                        description={t('settings.general.compactionThreshold.desc')}
                        control={
                            <SettingsPercentInput
                                ariaLabel={t('settings.general.compactionThreshold')}
                                value={compactionThresholdPercent}
                                min={1}
                                max={100}
                                onChange={setCompactionThresholdPercent}
                            />
                        }
                    />
                    <SettingsRow
                        id="setting-fastContextCompaction"
                        title={t('settings.general.fastContextCompaction')}
                        description={t('settings.general.fastContextCompaction.desc')}
                        control={
                            <ToggleSwitch
                                checked={fastContextCompaction}
                                label={t('settings.general.fastContextCompaction')}
                                onChange={setFastContextCompaction}
                            />
                        }
                    />
                    <SettingsRow
                        id="setting-resumeUnfinishedConversations"
                        title={t('settings.general.resumeUnfinishedConversations')}
                        description={t('settings.general.resumeUnfinishedConversations.desc')}
                        control={
                            <ToggleSwitch
                                checked={resumeUnfinishedConversations ?? true}
                                label={t('settings.general.resumeUnfinishedConversations')}
                                onChange={setResumeUnfinishedConversations}
                            />
                        }
                    />
                    <SettingsRow
                        id="setting-menuBar"
                        title={t('settings.general.menuBar')}
                        description={t('settings.general.menuBar.desc')}
                        control={
                            <ToggleSwitch
                                checked={showInMenuBar}
                                label={t('settings.general.menuBar')}
                                onChange={setShowInMenuBar}
                            />
                        }
                    />
                    <SettingsRow
                        id="setting-bottomPanel"
                        title={t('settings.general.bottomPanel')}
                        description={t('settings.general.bottomPanel.desc')}
                        control={
                            <ToggleSwitch
                                checked={showBottomPanel}
                                label={t('settings.general.bottomPanel')}
                                onChange={setShowBottomPanel}
                            />
                        }
                    />
                    {showBottomPanel ? (
                        <SettingsRow
                            id="setting-terminalPosition"
                            title={t('settings.general.terminalPosition')}
                            description={t('settings.general.terminalPosition.desc')}
                            control={
                                <SegmentedControl<TerminalPosition>
                                    ariaLabel={t('settings.general.terminalPosition')}
                                    value={terminalPosition}
                                    options={[
                                        {
                                            value: 'bottom',
                                            label: t('settings.general.terminalPosition.bottom'),
                                        },
                                        {
                                            value: 'right',
                                            label: t('settings.general.terminalPosition.right'),
                                        },
                                    ]}
                                    onChange={setTerminalPosition}
                                />
                            }
                        />
                    ) : null}
                    <SettingsRow
                        id="setting-preventSleep"
                        title={t('settings.general.preventSleep')}
                        description={t('settings.general.preventSleep.desc')}
                        control={
                            <ToggleSwitch
                                checked={preventSleep}
                                label={t('settings.general.preventSleep')}
                                onChange={setPreventSleep}
                            />
                        }
                    />
                    <SettingsRow
                        id="setting-speed"
                        title={t('settings.general.speed')}
                        description={t('settings.general.speed.desc')}
                        control={
                            <SettingsSelect<Speed>
                                ariaLabel={t('settings.general.speed')}
                                value={speed === 'fast' ? 'fast' : 'standard'}
                                options={[
                                    {
                                        value: 'standard',
                                        label: t('settings.general.speed.standard'),
                                    },
                                    {
                                        value: 'fast',
                                        label: t('settings.general.speed.fast'),
                                    },
                                ]}
                                onChange={setSpeed}
                            />
                        }
                        last
                    />
                </SettingsCard>
            </SettingsSection>

            <SettingsSection id="setting-editor" title={t('settings.editor.title', 'Editor')}>
                <SettingsCard>
                    <SettingsRow
                        id="setting-showContextUsage"
                        title={t('settings.editor.showContextUsage', 'Show context window usage')}
                        control={
                            <ToggleSwitch
                                checked={showContextUsage}
                                label={t('settings.editor.showContextUsage', 'Show context window usage')}
                                onChange={(val) => setEditorSettings({ showContextUsage: val })}
                            />
                        }
                    />
                    <SettingsRow
                        id="setting-sendShortcut"
                        title={t('settings.editor.sendShortcut', 'Send shortcut')}
                        description={t(
                            'settings.editor.sendShortcut.desc',
                            'Choose whether pressing Enter sends the prompt or inserts a newline',
                        )}
                        control={
                            <SettingsSelect
                                value={sendShortcut}
                                options={sendShortcutOptions}
                                ariaLabel={t('settings.editor.sendShortcut', 'Send shortcut')}
                                onChange={(val) => setEditorSettings({ sendShortcut: val })}
                            />
                        }
                    />
                    <SettingsRow
                        id="setting-followUpMode"
                        title={t('settings.editor.followUpMode', 'Follow-up mode')}
                        description={followUpDesc}
                        control={
                            <SegmentedControl
                                value={followUpMode}
                                options={followUpOptions}
                                ariaLabel={t('settings.editor.followUpMode', 'Follow-up mode')}
                                onChange={(val) => setEditorSettings({ followUpMode: val })}
                            />
                        }
                        last
                    />
                </SettingsCard>
            </SettingsSection>

            <UpdateSection />
        </div>
    )
}
