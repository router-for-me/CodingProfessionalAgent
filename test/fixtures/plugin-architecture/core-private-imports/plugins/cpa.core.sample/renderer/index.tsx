import { useSessionStore } from '@/stores/sessionStore'
import { AppHeader } from '@/components/layout/AppHeader'

export function activateCorePlugin() {
    const store = useSessionStore()
    return { store, AppHeader }
}
