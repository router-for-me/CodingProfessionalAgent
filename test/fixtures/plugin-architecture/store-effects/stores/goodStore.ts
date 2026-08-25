export interface State {
    count: number
    text: string
}

export function createGoodStore() {
    let state: State = { count: 0, text: '' }
    const listeners = new Set<(s: State) => void>()
    return {
        getState: () => state,
        setState: (partial: Partial<State>) => {
            state = { ...state, ...partial }
            listeners.forEach((l) => l(state))
        },
        subscribe: (l: (s: State) => void) => {
            listeners.add(l)
            return () => listeners.delete(l)
        },
    }
}
