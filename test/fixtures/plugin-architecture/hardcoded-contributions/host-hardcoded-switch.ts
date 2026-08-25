export function handleAction(actionId: string) {
    switch (actionId) {
        case 'custom-matrix-action':
            return 100
        default:
            return 0
    }
}
