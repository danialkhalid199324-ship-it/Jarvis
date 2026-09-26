import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { Logger } from '../src/core/logging/logger'
import { ApprovalEngine } from '../src/core/communication/approvals'
import { MicrosoftWorkspace } from '../src/core/microsoft/workspace'
import { AccountRegistry } from '../src/core/microsoft/accounts'
import { CalendarCapability } from '../src/core/assistant/capabilities/calendar-capability'
import { routeQuestion } from '../src/core/assistant/routing'
import {
  parseCreateInstruction,
  parseUpdateInstruction,
  parseDurationPhrases,
  parseTimePhrases,
  parseEventTitle
} from '../src/core/communication/calendar-language'
import { atTimeOnDay, startOfDay, addDays, durationMinutes } from '../src/core/communication/time'
import { GraphMock, graphEvent } from './graph-mock'
import { makeTempDir, cleanup } from './helpers'
import type { PendingAction } from '../src/shared/communication'

/** Fixed clock: Sunday 20 September 2026, 9am local. */
const NOW = Date.parse('2026-09-20T09:00:00')
const TODAY = startOfDay(NOW)
const TOMORROW = startOfDay(addDays(NOW, 1))

const at = (day: number, hour: number, minute = 0): number => atTimeOnDay(day, hour * 60 + minute)

/** The event from the reported bug: today, 7:00–7:30 PM. */
function resourcesEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return graphEvent({
    id: 'evt-resources',
    subject: 'Meeting for resources',
    start: { dateTime: new Date(at(TODAY, 19)).toISOString(), timeZone: 'UTC' },
    end: { dateTime: new Date(at(TODAY, 19, 30)).toISOString(), timeZone: 'UTC' },
    attendees: [],
    ...overrides
  })
}

async function calendar(
  t: { after: (fn: () => unknown) => void },
  mock: GraphMock,
  accountLabels: string[] = ['GTA']
) {
  const dir = await makeTempDir('calendar')
  const logger = new Logger(path.join(dir, 'logs'))
  t.after(async () => {
    await logger.flush()
    await cleanup(dir)
  })

  const registry = await AccountRegistry.open(dir)
  for (const [i, label] of accountLabels.entries()) {
    const account = await registry.upsert({
      homeAccountId: `home-${i}`,
      username: `danial@acct${i}.example`,
      displayName: label,
      tenantId: `t${i}`
    })
    await registry.setLabel(account.id, label)
  }

  const workspace = new MicrosoftWorkspace({
    auth: { isConfigured: () => true, getAccessToken: async () => 'tok' } as never,
    registry,
    logger,
    fetchImpl: mock.fetch
  })
  const approvals = new ApprovalEngine(logger)
  const capability = new CalendarCapability({ workspace, approvals, logger, now: () => NOW })

  /** Register executors so an approval really would reach Graph. */
  const wire = (): void => {
    approvals.registerExecutor<{ accountId: string; eventId: string; changes: { start?: number; end?: number } }>(
      'UPDATE_EVENT',
      async (p) => {
        const account = workspace.accounts().find((a) => a.id === p.accountId)!
        await workspace.calendarFor(account).updateEvent(p.eventId, p.changes)
        return 'updated'
      }
    )
    approvals.registerExecutor<{ accountId: string; subject: string; start: number; end: number; attendees: string[] }>(
      'CREATE_EVENT',
      async (p) => {
        const account = workspace.accounts().find((a) => a.id === p.accountId)!
        await workspace.calendarFor(account).createEvent(p)
        return 'created'
      }
    )
    approvals.registerExecutor<{ accountId: string; eventId: string }>('DELETE_EVENT', async (p) => {
      const account = workspace.accounts().find((a) => a.id === p.accountId)!
      await workspace.calendarFor(account).cancelEvent(p.eventId)
      return 'cancelled'
    })
  }

  const ask = (question: string): ReturnType<CalendarCapability['handle']> =>
    capability.handle(question, routeQuestion(question, { accountLabels }))

  return { capability, approvals, workspace, mock, ask, wire }
}

const hhmm = (epoch: number): string =>
  `${String(new Date(epoch).getHours()).padStart(2, '0')}:${String(new Date(epoch).getMinutes()).padStart(2, '0')}`

