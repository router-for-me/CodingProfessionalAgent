import { createContext, useContext, type ReactNode } from 'react'

const WorkspaceVisibilityContext = createContext(true)

export function WorkspaceVisibilityProvider({
    visible,
    children,
}: {
    visible: boolean
    children: ReactNode
}) {
    return (
        <WorkspaceVisibilityContext.Provider value={visible}>
            {children}
        </WorkspaceVisibilityContext.Provider>
    )
}

export function useWorkspaceVisible(): boolean {
    return useContext(WorkspaceVisibilityContext)
}
