import type {
  CalendarEvent,
  ConnectedAccount,
  EventAttendee,
  MailAddress,
  MailMessage
} from '../../shared/communication'

/**
 * Microsoft Graph JSON, as far as Jarvis reads it.
 *
 * Declared loosely on purpose: Graph adds fields over time, and Jarvis should
 * keep working when it does. Every mapper below tolerates a missing field
 * rather than assuming one is present.
 */
export interface GraphRecipient {
  emailAddress?: { name?: string; address?: string }
}

export interface GraphMessage {
  id?: string
  conversationId?: string
  subject?: string
  bodyPreview?: string
  body?: { contentType?: string; content?: string }
  from?: GraphRecipient
  sender?: GraphRecipient
  toRecipients?: GraphRecipient[]
  ccRecipients?: GraphRecipient[]
  receivedDateTime?: string
  isRead?: boolean
  importance?: string
  hasAttachments?: boolean
  flag?: { flagStatus?: string }
  webLink?: string
}

export interface GraphEvent {
  id?: string
  subject?: string
  bodyPreview?: string
  start?: { dateTime?: string; timeZone?: string }
  end?: { dateTime?: string; timeZone?: string }
  isAllDay?: boolean
  isCancelled?: boolean
  location?: { displayName?: string }
  onlineMeeting?: { joinUrl?: string }
  onlineMeetingUrl?: string
  organizer?: GraphRecipient
  attendees?: Array<GraphRecipient & { type?: string; status?: { response?: string } }>
  webLink?: string
}

function toAddress(recipient: GraphRecipient | undefined): MailAddress | null {
  const address = recipient?.emailAddress?.address
  if (!address) return null
  const name = recipient?.emailAddress?.name
  return name ? { name, address } : { address }
}

function toAddresses(recipients: GraphRecipient[] | undefined): MailAddress[] {
  return (recipients ?? []).map(toAddress).filter((a): a is MailAddress => a !== null)
}

/**
 * Graph returns times without a zone designator when a timeZone is given
 * separately. Jarvis requests UTC, so an unsuffixed value is treated as UTC
 * rather than silently reinterpreted in local time.
 */
export function parseGraphDateTime(value: string | undefined, timeZone?: string): number | null {
  if (!value) return null
  const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(value)
  const normalised =
    hasZone || (timeZone && timeZone !== 'UTC') ? value : `${value.replace(/\.\d+$/, '')}Z`
  const parsed = Date.parse(normalised)
  return Number.isFinite(parsed) ? parsed : null
}

/** Strip HTML to readable text when Graph gives us an HTML body. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    // Block tags leave whitespace hugging the line breaks they produced.
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function mapMessage(raw: GraphMessage, account: ConnectedAccount): MailMessage {
  const importance = raw.importance?.toLowerCase()
  const message: MailMessage = {
    id: raw.id ?? '',
    accountId: account.id,
    accountLabel: account.label,
    conversationId: raw.conversationId ?? raw.id ?? '',
    subject: raw.subject?.trim() || '(no subject)',
    from: toAddress(raw.from ?? raw.sender),
    to: toAddresses(raw.toRecipients),
    cc: toAddresses(raw.ccRecipients),
    receivedAt: parseGraphDateTime(raw.receivedDateTime) ?? 0,
    isRead: raw.isRead !== false,
    importance: importance === 'high' || importance === 'low' ? importance : 'normal',
    isFlagged: raw.flag?.flagStatus === 'flagged',
    hasAttachments: raw.hasAttachments === true,
    preview: (raw.bodyPreview ?? '').replace(/\s+/g, ' ').trim()
  }

  if (raw.webLink) message.webLink = raw.webLink

  const bodyContent = raw.body?.content
  if (bodyContent) {
    message.body =
      raw.body?.contentType?.toLowerCase() === 'html' ? htmlToText(bodyContent) : bodyContent.trim()
  }

  return message
}

export function mapEvent(raw: GraphEvent, account: ConnectedAccount): CalendarEvent {
  const attendees: EventAttendee[] = (raw.attendees ?? [])
    .map((a) => {
      const address = a.emailAddress?.address
      if (!address) return null
      const attendee: EventAttendee = { address }
      if (a.emailAddress?.name) attendee.name = a.emailAddress.name
      if (a.status?.response) attendee.response = a.status.response
      if (a.type) attendee.required = a.type === 'required'
      return attendee
    })
    .filter((a): a is EventAttendee => a !== null)

  const event: CalendarEvent = {
    id: raw.id ?? '',
    accountId: account.id,
    accountLabel: account.label,
    subject: raw.subject?.trim() || '(no title)',
    start: parseGraphDateTime(raw.start?.dateTime, raw.start?.timeZone) ?? 0,
    end: parseGraphDateTime(raw.end?.dateTime, raw.end?.timeZone) ?? 0,
    isAllDay: raw.isAllDay === true,
    organizer: toAddress(raw.organizer),
    attendees,
    isCancelled: raw.isCancelled === true
  }

  const location = raw.location?.displayName?.trim()
  if (location) event.location = location
  const joinUrl = raw.onlineMeeting?.joinUrl ?? raw.onlineMeetingUrl
  if (joinUrl) event.onlineMeetingUrl = joinUrl
  const preview = raw.bodyPreview?.replace(/\s+/g, ' ').trim()
  if (preview) event.bodyPreview = preview
  if (raw.webLink) event.webLink = raw.webLink

  return event
}