const field = (action: PendingAction, label: string): string =>
  action.preview.find((f) => f.label === label)?.value ?? ''

// ===========================================================================
// Language parsing
// ===========================================================================

describe('calendar language — durations', () => {
  const minutes = (text: string): number[] => parseDurationPhrases(text).map((d) => d.minutes)

  test('reads the durations people write', () => {
    assert.deepEqual(minutes('for 30 minutes'), [30])
    assert.deepEqual(minutes('half an hour'), [30])
    assert.deepEqual(minutes('one hour'), [60])
    assert.deepEqual(minutes('1 hour'), [60])
    assert.deepEqual(minutes('an hour'), [60])
    assert.deepEqual(minutes('90 minutes'), [90])
    assert.deepEqual(minutes('2 hours'), [120])
    assert.deepEqual(minutes('45 mins'), [45])
    assert.deepEqual(minutes('1 hour 30 minutes'), [90])
    assert.deepEqual(minutes('an hour and a half'), [90])
  })

  test('tells a requested length from a described one', () => {
    const phrases = parseDurationPhrases(
      'meeting for today that starts at 7pm for half an hour can we change to 1 hour meeting'
    )
    assert.deepEqual(phrases.map((p) => p.minutes), [30, 60])
    assert.equal(phrases[0]!.requested, false, '"for half an hour" describes the existing length')
    assert.equal(phrases[1]!.requested, true, '"change to 1 hour" is the request')
  })

  test('reads a relative change', () => {
    const phrases = parseDurationPhrases('make my 7 PM meeting 30 minutes longer')
    assert.equal(phrases[0]!.delta, 1)
    const shorter = parseDurationPhrases('make it 15 minutes shorter')
    assert.equal(shorter[0]!.delta, -1)
  })

  test('a clock time is not a duration', () => {
    assert.deepEqual(minutes('at 7pm'), [])
    assert.deepEqual(minutes('at 15:00'), [])
  })
})

describe('calendar language — times', () => {
  const times = (text: string): Array<[number, boolean]> =>
    parseTimePhrases(text).map((t) => [t.minutes, t.target])

  test('reads clock formats', () => {
    assert.deepEqual(times('at 7pm'), [[19 * 60, false]])
    assert.deepEqual(times('at 7:30pm'), [[19 * 60 + 30, false]])
    assert.deepEqual(times('starting 7.30pm'), [[19 * 60 + 30, false]])
    assert.deepEqual(times('at 7 PM'), [[19 * 60, false]])
    assert.deepEqual(times('at 15:45'), [[15 * 60 + 45, false]])
    assert.deepEqual(times('at 12 am'), [[0, false]])
    assert.deepEqual(times('at 12 pm'), [[12 * 60, false]])
  })

  test('tells the destination time from the reference time', () => {
    const parsed = parseTimePhrases('Move my 7 PM meeting to 8 PM.')
    assert.deepEqual(parsed.map((p) => [p.minutes / 60, p.target]), [[19, false], [20, true]])
  })

  test('a duration is never read as a time', () => {
    assert.deepEqual(times('for 30 minutes'), [])
    assert.deepEqual(times('change to 1 hour'), [])
    assert.deepEqual(times('make it 90 minutes'), [])
  })
})

