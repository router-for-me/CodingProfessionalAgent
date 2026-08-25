import { create } from 'zustand'
import { getDefaultHostServices, useHostServices } from '@/application/services/tokens'
import { someValue } from '@cpa/plugin-api'

export const useBadTimerAsyncStore = create((set) => ({
    count: 0,
    doTimer: () => {
        setTimeout(() => {
            set({ count: 1 })
        }, 1000)
    },
    doStorage: () => {
        const item = localStorage.getItem('key')
        return item
    },
    doServices: () => {
        const services = getDefaultHostServices()
        return services
    },
}))
