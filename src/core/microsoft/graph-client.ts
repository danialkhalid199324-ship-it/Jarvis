import type { GraphErrorKind } from '../../shared/communication'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const DEFAULT_TIMEOUT_MS = 20_000

/**
 * A Graph failure, classified so callers can tell the user something true.
 *
 * The distinction matters: "your session expired" and "Microsoft is slow right
 * now" call for different actions, and neither should ever be flattened into a
 * silent empty result.
 */
export class GraphError extends Error {
  readonly kind: GraphErrorKind
  readonly status: number | null
  /** Seconds to wait, when Microsoft told us. */
  readonly retryAfterSeconds: number | null

  constructor(
    kind: GraphErrorKind,
    message: string,
    status: number | null = null,
    retryAfterSeconds: number | null = null
  ) {
    super(message)
    this.name = 'GraphError'
    this.kind = kind
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }

  /** True when retrying the same request might work. */
  get retryable(): boolean {
    return this.kind === 'throttled' || this.kind === 'server' || this.kind === 'timeout'
  }
}

/** Map an HTTP response into a classified error with a human explanation. */
export function classifyResponse(status: number, retryAfter: string | null, body: string): GraphError {
  const retrySeconds = retryAfter ? Number.parseInt(retryAfter, 10) : null
  const detail = extractGraphMessage(body)

  switch (status) {
    case 401:
      return new GraphError(
        'auth',
        'This Microsoft account needs to be reconnected. Its session has expired.',
        status
      )
    case 403:
      return new GraphError(
        'consent',
        'Microsoft refused the request. Permission for this may have been withdrawn, or your organisation restricts it.',
        status
      )
    case 404:
      return new GraphError('not_found', detail ?? 'Microsoft could not find that item.', status)
    case 429:
      return new GraphError(
        'throttled',
        'Microsoft is rate limiting requests for this account. Try again shortly.',
        status,
        Number.isFinite(retrySeconds) ? retrySeconds : null
      )
    default:
      if (status >= 500) {
        return new GraphError('server', 'Microsoft 365 is having trouble responding right now.', status)
      }
      return new GraphError(
        'unknown',
        detail ?? `Microsoft returned an unexpected response (${status}).`,
        status
      )
  }
}

function extractGraphMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } }
    const message = parsed.error?.message
    return typeof message === 'string' && message.trim() ? message.trim() : null
  } catch {
    return null
  }
}

export interface GraphRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** Query string parameters; undefined values are dropped. */
  query?: Record<string, string | number | undefined>
  body?: unknown
  /** Extra headers, e.g. ConsistencyLevel for search. */
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
}

/** Injected so tests can drive the client without touching the network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/**
 * A minimal Microsoft Graph client.
 *
 * Written against `fetch` rather than the Graph SDK, for the same reason Jarvis
 * has no native dependencies: this is a handful of REST calls, and one fewer
 * dependency is one fewer thing that can break an install. It also makes the
 * whole Graph surface trivial to mock in tests.
 *
 * The access token is supplied per call by a function, so a token is fetched
 * (and silently refreshed) only when a request is actually made, and is never
 * held on this object.
 */
export class GraphClient {
  private readonly getToken: () => Promise<string>
  private readonly fetchImpl: FetchLike

  constructor(getToken: () => Promise<string>, fetchImpl?: FetchLike) {
    this.getToken = getToken
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init))
  }

  async request<T>(path: string, options: GraphRequestOptions = {}): Promise<T> {
    // Built by hand rather than with URLSearchParams, which encodes spaces as
    // "+". OData filters are more reliably accepted with percent-encoded
    // spaces, and `$filter=isRead eq false` is exactly the kind of value that
    // trips servers up otherwise.
    const base = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`
    const params = Object.entries(options.query ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    const url = new URL(base + (params.length > 0 ? `${base.includes('?') ? '&' : '?'}${params.join('&')}` : ''))

    const token = await this.getToken()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    // Honour an outer cancellation as well as our own timeout.
    const onOuterAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onOuterAbort)

    let response: Response
    try {
      response = await this.fetchImpl(url.toString(), {
        method: options.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...options.headers
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GraphError('timeout', 'Microsoft 365 did not respond in time.')
      }
      // fetch only rejects on a transport failure.
      throw new GraphError(
        'offline',
        'Jarvis could not reach Microsoft 365. Check your internet connection.'
      )
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onOuterAbort)
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw classifyResponse(response.status, response.headers.get('retry-after'), body)
    }

   if (!response.ok) {
  const body = await response.text().catch(() => '')
  throw classifyResponse(response.status, response.headers.get('retry-after'), body)
}

if (response.status === 204) return undefined as T

const responseText = await response.text()
if (!responseText.trim()) return undefined as T

return JSON.parse(responseText) as T
  }

  /**
   * Follow `@odata.nextLink` until `limit` items are collected.
   *
   * Bounded on purpose: Jarvis is an executive assistant, not a mail client,
   * and pulling an entire mailbox would be both slow and contrary to the
   * privacy posture.
   */
  async listAll<T>(
    path: string,
    options: GraphRequestOptions & { limit: number }
  ): Promise<T[]> {
    const collected: T[] = []
    let next: string | null = path
    let query: GraphRequestOptions['query'] | undefined = options.query
    let pages = 0

    while (next && collected.length < options.limit && pages < 10) {
      const page: { value?: T[]; '@odata.nextLink'?: string } = await this.request(next, {
        ...options,
        query
      })
      collected.push(...(page.value ?? []))
      next = page['@odata.nextLink'] ?? null
      // nextLink already carries the query string.
      query = undefined
      pages++
    }

    return collected.slice(0, options.limit)
  }
}
