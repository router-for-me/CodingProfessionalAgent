export function checkView(activeView: string) {
    if (activeView === 'custom-matrix-view') {
        return 'matrix-active'
    }
    return 'default'
}