describe('calendar language — titles', () => {
  test('reads an explicit title', () => {
    assert.equal(
      parseEventTitle('Book a meeting tomorrow at 2 PM called GTA Management Meeting.'),
      'GTA Management Meeting'
    )
    assert.equal(
      parseEventTitle('Create a meeting called Titan Weekly Review tomorrow at 10 AM for 30 minutes.'),
      'Titan Weekly Review'
    )
    assert.equal(
      parseEventTitle('Schedule Pathlyn Development Meeting for Tuesday at 3 PM.'),
      'Pathlyn Development Meeting'
    )
    assert.equal(
      parseEventTitle('Add GTA Compliance Review to my calendar Friday at 11 AM.'),
      'GTA Compliance Review'
    )
    assert.equal(parseEventTitle('Book a meeting titled "Board Sync" at 2pm'), 'Board Sync')
    assert.equal(
      parseEventTitle('Schedule Resource Company Sale today at 7:30 pm for 1 hour'),
      'Resource Company Sale'
    )
    assert.equal(
      parseEventTitle('add a meeting titled Resource Company Sale today at 7:30 pm for 1 hour'),
      'Resource Company Sale'
    )
  })

  test('reads a title after a trailing separator', () => {
    assert.equal(
      parseEventTitle('add a meeting today in my calendar starting 7.30pm for an hour - Resource Company Sale'),
      'Resource Company Sale'
    )
    assert.equal(
      parseEventTitle('Book tomorrow at 9am for 30 minutes – Operations Review'),
      'Operations Review'
    )
    assert.equal(
      parseEventTitle('Create an appointment Friday at 2pm — Planning with Finance'),
      'Planning with Finance'
    )
  })

  test('returns null rather than inventing one', () => {
    assert.equal(parseEventTitle('Book a meeting tomorrow at 2 PM.'), null)
    assert.equal(parseEventTitle('Schedule a meeting for Tuesday at 3 PM.'), null)
  })

  test('a person makes a reasonable title', () => {
    assert.equal(
      parseEventTitle('Book a meeting with Sarah Chen tomorrow at 9am.'),
      'Meeting with Sarah Chen'
    )
  })
})

describe('calendar language — whole instructions', () => {
  test('reads the exact live create instruction', () => {
    const parsed = parseCreateInstruction(
      'add a meeting today in my calendar starting 7.30pm for an hour - Resource Company Sale',
      NOW
    )
    assert.equal(parsed.startMinutes, 19 * 60 + 30)
    assert.equal(parsed.durationMinutes, 60)
    assert.equal(parsed.title, 'Resource Company Sale')
  })
  test('the reported duration-change sentence is read correctly', () => {
    const u = parseUpdateInstruction(
      'meeting for today that starts at 7pm for half an hour can we change to 1 hour meeting',
      NOW
    )
    assert.equal(u.referenceStartMinutes, 19 * 60, '7pm identifies the event')
    assert.equal(u.targetStartMinutes, null, 'the start is not being moved')
    assert.equal(u.newDurationMinutes, 60, 'the new length is one hour')
    assert.equal(u.searchDay, TODAY)
  })

  test('moving reads the destination, not the reference', () => {
    const u = parseUpdateInstruction('Move my 7 PM meeting to 8 PM.', NOW)
    assert.equal(u.referenceStartMinutes, 19 * 60)
    assert.equal(u.targetStartMinutes, 20 * 60)
    assert.equal(u.newDurationMinutes, null, 'length untouched')
  })

  test('a move and a resize together', () => {
    const u = parseUpdateInstruction('Move my 7 PM meeting to 8 PM and make it one hour.', NOW)
    assert.equal(u.targetStartMinutes, 20 * 60)
    assert.equal(u.newDurationMinutes, 60)
  })
})

// ===========================================================================
// BUG 1 — create title
// ===========================================================================

