import type { FetchLike } from '../src/core/microsoft/graph-client'
import type { ConnectedAccount } from '../src/shared/communication'

/**
 * A scriptable stand-in for Microsoft Graph.
 *
 * Automated tests never reach the real Graph: no real mail is sent and no real
 * calendar is touched. Routes are matched on method + path substring, so a test
 * declares only what it cares about, and anything unexpected fails loudly
 * rather than silently returning empty.
 */
export interface MockRoute {
  method?: string
  /** Substring matched against the request URL. */
  match: string
  status?: number
  body?: unknown
  headers?: Record<string, string>
  /** Throw a transport-level failure, simulating an offline machine. */
  networkError?: boolean
  /**
   * Reply with no body at all, as Graph does for an accepted send (202) or a
   * successful mutation. Distinct from `body: {}`, which is the string "{}".
   */
  emptyBody?: boolean
}

export interface RecordedCall {
  method: string
  url: string
  body: unknown
  headers: Record<string, string>
}

export class GraphMock {
  readonly calls: RecordedCall[] = []
  private routes: MockRoute[] = []

  constructor(routes: MockRoute[] = []) {
    this.routes = routes
  }

  add(route: MockRoute): this {
    this.routes.push(route)
    return this
  }

  reset(routes: MockRoute[] = []): void {
    this.routes = routes
    this.calls.length = 0
  }

  /** Calls that would have changed something in Microsoft 365. */
  mutatingCalls(): RecordedCall[] {
    return this.calls.filter((c) => c.method !== 'GET')
  }

  /** Calls that would have sent mail. */
  sendCalls(): RecordedCall[] {
    return this.calls.filter((c) => /sendMail|\/reply/.test(c.url))
  }

  get fetch(): FetchLike {
    return async (url, init) => {
      const method = (init.method ?? 'GET').toUpperCase()
      this.calls.push({
        method,
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        headers: (init.headers ?? {}) as Record<string, string>
      })

      const route = this.routes.find(
        (r) => (!r.method || r.method === method) && url.includes(r.match)
      )
      if (!route) {
        throw new Error(`GraphMock: no route for ${method} ${url}`)
      }
      if (route.networkError) {
        throw new TypeError('fetch failed')
      }

      const status = route.status ?? 200
      const hasNoBody = status === 204 || route.emptyBody === true
      return new Response(hasNoBody ? null : JSON.stringify(route.body ?? {}), {
        status,
        headers: { 'content-type': 'application/json', ...(route.headers ?? {}) }
      })
    }
  }
}

export function fakeAccount(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    id: 'acc-gta',
    username: 'danial@gta.example',
    displayName: 'Danial Khalid',
    tenantId: 'tenant-1',
    label: 'GTA',
    connectedAt: new Date('2026-09-01').toISOString(),
    lastSyncAt: null,
    status: 'connected',
    ...overrides
  }
}

/** A Graph message payload, shaped like the real API. */
export function graphMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    subject: 'Quarterly compliance review',
    bodyPreview: 'Can you confirm the audit date before Friday?',
    from: { emailAddress: { name: 'Sarah Chen', address: 'sarah@client.example' } },
    toRecipients: [{ emailAddress: { name: 'Danial', address: 'danial@gta.example' } }],
    ccRecipients: [],
    receivedDateTime: '2026-09-17T09:30:00Z',
    isRead: false,
    importance: 'normal',
    hasAttachments: false,
    flag: { flagStatus: 'notFlagged' },
    webLink: 'https://outlook.office.com/mail/msg-1',
    ...overrides
  }
}

/** A Graph event payload, shaped like the real API. */
export function graphEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt-1',
    subject: 'Titan Strategy Call',
    bodyPreview: 'Quarterly strategy discussion',
    start: { dateTime: '2026-09-18T00:30:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-09-18T01:30:00.0000000', timeZone: 'UTC' },
    isAllDay: false,
    isCancelled: false,
    location: { displayName: 'Teams' },
    onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
    organizer: { emailAddress: { name: 'Danial', address: 'danial@gta.example' } },
    attendees: [
      {
        emailAddress: { name: 'Ali Rahman', address: 'ali@titan.example' },
        type: 'required',
        status: { response: 'accepted' }
      }
    ],
    webLink: 'https://outlook.office.com/calendar/evt-1',
    ...overrides
  }
}
