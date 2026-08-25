import { HostActionRegistry, HostViewRegistry } from '@/application/services/tokens'

const TARGET_VIEW_ID = 'custom-matrix-view'
const ACTIONS = {
    matrixAction: 'custom-matrix-action',
}
const PANELS = ['custom-matrix-panel', 'other-panel']

export function routeView(currentView: string, registry: HostViewRegistry) {
    if (currentView === TARGET_VIEW_ID) {
        return registry.get(TARGET_VIEW_ID)
    }
    if (PANELS.includes(currentView)) {
        return true
    }
    return false
}

export function triggerAction(actionRegistry: HostActionRegistry) {
    return actionRegistry.get(ACTIONS.matrixAction)
}
