import type { Logger } from '../../logging/logger'
import type { MicrosoftWorkspace } from '../../microsoft/workspace'
import { describeCoverage } from '../../microsoft/accounts'
import { findFreeSlots } from '../../microsoft/calendar'
import type { ApprovalEngine } from '../../communication/approvals'
import {
  atTimeOnDay,
  formatDay,
  formatRange,
  formatTime,
  parseDayReference,
  parseTimeOfDay,
  windowFor
} from '../../communication/time'
import type { Route } from '../routing'
import type {
  ApprovalField,
  CalendarEvent,
  JarvisReply
} from '../../../shared/communication'

export interface CalendarCapabilityDeps {
  workspace: MicrosoftWorkspace
  approvals: ApprovalEngine
  logger: Logger
  now?: () => number
}

/** Payload stored with a calendar action. Never crosses IPC. */
export interface UpdateEventPayload {
  accountId: string
  eventId: string
  changes: { start?: number; end?: number; subject?: string; location?: string }
}
export interface CreateEventPayload {
  accountId: string
  subject: string
  start: number
  end: number
  attendees: string[]
  location?: string
}
export interface CancelEventPayload {
  accountId: string
  eventId: string
  comment?: string
}

/**
 * Answering questions about the calendar, and preparing changes to it.
 *
 * Reading is free and immediate. Changing is not: every create, reschedule and
 * cancellation produces a PROPOSED action showing exactly what would happen,
 * and stops there. This class has no ability to execute one — that belongs to
 * the approval engine, which only the user's explicit approval can reach.
 */
export class CalendarCapability {
  private readonly deps: CalendarCapabilityDeps
  private readonly now: () => number

  constructor(deps: CalendarCapabilityDeps) {
    this.deps = deps
    this.now = deps.now ?? ((): number => Date.now())
  }

  private resolveAccountId(route: Route): string | undefined {
    if (!route.accountHint) return undefined
    return this.deps.workspace.findAccountByName(route.accountHint)?.id
  }

  async handle(question: string, route: Route): Promise<JarvisReply> {
    const workspace = this.deps.workspace
    if (!workspace.isConfigured() || !workspace.hasAccounts()) {
      return notice(
        'No Microsoft accounts are connected yet. Connect one in Settings → Connected Accounts and I can read your calendar.'
      )
    }

    switch (route.calendarIntent) {
      case 'prepare_update':
        return this.prepareUpdate(question, route)
      case 'prepare_cancel':
        return this.prepareCancel(question, route)
      case 'prepare_create':
        return this.prepareCreate(question)
      case 'free':
        return this.handleFree(question, route)
      default:
        return this.handleView(question, route)
    }
  }

  // -- reading -----------------------------------------------------------

  private async handleView(question: string, route: Route): Promise<JarvisReply> {
    const intent = route.calendarIntent ?? 'today'
    const window = windowFor(intent === 'prepare_update' ? 'today' : (intent as never), this.now())
    const accountId = this.resolveAccountId(route)

    const result = await this.deps.workspace.listEvents({
      ...(accountId ? { accountId } : {}),
      from: window.from,
      to: window.to
    })

    // "Do I have anything at 2 PM?" deserves a direct answer, not a day list.
    const minutes = parseTimeOfDay(question)
    if (minutes !== null) {
      const at = atTimeOnDay(parseDayReference(question, this.now()), minutes)
      const overlapping = result.items.filter((e) => e.start <= at && e.end > at)
      const text =
        overlapping.length === 0
          ? `Nothing scheduled at ${formatTime(at)} on ${formatDay(at)}.`
          : overlapping
              .map((e) => `${e.subject} (${e.accountLabel}) runs ${formatRange(e.start, e.end)}.`)
              .join(' ')
      return this.reply({ text, events: overlapping, result, kind: 'results' })
    }

    const text =
      result.items.length === 0
        ? `Nothing in your calendar for ${window.label}.`
        : this.describeDay(result.items, window.label)

    return this.reply({ text, events: result.items, result, kind: 'results' })
  }

  private describeDay(events: readonly CalendarEvent[], label: string): string {
    const next = events.find((e) => e.end > this.now())
    const count = `${events.length} ${events.length === 1 ? 'meeting' : 'meetings'} ${label}`
    if (!next) return `${count}. All of them have finished.`
    return `${count}. Next: ${next.subject} at ${formatTime(next.start)} (${next.accountLabel}).`
  }

