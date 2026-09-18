import { GraphClient } from './graph-client'
import { mapEvent, type GraphEvent } from './mapping'
import type { CalendarEvent, ConnectedAccount, FreeSlot } from '../../shared/communication'

const EVENT_FIELDS =
  'id,subject,bodyPreview,start,end,isAllDay,isCancelled,location,onlineMeeting,onlineMeetingUrl,organizer,attendees,webLink'

/**
 * Reading and — only after approval — changing one account's calendar.
 *
 * The mutating methods here are reachable exclusively from the approval
 * engine's executors. Nothing in the conversational path holds a reference to
 * this class's write methods.
 */
export class CalendarService {
  private readonly graph: GraphClient
  private readonly account: ConnectedAccount

  constructor(graph: GraphClient, account: ConnectedAccount) {
    this.graph = graph
    this.account = account
  }

  /**
   * Events overlapping a window.
   *
   * Uses `calendarView`, which expands recurring series into their individual
   * occurrences — without it, a weekly stand-up would appear once at its
   * original date rather than on the day being asked about.
   */
  async eventsBetween(from: number, to: number, limit = 100): Promise<CalendarEvent[]> {
    const raw = await this.graph.listAll<GraphEvent>('/me/calendarView', {
      limit,
      query: {
        startDateTime: new Date(from).toISOString(),
        endDateTime: new Date(to).toISOString(),
        $select: EVENT_FIELDS,
        $orderby: 'start/dateTime asc',
        $top: Math.min(limit, 50)
      },
      // Ask Graph to return times in UTC so they can be parsed unambiguously.
      headers: { Prefer: 'outlook.timezone="UTC"' }
    })
    return raw
      .map((e) => mapEvent(e, this.account))
      .filter((e) => !e.isCancelled)
      .sort((a, b) => a.start - b.start)
  }

  async get(eventId: string): Promise<CalendarEvent> {
    const raw = await this.graph.request<GraphEvent>(
      `/me/events/${encodeURIComponent(eventId)}`,
      { query: { $select: EVENT_FIELDS }, headers: { Prefer: 'outlook.timezone="UTC"' } }
    )
    return mapEvent(raw, this.account)
  }

  // -- mutations: approval-gated ------------------------------------------

  async createEvent(payload: {
    subject: string
    start: number
    end: number
    attendees: string[]
    location?: string
    body?: string
    isOnlineMeeting?: boolean
  }): Promise<string> {
    const created = await this.graph.request<{ id?: string }>('/me/events', {
      method: 'POST',
      body: {
        subject: payload.subject,
        start: { dateTime: new Date(payload.start).toISOString(), timeZone: 'UTC' },
        end: { dateTime: new Date(payload.end).toISOString(), timeZone: 'UTC' },
        ...(payload.location ? { location: { displayName: payload.location } } : {}),
        ...(payload.body ? { body: { contentType: 'Text', content: payload.body } } : {}),
        ...(payload.isOnlineMeeting ? { isOnlineMeeting: true } : {}),
        attendees: payload.attendees.map((address) => ({
          emailAddress: { address },
          type: 'required'
        }))
      }
    })
    return created.id ?? ''
  }

  async updateEvent(
    eventId: string,
    changes: { subject?: string; start?: number; end?: number; location?: string }
  ): Promise<void> {
    const body: Record<string, unknown> = {}
    if (changes.subject !== undefined) body['subject'] = changes.subject
    if (changes.start !== undefined) {
      body['start'] = { dateTime: new Date(changes.start).toISOString(), timeZone: 'UTC' }
    }
    if (changes.end !== undefined) {
      body['end'] = { dateTime: new Date(changes.end).toISOString(), timeZone: 'UTC' }
    }
    if (changes.location !== undefined) body['location'] = { displayName: changes.location }

    await this.graph.request(`/me/events/${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      body
    })
  }

  /**
   * Cancel an event.
   *
   * `/cancel` notifies attendees, which is what a person means by cancelling a
   * meeting; a bare DELETE would remove it silently from the organiser's
   * calendar and leave everyone else holding a ghost.
   */
  async cancelEvent(eventId: string, comment?: string): Promise<void> {
    await this.graph.request(`/me/events/${encodeURIComponent(eventId)}/cancel`, {
      method: 'POST',
      body: { Comment: comment ?? '' }
    })
  }
}

/**
 * Gaps between meetings inside a window.
 *
 * Pure and account-agnostic: it takes events from however many calendars and
 * reports when the person is actually free, which is the only useful answer
 * when someone runs several businesses from one diary.
 */
export function findFreeSlots(
  events: readonly CalendarEvent[],
  windowStart: number,
  windowEnd: number,
  minimumMinutes = 30
): FreeSlot[] {
  const busy = events
    .filter((e) => !e.isAllDay && e.end > windowStart && e.start < windowEnd)
    .map((e) => ({ start: Math.max(e.start, windowStart), end: Math.min(e.end, windowEnd) }))
    .sort((a, b) => a.start - b.start)

  // Merge overlapping meetings so back-to-back blocks do not create fake gaps.
  const merged: Array<{ start: number; end: number }> = []
  for (const block of busy) {
    const last = merged[merged.length - 1]
    if (last && block.start <= last.end) {
      last.end = Math.max(last.end, block.end)
    } else {
      merged.push({ ...block })
    }
  }

  const slots: FreeSlot[] = []
  let cursor = windowStart
  for (const block of merged) {
    if (block.start > cursor) {
      const minutes = Math.round((block.start - cursor) / 60_000)
      if (minutes >= minimumMinutes) slots.push({ start: cursor, end: block.start, minutes })
    }
    cursor = Math.max(cursor, block.end)
  }
  if (windowEnd > cursor) {
    const minutes = Math.round((windowEnd - cursor) / 60_000)
    if (minutes >= minimumMinutes) slots.push({ start: cursor, end: windowEnd, minutes })
  }

  return slots
}