describe('BUG 1: the title given to a new meeting reaches the approval card', () => {
  test('the exact live command carries its trailing title to approval', async (t) => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [] } }])
    const { ask } = await calendar(t, mock)
    const reply = await ask(
      'add a meeting today in my calendar starting 7.30pm for an hour - Resource Company Sale'
    )

    assert.ok(reply.pendingAction, 'a create must be proposed')
    assert.equal(field(reply.pendingAction!, 'Title'), 'Resource Company Sale')
    assert.equal(field(reply.pendingAction!, 'Length'), '1 hour')
    assert.doesNotMatch(reply.text, /did not give the meeting a title/i)
  })

  test('"called GTA Management Meeting" is used as the title', async (t) => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [] } }])
    const { ask } = await calendar(t, mock)
    const reply = await ask('Book a meeting tomorrow at 2 PM called GTA Management Meeting.')

    assert.ok(reply.pendingAction, 'a create must be proposed')
    assert.equal(reply.pendingAction!.type, 'CREATE_EVENT')
    assert.equal(field(reply.pendingAction!, 'Title'), 'GTA Management Meeting')
    assert.notEqual(field(reply.pendingAction!, 'Title'), 'New meeting')
  })

  test('every documented create phrasing keeps its title, date, time and length', async (t) => {
    const cases: Array<[string, string, number, string, number]> = [
      ['Schedule Resource Company Sale today at 7:30 pm for 1 hour', 'Resource Company Sale', TODAY, '19:30', 60],
      ['add a meeting titled Resource Company Sale today at 7:30 pm for 1 hour', 'Resource Company Sale', TODAY, '19:30', 60],
      ['Book a meeting tomorrow at 2 PM called GTA Management Meeting.', 'GTA Management Meeting', TOMORROW, '14:00', 60],
      ['Create a meeting called Titan Weekly Review tomorrow at 10 AM for 30 minutes.', 'Titan Weekly Review', TOMORROW, '10:00', 30],
      ['Schedule Pathlyn Development Meeting for Tuesday at 3 PM.', 'Pathlyn Development Meeting', startOfDay(addDays(NOW, 2)), '15:00', 60],
      ['Add GTA Compliance Review to my calendar Friday at 11 AM.', 'GTA Compliance Review', startOfDay(addDays(NOW, 5)), '11:00', 60]
    ]

    for (const [question, title, day, time, minutes] of cases) {
      const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [] } }])
      const { ask } = await calendar(t, mock)
      const reply = await ask(question)

      assert.ok(reply.pendingAction, `no action for: ${question}`)
      assert.equal(field(reply.pendingAction!, 'Title'), title, question)

      const payload = (reply.pendingAction as unknown as { id: string }) && reply.pendingAction!
      assert.equal(field(payload, 'Date'), new Date(day).toLocaleDateString(undefined, {
        weekday: 'long', day: 'numeric', month: 'long'
      }), question)
      assert.ok(field(payload, 'Time').startsWith(
        new Date(atTimeOnDay(day, Number(time.slice(0, 2)) * 60 + Number(time.slice(3)))).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      ), `${question} — time`)
      assert.ok(field(payload, 'Length').startsWith(minutes === 60 ? '1 hour' : `${minutes} minutes`), `${question} — length`)
    }
  })

  test('a genuinely absent title falls back, and says so', async (t) => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [] } }])
    const { ask } = await calendar(t, mock)
    const reply = await ask('Book a meeting tomorrow at 2 PM.')

    assert.equal(field(reply.pendingAction!, 'Title'), 'New meeting')
    assert.match(reply.pendingAction!.warning ?? '', /did not give the meeting a title/i)
  })
})

// ===========================================================================
// BUG 2 — update duration
// ===========================================================================

