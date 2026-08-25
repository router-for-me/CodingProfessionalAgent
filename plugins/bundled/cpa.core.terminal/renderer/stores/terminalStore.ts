import { useSyncExternalStore } from 'react'

export type TerminalLocation = 'bottom' | 'right'

export interface TerminalTab {
    id: string
    title: string
    cwd: string
    location?: TerminalLocation
}

export interface TerminalStateData {
    tabs: TerminalTab[]
    activeTabId: string | null
    activeTabIdByLocation: Record<TerminalLocation, string | null>
}

export interface TerminalStateActions {
    addTab: (input: { title: string; cwd: string; location?: TerminalLocation }) => string
    closeTab: (id: string) => void
    setActiveTab: (id: string, location?: TerminalLocation) => void
    reset: () => void
}

export type TerminalStoreState = TerminalStateData & TerminalStateActions

let internalState: TerminalStateData = {
    tabs: [],
    activeTabId: null,
    activeTabIdByLocation: { bottom: null, right: null },
}

const listeners = new Set<() => void>()

function notify(): void {
    listeners.forEach((l) => l())
}

let counter = 0
function generateId(): string {
    counter += 1
    return `term-${Date.now().toString(36)}-${counter.toString(36)}`
}

function getState(): TerminalStoreState {
    return {
        ...internalState,
        addTab,
        closeTab,
        setActiveTab,
        reset,
    }
}

function setState(patch: Partial<TerminalStateData> | ((curr: TerminalStateData) => Partial<TerminalStateData>)): void {
    const nextPatch = typeof patch === 'function' ? patch(internalState) : patch
    internalState = { ...internalState, ...nextPatch }
    notify()
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

function addTab(input: { title: string; cwd: string; location?: TerminalLocation }): string {
    const id = generateId()
    const location: TerminalLocation = input.location ?? 'bottom'
    const tab: TerminalTab = {
        id,
        title: input.title,
        cwd: input.cwd,
        location,
    }
    internalState = {
        ...internalState,
        tabs: [...internalState.tabs, tab],
        activeTabId: id,
        activeTabIdByLocation: {
            ...internalState.activeTabIdByLocation,
            [location]: id,
        },
    }
    notify()
    return id
}

function closeTab(id: string): void {
    const closingTab = internalState.tabs.find((tab) => tab.id === id)
    const location: TerminalLocation = closingTab?.location ?? 'bottom'
    const tabs = internalState.tabs.filter((tab) => tab.id !== id)
    const remainingForLocation = tabs.filter(
        (tab) => (tab.location ?? 'bottom') === location,
    )
    const activeForLocation =
        internalState.activeTabIdByLocation?.[location] === id
            ? (remainingForLocation[remainingForLocation.length - 1]?.id ?? null)
            : (internalState.activeTabIdByLocation?.[location] ?? null)

    const activeTabId =
        internalState.activeTabId === id
            ? (tabs[tabs.length - 1]?.id ?? null)
            : internalState.activeTabId

    internalState = {
        ...internalState,
        tabs,
        activeTabId,
        activeTabIdByLocation: {
            ...internalState.activeTabIdByLocation,
            [location]: activeForLocation,
        },
    }
    notify()
}

function setActiveTab(id: string, location?: TerminalLocation): void {
    const targetTab = internalState.tabs.find((tab) => tab.id === id)
    const tabLocation: TerminalLocation =
        location ?? targetTab?.location ?? 'bottom'
    internalState = {
        ...internalState,
        activeTabId: id,
        activeTabIdByLocation: {
            ...internalState.activeTabIdByLocation,
            [tabLocation]: id,
        },
    }
    notify()
}

function reset(): void {
    internalState = {
        tabs: [],
        activeTabId: null,
        activeTabIdByLocation: { bottom: null, right: null },
    }
    notify()
}

/**
 * Universal terminal store matching Zustand hook and vanilla store interface.
 */
export function useTerminalStore<T = TerminalStoreState>(
    selector: (state: TerminalStoreState) => T = (s) => s as unknown as T,
): T {
    return useSyncExternalStore(
        subscribe,
        () => selector(getState()),
        () => selector(getState()),
    )
}

useTerminalStore.getState = getState
useTerminalStore.setState = setState
useTerminalStore.subscribe = subscribe
useTerminalStore.addTab = addTab
useTerminalStore.closeTab = closeTab
useTerminalStore.setActiveTab = setActiveTab
useTerminalStore.reset = reset