  private async handleFree(question: string, route: Route): Promise<JarvisReply> {
    const day = parseDayReference(question, this.now())
    const accountId = this.resolveAccountId(route)

    // A working day, narrowed to an afternoon or morning when asked.
    let from = day + 9 * 3_600_000
    let to = day + 17 * 3_600_000
    if (/\bafternoon\b/i.test(question)) from = day + 12 * 3_600_000
    if (/\bmorning\b/i.test(question)) to = day + 12 * 3_600_000
    if (/\bevening\b/i.test(question)) {
      from = day + 17 * 3_600_000
      to = day + 21 * 3_600_000
    }

    const result = await this.deps.workspace.listEvents({
      ...(accountId ? { accountId } : {}),
      from: day,
      to: day + 86_400_000
    })
    const slots = findFreeSlots(result.items, from, to, 30)

    const text =
      slots.length === 0
        ? `You have no free time between ${formatTime(from)} and ${formatTime(to)} on ${formatDay(day)}.`
        : `Free on ${formatDay(day)}: ${slots
            .map((s) => `${formatRange(s.start, s.end)} (${s.minutes} min)`)
            .join(', ')}.`

    return this.reply({ text, events: result.items, result, kind: 'results' })
  }

  // -- preparing changes: nothing is executed here -----------------------

  /** Best match for a meeting the user named in plain words. */
  private matchEvent(question: string, events: readonly CalendarEvent[]): CalendarEvent | null {
    const words = question
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)