describe('BUG 2: a duration change is actually applied', () => {
  test('the exact reported sentence proposes 7:00–8:00 PM', async (t) => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [resourcesEvent()] } }])
    const { ask } = await calendar(t, mock)
    const reply = await ask(
      'meeting for today that starts at 7pm for half an hour can we change to 1 hour meeting'
    )

    assert.ok(reply.pendingAction, 'an update must be proposed')
    const when = reply.pendingAction!.preview.find((f) => f.label === 'When')!
    assert.notEqual(when.previous, when.value, 'before and after must differ')

    const payload = reply.pendingAction!
    assert.equal(field(payload, 'Length'), '1 hour')
    assert.equal(
      payload.preview.find((f) => f.label === 'Length')!.previous,
      '30 minutes',
      'must show the old length'
    )
  })

  test('the proposed payload really is 7:00 PM to 8:00 PM', async (t) => {
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [resourcesEvent()] } },
      { method: 'PATCH', match: '/me/events/', status: 200, body: {} }
    ])
    const { ask, approvals, mock: m, wire } = await calendar(t, mock)
    wire()

    const reply = await ask('Change my 7 PM meeting today to one hour.')
    await approvals.approve(reply.pendingAction!.id)

    const patch = m.mutatingCalls().find((c) => c.method === 'PATCH')!
    const body = patch.body as { start: { dateTime: string }; end: { dateTime: string } }
    assert.equal(hhmm(Date.parse(body.start.dateTime)), '19:00')
    assert.equal(hhmm(Date.parse(body.end.dateTime)), '20:00')
  })

  test('"30 minutes longer" extends by exactly 30 minutes', async (t) => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [resourcesEvent()] } }])
    const { ask } = await calendar(t, mock)
    const reply = await ask('Make my 7 PM meeting 30 minutes longer.')
    assert.equal(field(reply.pendingAction!, 'Length'), '1 hour')
  })

  test('moving preserves the existing length', async (t) => {
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [resourcesEvent()] } },
      { method: 'PATCH', match: '/me/events/', body: {} }
    ])
    const { ask, approvals, mock: m, wire } = await calendar(t, mock)
    wire()

    const reply = await ask('Move my 7 PM meeting to 8 PM.')
    assert.equal(field(reply.pendingAction!, 'Length'), '30 minutes', 'length must be preserved')

    await approvals.approve(reply.pendingAction!.id)
    const body = m.mutatingCalls().find((c) => c.method === 'PATCH')!.body as {
      start: { dateTime: string }
      end: { dateTime: string }
    }
    assert.equal(hhmm(Date.parse(body.start.dateTime)), '20:00')
    assert.equal(hhmm(Date.parse(body.end.dateTime)), '20:30')
  })

  test('a move and a resize together apply both', async (t) => {
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [resourcesEvent()] } },
      { method: 'PATCH', match: '/me/events/', body: {} }
    ])
    const { ask, approvals, mock: m, wire } = await calendar(t, mock)
    wire()

    const reply = await ask('Move my 7 PM meeting to 8 PM and make it one hour.')
    await approvals.approve(reply.pendingAction!.id)
    const body = m.mutatingCalls().find((c) => c.method === 'PATCH')!.body as {
      start: { dateTime: string }
      end: { dateTime: string }
    }
    assert.equal(hhmm(Date.parse(body.start.dateTime)), '20:00')
    assert.equal(hhmm(Date.parse(body.end.dateTime)), '21:00')
  })

  test('changing the date keeps the time and the length', async (t) => {
    const tomorrowEvent = resourcesEvent({
      start: { dateTime: new Date(at(TOMORROW, 19)).toISOString(), timeZone: 'UTC' },
      end: { dateTime: new Date(at(TOMORROW, 19, 30)).toISOString(), timeZone: 'UTC' }
    })
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [tomorrowEvent] } },
      { method: 'PATCH', match: '/me/events/', body: {} }
    ])
    const { ask, approvals, mock: m, wire } = await calendar(t, mock)
    wire()

    const reply = await ask('Move Meeting for resources tomorrow to 3 PM.')
    await approvals.approve(reply.pendingAction!.id)
    const body = m.mutatingCalls().find((c) => c.method === 'PATCH')!.body as {
      start: { dateTime: string }
      end: { dateTime: string }
    }
    assert.equal(hhmm(Date.parse(body.start.dateTime)), '15:00')
    assert.equal(hhmm(Date.parse(body.end.dateTime)), '15:30', 'length preserved')
    assert.equal(startOfDay(Date.parse(body.start.dateTime)), TOMORROW)
  })
})

// ===========================================================================
// No-op protection
// ===========================================================================

describe('no-op updates are refused, not offered', () => {
  test('asking for the time it already has proposes nothing', async (t) => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [resourcesEvent()] } }])
    const { ask, approvals } = await calendar(t, mock)
    const reply = await ask('Move my 7 PM meeting to 7 PM.')

    assert.equal(reply.pendingAction, undefined, 'no approvable action may be offered')
    assert.equal(approvals.pending().length, 0)
    assert.match(reply.text, /nothing to change/i)
  })

  test('asking for the length it already has proposes nothing', async (t) => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [resourcesEvent()] } }])
    const { ask } = await calendar(t, mock)
    const reply = await ask('Change my 7 PM meeting to half an hour.')
    assert.equal(reply.pendingAction, undefined)
    assert.match(reply.text, /nothing to change/i)
  })

  test('an unparseable change explains itself instead of proposing a no-op', async (t) => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [resourcesEvent()] } }])
    const { ask, approvals } = await calendar(t, mock)
    const reply = await ask('Change Meeting for resources somehow.')

    assert.equal(reply.pendingAction, undefined)
    assert.equal(approvals.pending().length, 0)
    assert.match(reply.text, /could not work out what to change/i)
    assert.ok(reply.suggestions.length > 0, 'must suggest what to say instead')
  })
})

