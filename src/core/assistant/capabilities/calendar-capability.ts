import type { Logger } from '../../logging/logger'
import type { MicrosoftWorkspace } from '../../microsoft/workspace'
import { describeCoverage } from '../../microsoft/accounts'
import { findFreeSlots } from '../../microsoft/calendar'
import type { ApprovalEngine } from '../../communication/approvals'
import {
  atTimeOnDay,
  durationMinutes,
  formatDay,
  formatDuration,
  formatRange,
  formatTime,
  parseDayReference,
  parseTimeOfDay,
  startOfDay,
  windowFor,
  withDay
} from '../../communication/time'
import {
  parseCreateInstruction,
  parseUpdateInstruction,
  type UpdateInstruction
} from '../../communication/calendar-language'
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
        return this.prepareCreate(question, route)
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

  /**
   * Find the event the user meant.
   *
   * Scores on the things that actually identify a meeting — distinctive words
   * from its title and its start time — rather than counting how many words of
   * the sentence happen to appear in the subject, which "meeting" and "for"
   * satisfy for almost anything.
   *
   * Returns the winner only when it is a clear winner. A tie is reported as
   * ambiguous, because quietly picking one of two plausible meetings and then
   * offering to cancel it is the worst thing this code could do.
   */
  private matchEvent(
    instruction: { referenceWords: string[]; referenceTitle: string | null; referenceStartMinutes: number | null },
    events: readonly CalendarEvent[]
  ): { event: CalendarEvent } | { ambiguous: CalendarEvent[] } | null {
    if (events.length === 0) return null

    const scored = events.map((event) => {
      const subject = event.subject.toLowerCase()
      let score = 0

      // An explicit title the user typed is the strongest signal there is.
      if (instruction.referenceTitle) {
        const title = instruction.referenceTitle.toLowerCase()
        if (subject === title) score += 10
        else if (subject.includes(title) || title.includes(subject)) score += 6
      }

      // Distinctive words from the title, command vocabulary already removed.
      for (const word of instruction.referenceWords) {
        if (subject.includes(word)) score += 2
      }

      // "my 7 PM meeting" identifies by clock time, which is often the only
      // thing the user gives.
      if (instruction.referenceStartMinutes !== null) {
        const startMinutes = new Date(event.start).getHours() * 60 + new Date(event.start).getMinutes()
        if (startMinutes === instruction.referenceStartMinutes) score += 5
        else score -= 2
      }

      return { event, score }
    })

    const best = Math.max(...scored.map((s) => s.score))
    if (best <= 0) return null

    const winners = scored.filter((s) => s.score === best).map((s) => s.event)
    if (winners.length > 1) return { ambiguous: winners }
    return { event: winners[0]! }
  }

  /** The events Jarvis should look through for a change instruction. */
  private async lookupEvents(
    instruction: UpdateInstruction,
    route: Route
  ): Promise<{
    result: Awaited<ReturnType<MicrosoftWorkspace['listEvents']>>
    match: { event: CalendarEvent } | { ambiguous: CalendarEvent[] } | null
  }> {
    const accountId = this.resolveAccountId(route)
    const result = await this.deps.workspace.listEvents({
      ...(accountId ? { accountId } : {}),
      from: instruction.searchDay,
      to: instruction.searchDay + 86_400_000
    })
    return { result, match: this.matchEvent(instruction, result.items) }
  }

  /** A reply asking which meeting was meant, with no action attached. */
  private ambiguous(
    candidates: CalendarEvent[],
    result: { checkedAccounts: string[]; failures: Array<{ reason: string }> },
    verb: string
  ): JarvisReply {
    return this.reply({
      text:
        `More than one meeting matches that, so I have not prepared anything to ${verb}. ` +
        `Tell me which one by name or start time: ` +
        candidates.map((e) => `"${e.subject}" at ${formatTime(e.start)}`).join(', ') +
        '.',
      events: candidates,
      result,
      kind: 'insufficient'
    })
  }

  /**
   * Work out the proposed start and end.
   *
   * Only what the user asked about changes. Move a meeting and it keeps its
   * length; change its length and it keeps its start. That is the whole point
   * of separating the reference from the request during parsing.
   */
  private proposeTimes(
    event: CalendarEvent,
    instruction: UpdateInstruction
  ): { start: number; end: number; changed: string[] } {
    const currentMinutes = durationMinutes(event.start, event.end)
    const changed: string[] = []

    // Date: only if the user named a destination day.
    let start = instruction.targetDay !== null ? withDay(instruction.targetDay, event.start) : event.start
    if (instruction.targetDay !== null && startOfDay(instruction.targetDay) !== startOfDay(event.start)) {
      changed.push('date')
    }

    // Start time: only if the user named a destination time.
    if (instruction.targetStartMinutes !== null) {
      start = atTimeOnDay(startOfDay(start), instruction.targetStartMinutes)
      changed.push('start time')
    }

    // Length: an absolute request wins over a relative one; otherwise keep it.
    let minutes = currentMinutes
    if (instruction.newDurationMinutes !== null) {
      minutes = instruction.newDurationMinutes
    } else if (instruction.durationDeltaMinutes !== null) {
      minutes = currentMinutes + instruction.durationDeltaMinutes
    }
    if (minutes !== currentMinutes) changed.push('duration')
    // A meeting cannot be zero-length or negative.
    minutes = Math.max(minutes, 5)

    return { start, end: start + minutes * 60_000, changed }
  }

  private async prepareUpdate(question: string, route: Route): Promise<JarvisReply> {
    const instruction = parseUpdateInstruction(question, this.now())
    const { result, match } = await this.lookupEvents(instruction, route)

    if (!match) {
      return this.reply({
        text: `I could not find that meeting on ${formatDay(instruction.searchDay)}. Nothing has been changed.`,
        events: result.items,
        result,
        kind: 'insufficient',
        suggestions: ['Name the meeting as it appears in your calendar.', 'Say which day it is on.']
      })
    }
    if ('ambiguous' in match) return this.ambiguous(match.ambiguous, result, 'change')

    const event = match.event
    const asked =
      instruction.targetStartMinutes !== null ||
      instruction.targetDay !== null ||
      instruction.newDurationMinutes !== null ||
      instruction.durationDeltaMinutes !== null

    if (!asked) {
      return this.reply({
        text:
          `I found "${event.subject}" (${formatRange(event.start, event.end)}) but could not work out what to change. ` +
          'Nothing has been changed — tell me a new time, a new day, or a new length.',
        events: [event],
        result,
        kind: 'insufficient',
        suggestions: [
          `Move "${event.subject}" to 3 PM.`,
          `Make "${event.subject}" 1 hour.`,
          `Move "${event.subject}" to Friday.`
        ]
      })
    }

    const proposed = this.proposeTimes(event, instruction)

    // No-op guard. Proposing a change that changes nothing would put an
    // Apply button in front of the user that writes the existing values back
    // to Microsoft 365 — a pointless mutation and a misleading card.
    if (proposed.start === event.start && proposed.end === event.end) {
      return this.reply({
        text:
          `"${event.subject}" is already ${formatDay(event.start)}, ${formatRange(event.start, event.end)}. ` +
          'That matches what you asked for, so there is nothing to change and I have not prepared an action.',
        events: [event],
        result,
        kind: 'insufficient',
        suggestions: ['Say the new time or length explicitly, for example "make it 1 hour".']
      })
    }

    const preview: ApprovalField[] = [
      { label: 'Account', value: event.accountLabel },
      { label: 'Meeting', value: event.subject },
      {
        label: 'When',
        previous: `${formatDay(event.start)}, ${formatRange(event.start, event.end)}`,
        value: `${formatDay(proposed.start)}, ${formatRange(proposed.start, proposed.end)}`
      },
      {
        label: 'Length',
        previous: formatDuration(durationMinutes(event.start, event.end)),
        value: formatDuration(durationMinutes(proposed.start, proposed.end))
      },
      { label: 'Changing', value: proposed.changed.join(', ') || 'time' }
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
      description: `Change "${event.subject}" to ${formatRange(proposed.start, proposed.end)}`,
      source: question,
      accountId: event.accountId,
      accountLabel: event.accountLabel,
      preview,
      ...(event.attendees.length > 0
        ? { warning: 'Everyone invited will receive an updated meeting notice.' }
        : {}),
      // Exactly the values shown above, so the card and the Graph write cannot
      // drift apart.
      payload: {
        accountId: event.accountId,
        eventId: event.id,
        changes: { start: proposed.start, end: proposed.end }
      }
    })

    return this.proposal(
      'I have prepared the change below. Your calendar has not been touched — review it and approve to apply it.',
      action,
      [event]
    )
  }

  private async prepareCancel(question: string, route: Route): Promise<JarvisReply> {
    const instruction = parseUpdateInstruction(question, this.now())
    const { result, match } = await this.lookupEvents(instruction, route)

    if (!match) {
      return this.reply({
        text: `I could not find that meeting on ${formatDay(instruction.searchDay)}. Nothing has been cancelled.`,
        events: result.items,
        result,
        kind: 'insufficient',
        suggestions: ['Name the meeting as it appears in your calendar.', 'Say which day it is on.']
      })
    }
    if ('ambiguous' in match) return this.ambiguous(match.ambiguous, result, 'cancel')

    const event = match.event
    const preview: ApprovalField[] = [
      { label: 'Account', value: event.accountLabel },
      { label: 'Meeting', value: event.subject },
      { label: 'When', value: `${formatDay(event.start)}, ${formatRange(event.start, event.end)}` },
      { label: 'Length', value: formatDuration(durationMinutes(event.start, event.end)) },
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

  /** How long a new meeting runs when the user does not say. */
  private static readonly DEFAULT_CREATE_MINUTES = 60

  private async prepareCreate(question: string, route: Route): Promise<JarvisReply> {
    const instruction = parseCreateInstruction(question, this.now())

    if (instruction.startMinutes === null) {
      return notice(
        'Tell me the day and time for the meeting and I will prepare it for your approval.'
      )
    }

    // Honour a named account, the same way changes and cancellations do.
    const accountId = this.resolveAccountId(route)
    const accounts = this.deps.workspace.accounts()
    const account = accountId ? accounts.find((a) => a.id === accountId) : accounts[0]
    if (!account) return notice('No Microsoft account is connected.')

    const start = atTimeOnDay(instruction.dayStart, instruction.startMinutes)
    const minutes = instruction.durationMinutes ?? CalendarCapability.DEFAULT_CREATE_MINUTES
    const end = start + minutes * 60_000

    // A placeholder the user can see and correct, never an invented title.
    const subject = instruction.title ?? 'New meeting'

    const preview: ApprovalField[] = [
      { label: 'Account', value: account.label },
      { label: 'Title', value: subject },
      { label: 'Date', value: formatDay(start) },
      { label: 'Time', value: formatRange(start, end) },
      {
        label: 'Length',
        value: instruction.durationMinutes
          ? formatDuration(minutes)
          : `${formatDuration(minutes)} (default — say "for 30 minutes" to change it)`
      },
      { label: 'Attendees', value: 'None — add them in Outlook after it is created' },
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
      ...(instruction.title
        ? {}
        : { warning: 'You did not give the meeting a title, so it will be created as "New meeting".' }),
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