    let best: { event: CalendarEvent; score: number } | null = null
    for (const event of events) {
      const subject = event.subject.toLowerCase()
      const score = words.filter((w) => subject.includes(w)).length
      if (score > 0 && (!best || score > best.score)) best = { event, score }
    }
    return best?.event ?? null
  }

  private async prepareUpdate(question: string, route: Route): Promise<JarvisReply> {
    const day = parseDayReference(question, this.now())
    const accountId = this.resolveAccountId(route)
    const result = await this.deps.workspace.listEvents({
      ...(accountId ? { accountId } : {}),
      from: day,
      to: day + 86_400_000
    })

    const event = this.matchEvent(question, result.items)
    if (!event) {
      return this.reply({
        text: `I could not find that meeting on ${formatDay(day)}. Nothing has been changed.`,
        events: result.items,
        result,
        kind: 'insufficient',
        suggestions: ['Name the meeting as it appears in your calendar.', 'Say which day it is on.']
      })
    }

    const minutes = parseTimeOfDay(question)
    if (minutes === null) {
      return this.reply({
        text: `I found "${event.subject}" but not a new time. Nothing has been changed — tell me the time to move it to.`,
        events: [event],
        result,
        kind: 'insufficient'
      })
    }

    // Keep the meeting's length; the user asked to move it, not resize it.
    const newStart = atTimeOnDay(day, minutes)
    const newEnd = newStart + (event.end - event.start)

    const preview: ApprovalField[] = [
      { label: 'Account', value: event.accountLabel },
      { label: 'Meeting', value: event.subject },
      {
        label: 'Time',
        previous: `${formatDay(event.start)}, ${formatRange(event.start, event.end)}`,
        value: `${formatDay(newStart)}, ${formatRange(newStart, newEnd)}`
      }
    ]
    if (event.attendees.length > 0) {
      preview.push({
        label: 'Attendees who will be notified',
        value: event.attendees.map((a) => a.name ?? a.address).join(', ')
      })
    }

    const action = this.deps.approvals.propose<UpdateEventPayload>({
      type: 'UPDATE_EVENT',
      riskLevel: event.attendees.length > 0 ? 'high' : 'medium',
      description: `Move "${event.subject}" to ${formatTime(newStart)}`,
      source: question,
      accountId: event.accountId,
      accountLabel: event.accountLabel,
      preview,
      ...(event.attendees.length > 0
        ? { warning: 'Everyone invited will receive an updated meeting notice.' }
        : {}),
      payload: { accountId: event.accountId, eventId: event.id, changes: { start: newStart, end: newEnd } }
    })

    return this.proposal(
      `I have prepared the change below. Your calendar has not been touched — review it and approve to apply it.`,
      action,
      [event]
    )
  }

  private async prepareCancel(question: string, route: Route): Promise<JarvisReply> {
    const day = parseDayReference(question, this.now())
    const accountId = this.resolveAccountId(route)
    const result = await this.deps.workspace.listEvents({
      ...(accountId ? { accountId } : {}),
      from: day,
      to: day + 86_400_000
    })

    const event = this.matchEvent(question, result.items)
    if (!event) {
      return this.reply({
        text: `I could not find that meeting on ${formatDay(day)}. Nothing has been cancelled.`,
        events: result.items,
        result,
        kind: 'insufficient'
      })
    }

    const preview: ApprovalField[] = [
      { label: 'Account', value: event.accountLabel },
      { label: 'Meeting', value: event.subject },
      { label: 'When', value: `${formatDay(event.start)}, ${formatRange(event.start, event.end)}` },
      {
        label: 'Attendees who will be told it is cancelled',
        value:
          event.attendees.length > 0
            ? event.attendees.map((a) => a.name ?? a.address).join(', ')
            : 'No other attendees'
      }
    ]

    const action = this.deps.approvals.propose<CancelEventPayload>({
      type: 'DELETE_EVENT',
      riskLevel: 'high',
      description: `Cancel "${event.subject}"`,
      source: question,
      accountId: event.accountId,
      accountLabel: event.accountLabel,
      preview,
      warning:
        event.attendees.length > 0
          ? 'This cancels the meeting for everyone invited and sends them a cancellation notice. It cannot be undone from Jarvis.'
          : 'This removes the meeting from your calendar. It cannot be undone from Jarvis.',
      payload: { accountId: event.accountId, eventId: event.id }
    })

    return this.proposal(
      'I have prepared this cancellation. Nothing has been cancelled yet.',
      action,
      [event]
    )
  }

  private async prepareCreate(question: string): Promise<JarvisReply> {
    const day = parseDayReference(question, this.now())
    const minutes = parseTimeOfDay(question)

    if (minutes === null) {
      return notice(
        'Tell me the day and time for the meeting and I will prepare it for your approval.'
      )
    }

    const accounts = this.deps.workspace.accounts()
    const account = accounts[0]
    if (!account) return notice('No Microsoft account is connected.')

    const start = atTimeOnDay(day, minutes)
    // A sensible default the user can see and correct before approving.
    const end = start + 60 * 60_000

    const subjectMatch = /\b(?:meeting|call|catch[- ]?up)\s+(?:with\s+)?([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)?)/.exec(question)
    const withWhom = subjectMatch?.[1]?.trim()
    const subject = withWhom ? `Meeting with ${withWhom}` : 'New meeting'

    const preview: ApprovalField[] = [
      { label: 'Account', value: account.label },
      { label: 'Title', value: subject },
      { label: 'When', value: `${formatDay(start)}, ${formatRange(start, end)}` },
      { label: 'Attendees', value: 'None yet — add them in Outlook after it is created' },
      { label: 'Location', value: 'Not set' }
    ]

    const action = this.deps.approvals.propose<CreateEventPayload>({
      type: 'CREATE_EVENT',
      riskLevel: 'medium',
      description: `Create "${subject}" on ${formatDay(start)}`,
      source: question,
      accountId: account.id,
      accountLabel: account.label,
      preview,
      payload: { accountId: account.id, subject, start, end, attendees: [] }
    })

    return this.proposal(
      'I have prepared this meeting. It has not been created yet — check the details and approve to add it.',
      action,
      []
    )
  }

  // -- reply assembly -----------------------------------------------------

  private proposal(text: string, action: JarvisReply['pendingAction'], events: CalendarEvent[]): JarvisReply {
    const reply: JarvisReply = {
      kind: 'notice',
      capability: 'calendar',
      text,
      results: [],
      sources: [],
      suggestions: [],
      events
    }
    if (action) reply.pendingAction = action
    return reply
  }

  private reply(input: {
    text: string
    events: CalendarEvent[]
    result: { checkedAccounts: string[]; failures: Array<{ reason: string }> }
    kind: JarvisReply['kind']
    suggestions?: string[]
  }): JarvisReply {
    const total = this.deps.workspace.accounts().length
    const coverage = describeCoverage(
      { items: [], checkedAccounts: input.result.checkedAccounts, failures: input.result.failures as never },
      total
    )
    const reply: JarvisReply = {
      kind: input.kind,
      capability: 'calendar',
      text: input.text,
      results: [],
      sources: [],
      suggestions: input.suggestions ?? [],
      events: input.events
    }
    if (coverage) reply.coverage = coverage
    return reply
  }
}

function notice(text: string): JarvisReply {
  return { kind: 'notice', capability: 'calendar', text, results: [], sources: [], suggestions: [] }
}