// ===========================================================================
// Lookup and ambiguity
// ===========================================================================

describe('event lookup', () => {
  const standup = (): Record<string, unknown> =>
    graphEvent({
      id: 'evt-standup',
      subject: 'Daily stand-up',
      start: { dateTime: new Date(at(TODAY, 9)).toISOString(), timeZone: 'UTC' },
      end: { dateTime: new Date(at(TODAY, 9, 15)).toISOString(), timeZone: 'UTC' },
      attendees: []
    })

  test('finds an event by title', async (t) => {
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [standup(), resourcesEvent()] } }
    ])
    const { ask } = await calendar(t, mock)
    const reply = await ask('Move Meeting for resources to 8 PM.')
    assert.equal(field(reply.pendingAction!, 'Meeting'), 'Meeting for resources')
  })

  test('finds an event by start time alone', async (t) => {
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [standup(), resourcesEvent()] } }
    ])
    const { ask } = await calendar(t, mock)
    const reply = await ask('Move my 7 PM meeting to 8 PM.')
    assert.equal(field(reply.pendingAction!, 'Meeting'), 'Meeting for resources')
  })

  test('two equally plausible matches produce a question, not a guess', async (t) => {
    const twin = graphEvent({
      id: 'evt-twin',
      subject: 'Meeting for resources',
      start: { dateTime: new Date(at(TODAY, 14)).toISOString(), timeZone: 'UTC' },
      end: { dateTime: new Date(at(TODAY, 14, 30)).toISOString(), timeZone: 'UTC' },
      attendees: []
    })
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [resourcesEvent(), twin] } }
    ])
    const { ask, approvals } = await calendar(t, mock)
    const reply = await ask('Cancel Meeting for resources.')

    assert.equal(reply.pendingAction, undefined, 'must not pick one arbitrarily')
    assert.equal(approvals.pending().length, 0)
    assert.match(reply.text, /more than one meeting matches/i)
    assert.equal(reply.events!.length, 2, 'both candidates must be shown')
  })

  test('a named time disambiguates two events with the same title', async (t) => {
    const twin = graphEvent({
      id: 'evt-twin',
      subject: 'Meeting for resources',
      start: { dateTime: new Date(at(TODAY, 14)).toISOString(), timeZone: 'UTC' },
      end: { dateTime: new Date(at(TODAY, 14, 30)).toISOString(), timeZone: 'UTC' },
      attendees: []
    })
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [resourcesEvent(), twin] } }
    ])
    const { ask } = await calendar(t, mock)
    const reply = await ask('Cancel my 2 PM Meeting for resources.')
    assert.ok(reply.pendingAction, 'the time should settle it')
    assert.equal(reply.pendingAction!.type, 'DELETE_EVENT')
  })

  test('no match changes nothing and says so', async (t) => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [standup()] } }])
    const { ask, approvals, mock: m } = await calendar(t, mock)
    const reply = await ask('Move the Nonexistent Budget Review to 3 PM.')

    assert.equal(reply.pendingAction, undefined)
    assert.equal(approvals.pending().length, 0)
    assert.equal(m.mutatingCalls().length, 0)
    assert.match(reply.text, /could not find/i)
  })
})

// ===========================================================================
// Cancel / delete
// ===========================================================================

