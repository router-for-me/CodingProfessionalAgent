import { getHostServices } from './createHostServices.js'
import {
    HostServicesProvider as BaseProvider,
    useHostServices as useBaseHostServices,
    useHostService as useBaseHostService,
    useSessions,
    useProjects,
    useNavigationItems,
    useUiState,
    useActiveRun,
    setDefaultHostServices,
    getDefaultHostServices,
    type HostServicesProviderProps,
} from '@cpa/plugin-ui'

export {
    BaseProvider as HostServicesProvider,
    getDefaultHostServices,
    setDefaultHostServices,
    useSessions,
    useProjects,
    useNavigationItems,
    useUiState,
    useActiveRun,
    type HostServicesProviderProps,
}

export function useHostServices() {
    const services = useBaseHostServices()
    return services ?? getHostServices()
}

export function useHostService<T>(token: any): T {
    const service = useBaseHostService<T>(token)
    if (service) return service
    const services = useHostServices()
    const tokenId = typeof token === 'string' ? token : token.id
    const match = Object.entries(services).find(([k]) => k === tokenId)
    if (match) return match[1] as T
    return (services as any)[tokenId] as T
}
