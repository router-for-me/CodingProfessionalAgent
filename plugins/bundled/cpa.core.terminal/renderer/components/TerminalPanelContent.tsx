import React, { useMemo } from 'react'
import { useTerminalStore, type TerminalLocation } from '../stores/terminalStore.js'
import { TerminalView } from './TerminalView.js'

export interface TerminalPanelContentProps {
    location?: TerminalLocation
    visible?: boolean
    sessionId?: string | null
}

/**
 * Renders active/inactive terminal instances inside the panel slot.
 */
export function TerminalPanelContent({
    location = 'bottom',
    visible = true,
}: TerminalPanelContentProps): React.ReactNode {
    const allTabs = useTerminalStore((state) => state.tabs)
    const tabs = useMemo(
        () => allTabs.filter((tab) => (tab.location ?? 'bottom') === location),
        [allTabs, location],
    )
    const activeTabIdByLocation = useTerminalStore((state) => state.activeTabIdByLocation)
    const globalActiveTabId = useTerminalStore((state) => state.activeTabId)
    const activeTabId =
        activeTabIdByLocation?.[location] ??
        tabs.find((tab) => tab.id === globalActiveTabId)?.id ??
        tabs[tabs.length - 1]?.id ??
        null

    return (
        <>
            {tabs.map((tab) => (
                <TerminalView
                    key={tab.id}
                    tabId={tab.id}
                    cwd={tab.cwd}
                    active={tab.id === activeTabId}
                    visible={visible}
                />
            ))}
        </>
    )
}