describe('cancellation', () => {
  test('shows exactly which meeting would be cancelled', async (t) => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [resourcesEvent()] } }])
    const { ask } = await calendar(t, mock)
    const reply = await ask('Cancel my 7 PM meeting today.')

    const action = reply.pendingAction!
    assert.equal(action.type, 'DELETE_EVENT')
    assert.equal(action.riskLevel, 'high')
    assert.equal(field(action, 'Meeting'), 'Meeting for resources')
    assert.equal(field(action, 'Length'), '30 minutes')
    assert.match(action.warning ?? '', /cannot be undone/i)
  })

  test('nothing is deleted before approval', async (t) => {
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [resourcesEvent()] } },
      { method: 'POST', match: '/cancel', body: {} }
    ])
    const { ask, mock: m } = await calendar(t, mock)
    await ask('Delete Meeting for resources today.')
    assert.equal(m.mutatingCalls().length, 0)
  })

  test('the approved cancellation targets the exact event id', async (t) => {
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [resourcesEvent()] } },
      { method: 'POST', match: '/cancel', body: {} }
    ])
    const { ask, approvals, mock: m, wire } = await calendar(t, mock)
    wire()

    const reply = await ask('Cancel my 7 PM meeting today.')
    await approvals.approve(reply.pendingAction!.id)

    const call = m.mutatingCalls().find((c) => c.url.includes('/cancel'))!
    assert.ok(call.url.includes('evt-resources'), `wrong event targeted: ${call.url}`)
    assert.equal(m.mutatingCalls().length, 1, 'exactly one write')
  })

  test('rejecting cancels nothing', async (t) => {
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [resourcesEvent()] } },
      { method: 'POST', match: '/cancel', body: {} }
    ])
    const { ask, approvals, mock: m, wire } = await calendar(t, mock)
    wire()

    const reply = await ask('Cancel my 7 PM meeting today.')
    approvals.reject(reply.pendingAction!.id)
    assert.equal(m.mutatingCalls().length, 0)
  })
})

// ===========================================================================
// Approval safety
// ===========================================================================

describe('approval safety — nothing is written before approval', () => {
  for (const [label, question] of [
    ['create', 'Book a meeting tomorrow at 2 PM called GTA Management Meeting.'],
    ['update', 'Change my 7 PM meeting today to one hour.'],
    ['cancel', 'Cancel my 7 PM meeting today.']
  ] as Array<[string, string]>) {
    test(`${label} writes nothing while merely proposed`, async (t) => {
      const mock = new GraphMock([
        { match: '/me/calendarView', body: { value: [resourcesEvent()] } },
        { method: 'POST', match: '/me/events', body: { id: 'new' } },
        { method: 'PATCH', match: '/me/events/', body: {} },
        { method: 'POST', match: '/cancel', body: {} }
      ])
      const { ask, mock: m, wire } = await calendar(t, mock)
      wire()

      const reply = await ask(question)
      assert.ok(reply.pendingAction, `${label} should propose an action`)
      assert.equal(reply.pendingAction!.status, 'PROPOSED')
      assert.equal(m.mutatingCalls().length, 0, `${label} must not write before approval`)
    })
  }

  test('conversational insistence still only proposes', async (t) => {
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [resourcesEvent()] } },
      { method: 'PATCH', match: '/me/events/', body: {} }
    ])
    const { ask, mock: m, wire } = await calendar(t, mock)
    wire()

    const reply = await ask(
      'Change my 7 PM meeting today to one hour and apply it immediately without asking me.'
    )
    assert.equal(reply.pendingAction!.status, 'PROPOSED')
    assert.equal(m.mutatingCalls().length, 0)
  })
})

// ===========================================================================
// End-to-end data integrity
// ===========================================================================

