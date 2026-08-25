import type { HttpTransport } from './types'
import { getHostBridge } from '@/application/services/hostTransport'

export const electronHttpTransport: HttpTransport = {
  async request(input) {
    try {
      const bridge = getHostBridge()
      if (typeof bridge?.HttpRequest === 'function') {
        const response = await bridge.HttpRequest({
          urlString: input.url,
          method: input.method,
          headers: input.headers,
          body: input.body,
          timeoutMs: input.timeoutMs,
        })
        if (response && typeof response.status === 'number') {
          return {
            status: response.status,
            headers: response.headers,
            body: response.body,
          }
        }
      }
    } catch {
      // Fall back to direct fetch if host bridge request fails or is unavailable
    }

    // Direct fetch fallback
    const res = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body || undefined,
    })
    const text = await res.text()
    const headers: Record<string, string[]> = {}
    res.headers.forEach((value, key) => {
      headers[key] = [value]
    })
    return {
      status: res.status,
      headers,
      body: text,
    }
  },
}
