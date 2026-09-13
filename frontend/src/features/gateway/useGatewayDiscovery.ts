import { useState, useCallback, useRef, useEffect } from 'react'
import type { DiscoveredGateway } from '@cpa/plugin-api'
import { getHostBridge } from '@/application/services/hostTransport'

export interface UseGatewayDiscoveryOptions {
    discoverFn?: (timeoutMs?: number) => Promise<DiscoveredGateway[]>
}

export function useGatewayDiscovery(options?: UseGatewayDiscoveryOptions) {
    const [isDiscovering, setIsDiscovering] = useState(false)
    const [gateways, setGateways] = useState<DiscoveredGateway[]>([])
    const [hasDiscovered, setHasDiscovered] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const ongoingPromiseRef = useRef<Promise<DiscoveredGateway[]> | null>(null)
    const isMountedRef = useRef(true)

    useEffect(() => {
        isMountedRef.current = true
        return () => {
            isMountedRef.current = false
        }
    }, [])

    const triggerDiscovery = useCallback(
        (timeoutMs = 3000): Promise<DiscoveredGateway[]> => {
            if (ongoingPromiseRef.current) {
                return ongoingPromiseRef.current
            }

            setIsDiscovering(true)
            setError(null)

            const run = async (): Promise<DiscoveredGateway[]> => {
                try {
                    const fn = options?.discoverFn || ((t) => getHostBridge().GatewayDiscover(t))
                    const list = await fn(timeoutMs)
                    const safeList = Array.isArray(list) ? list : []
                    if (isMountedRef.current) {
                        setGateways(safeList)
                        setHasDiscovered(true)
                    }
                    return safeList
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err)
                    if (isMountedRef.current) {
                        setError(msg)
                        setGateways([])
                        setHasDiscovered(true)
                    }
                    return []
                } finally {
                    if (isMountedRef.current) {
                        setIsDiscovering(false)
                    }
                }
            }

            const promise = run().finally(() => {
                if (ongoingPromiseRef.current === promise) {
                    ongoingPromiseRef.current = null
                }
            })

            ongoingPromiseRef.current = promise
            return promise
        },
        [options?.discoverFn],
    )

    return {
        isDiscovering,
        gateways,
        hasDiscovered,
        error,
        triggerDiscovery,
    }
}