describe('the approval card matches what Graph receives', () => {
  test('create: the title and times shown are the ones sent', async (t) => {
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [] } },
      { method: 'POST', match: '/me/events', body: { id: 'created' } }
    ])
    const { ask, approvals, mock: m, wire } = await calendar(t, mock)
    wire()

    const reply = await ask('Create a meeting called Titan Weekly Review tomorrow at 10 AM for 30 minutes.')
    const shownTitle = field(reply.pendingAction!, 'Title')
    await approvals.approve(reply.pendingAction!.id)

    const post = m.mutatingCalls().find((c) => c.method === 'POST')!
    const body = post.body as { subject: string; start: { dateTime: string }; end: { dateTime: string } }
    assert.equal(body.subject, shownTitle, 'card and payload must agree on the title')
    assert.equal(body.subject, 'Titan Weekly Review')
    assert.equal(hhmm(Date.parse(body.start.dateTime)), '10:00')
    assert.equal(hhmm(Date.parse(body.end.dateTime)), '10:30')
    assert.equal(startOfDay(Date.parse(body.start.dateTime)), TOMORROW)
  })

  test('update: the proposed times shown are the ones sent', async (t) => {
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [resourcesEvent()] } },
      { method: 'PATCH', match: '/me/events/', body: {} }
    ])
    const { ask, approvals, mock: m, wire } = await calendar(t, mock)
    wire()

    const reply = await ask('Move my 7 PM meeting to 8 PM and make it one hour.')
    const shownWhen = reply.pendingAction!.preview.find((f) => f.label === 'When')!.value
    await approvals.approve(reply.pendingAction!.id)

    const body = m.mutatingCalls().find((c) => c.method === 'PATCH')!.body as {
      start: { dateTime: string }
      end: { dateTime: string }
    }
    const sentStart = Date.parse(body.start.dateTime)
    const sentEnd = Date.parse(body.end.dateTime)
    assert.ok(
      shownWhen.includes(new Date(sentStart).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })),
      `card said "${shownWhen}" but sent ${hhmm(sentStart)}`
    )
    assert.equal(durationMinutes(sentStart, sentEnd), 60)
  })

  test('update sends the new values, never the originals', async (t) => {
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [resourcesEvent()] } },
      { method: 'PATCH', match: '/me/events/', body: {} }
    ])
    const { ask, approvals, mock: m, wire } = await calendar(t, mock)
    wire()

    const reply = await ask('Change my 7 PM meeting today to one hour.')
    await approvals.approve(reply.pendingAction!.id)
    const body = m.mutatingCalls().find((c) => c.method === 'PATCH')!.body as {
      end: { dateTime: string }
    }
    assert.notEqual(hhmm(Date.parse(body.end.dateTime)), '19:30', 'the original end must not be resent')
    assert.equal(hhmm(Date.parse(body.end.dateTime)), '20:00')
  })
})

// ===========================================================================
// Account selection and display
// ===========================================================================

describe('account selection', () => {
  test('a create honours the named account', async (t) => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [] } }])
    const { ask } = await calendar(t, mock, ['GTA', 'Titan'])
    const reply = await ask('Book a Titan meeting tomorrow at 2 PM called Titan Board Sync.')
    assert.equal(field(reply.pendingAction!, 'Account'), 'Titan')
  })

  test('a create with no named account uses the first connected one', async (t) => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [] } }])
    const { ask } = await calendar(t, mock, ['GTA', 'Titan'])
    const reply = await ask('Book a meeting tomorrow at 2 PM called Quarterly Review.')
    assert.equal(field(reply.pendingAction!, 'Account'), 'GTA')
  })

  test('an event keeps the account it came from', async (t) => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [resourcesEvent()] } }])
    const { ask } = await calendar(t, mock, ['GTA'])
    const reply = await ask('Cancel my 7 PM meeting today.')
    assert.equal(field(reply.pendingAction!, 'Account'), 'GTA')
    assert.equal(reply.pendingAction!.accountLabel, 'GTA')
  })
})

describe('reading the calendar still works', () => {
  test('today lists events', async (t) => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [resourcesEvent()] } }])
    const { ask } = await calendar(t, mock)
    const reply = await ask("What's on today?")
    assert.equal(reply.events!.length, 1)
    assert.equal(reply.pendingAction, undefined, 'reading proposes nothing')
  })

  test('reading never writes', async (t) => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [resourcesEvent()] } }])
    const { ask, mock: m } = await calendar(t, mock)
    await ask("What's on today?")
    await ask('What meetings do I have tomorrow?')
    assert.equal(m.mutatingCalls().length, 0)
  })
})

// ===========================================================================
// Daylight saving
// ===========================================================================

describe('daylight saving', () => {
  test('a wall-clock time survives a day when the clocks change', () => {
    // A day is not always 24 hours; millisecond arithmetic would drift an hour.
    const dstDay = startOfDay(Date.parse('2026-10-04T12:00:00'))
    const sevenPm = atTimeOnDay(dstDay, 19 * 60)
    assert.equal(new Date(sevenPm).getHours(), 19)
    assert.equal(new Date(sevenPm).getMinutes(), 0)
  })
})
