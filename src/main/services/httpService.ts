import type { HttpRequest, HttpResponse } from '../../shared/types.js'
import { getUserAgent } from '../utils/version.js'

export class HttpService {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const { urlString, method, headers = {}, body, timeoutMs } = req

    let url: URL
    try {
      url = new URL(urlString)
    } catch {
      throw new Error(`parse URL: invalid URL "${urlString}"`)
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('URL must use http or https and include a host')
    }

    const controller = new AbortController()
    let timeoutId: NodeJS.Timeout | undefined
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        const error = new Error(`HTTP request timed out after ${timeoutMs}ms`)
        error.name = 'TimeoutError'
        controller.abort(error)
      }, timeoutMs)
    }

    const mergedHeaders: Record<string, string> = {
      'User-Agent': getUserAgent(),
      ...headers,
    }

    try {
      const response = await fetch(urlString, {
        method: method || 'GET',
        headers: mergedHeaders,
        body: ['GET', 'HEAD'].includes((method || 'GET').toUpperCase()) ? undefined : body,
        signal: controller.signal,
      })

      const responseBody = await response.text()

      const responseHeaders: Record<string, string[]> = {}
      response.headers.forEach((value, name) => {
        if (!responseHeaders[name]) {
          responseHeaders[name] = []
        }
        responseHeaders[name].push(value)
      })

      return {
        status: response.status,
        headers: responseHeaders,
        body: responseBody,
      }
    } catch (error) {
      // Reading the body can throw AbortError even when fetch was aborted with
      // a TimeoutError reason. Preserve the deadline failure across capability
      // serialization so callers do not mistake it for user cancellation.
      if (controller.signal.aborted) throw controller.signal.reason
      throw error
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
  }
}
