import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { routeQuestion, extractSenderName } from '../src/core/assistant/routing'

const ctx = { accountLabels: ['GTA', 'Titan', 'ICC'] }
const route = (q: string, extra = {}): ReturnType<typeof routeQuestion> =>
  routeQuestion(q, { ...ctx, ...extra })

describe('conversational routing — the examples from the brief', () => {
  test('"Find my latest GTA operational plan." -> local documents', () => {
    assert.equal(route('Find my latest GTA operational plan.').capability, 'documents')
  })

  test('"Summarise it." -> stays with documents when that is the context', () => {
    assert.equal(route('Summarise it.').capability, 'documents')
  })

  test('"Check my emails." -> mail', () => {
    const r = route('Check my emails.')
    assert.equal(r.capability, 'mail')
    assert.equal(r.mailIntent, 'list')
  })

  test('"What\'s on today?" -> calendar', () => {
    const r = route("What's on today?")
    assert.equal(r.capability, 'calendar')
    assert.equal(r.calendarIntent, 'today')
  })

  test('"Find the email about the GTA operational plan." -> mail, not documents', () => {
    const r = route('Find the email about the GTA operational plan.')
    assert.equal(r.capability, 'mail')
    assert.equal(r.mailIntent, 'search')
    assert.match(r.searchTerms ?? '', /operational plan/i)
  })

  test('"Find the GTA operational plan on my Mac." -> documents, not mail', () => {
    assert.equal(route('Find the GTA operational plan on my Mac.').capability, 'documents')
  })

  test('"Draft a reply to the latest email from Sarah." -> mail + draft', () => {
    const r = route('Draft a reply to the latest email from Sarah.')
    assert.equal(r.capability, 'mail')
    assert.equal(r.mailIntent, 'draft')
  })
})

describe('V0.1 questions must never be routed away from documents', () => {
  const v01 = [
    'Find my latest GTA operational plan.',
    'Find documents relating to LRD.',
    'What documents do I have relating to Titan Security?',
    'Find the latest invoice from this company.',
    'Summarise this document.',
    'Compare these two documents.',
    'What does this document say about compliance?',
    'Where is this file located?',
    'Summarise it and tell me what still needs attention.',
    'What are the outstanding priorities?'
  ]

  for (const question of v01) {
    test(`"${question}"`, () => {
      assert.equal(route(question).capability, 'documents', question)
    })
  }
})

describe('mail routing', () => {
  test('recognises the brief\'s mail examples', () => {
    assert.equal(route('What important emails need my attention?').mailIntent, 'attention')
    assert.equal(route('What emails need a reply?').mailIntent, 'attention')
    // "Summarise" is an analytical instruction, so it now reaches the
    // synthesis path rather than the unread list.
    assert.equal(route('Summarise my unread emails.').capability, 'mail')
    assert.equal(route('Summarise my unread emails.').mailIntent, 'analyse')
    assert.equal(route('Summarise my unread emails.').shape, 'analyse')
    assert.equal(route('Any emails from Sarah?').mailIntent, 'search')
    assert.equal(route('What happened with the Bluebird invoice?').capability, 'documents')
  })

  test('"Find the email about the Titan capability statement." searches mail', () => {
    const r = route('Find the email about the Titan capability statement.')
    assert.equal(r.capability, 'mail')
    assert.match(r.searchTerms ?? '', /capability statement/i)
  })

  test('picks up a named account', () => {
    const r = route('Check my GTA emails.')
    assert.equal(r.capability, 'mail')
    assert.equal(r.accountHint, 'GTA')
  })

  test('recognises an explicit all-accounts search', () => {
    const r = route('Search all my accounts for emails about LRD.')
    assert.equal(r.capability, 'mail')
    assert.equal(r.allAccounts, true)
    assert.match(r.searchTerms ?? '', /LRD/i)
  })

  test('an unconnected account name is not treated as an account', () => {
    assert.equal(route('Check my emails.', { accountLabels: [] }).accountHint, undefined)
  })

  test('extracts a sender name but not a day of the week', () => {
    assert.equal(extractSenderName('Any emails from Sarah?'), 'Sarah')
    assert.equal(extractSenderName('Any emails from Sarah Chen?'), 'Sarah Chen')
    assert.equal(extractSenderName('Emails from Monday'), undefined)
  })
})

describe('calendar routing', () => {
  test('recognises the brief\'s calendar examples', () => {
    assert.equal(route('What meetings do I have tomorrow?').calendarIntent, 'tomorrow')
    assert.equal(route("What's my week looking like?").calendarIntent, 'week')
    assert.equal(route('Do I have anything at 2 PM?').capability, 'calendar')
    assert.equal(route('When am I free tomorrow afternoon?').calendarIntent, 'free')
    assert.equal(route('Show my GTA meetings.').accountHint, 'GTA')
  })

  test('recognises prepared changes without performing them', () => {
    assert.equal(route('Move my Titan Strategy Call tomorrow to 3 PM.').calendarIntent, 'prepare_update')
    assert.equal(route('Book a meeting with Ali on Thursday.').calendarIntent, 'prepare_create')
    assert.equal(route("Cancel tomorrow's stand-up.").calendarIntent, 'prepare_cancel')
  })

  test('equivalent calendar create actions never fall through to lookup', () => {
    const creates = [
      'Schedule Resource Company Sale today at 7:30 pm for 1 hour',
      'add a meeting titled Resource Company Sale today at 7:30 pm for 1 hour',
      'add an event called Resource Company Sale tomorrow at 9am',
      'create a meeting called Resource Company Sale tomorrow at 9am',
      'create an event called Resource Company Sale tomorrow at 9am',
      'book a meeting with Ali on Thursday',
      'put Resource Company Sale on my calendar tomorrow at 9am'
    ]

    for (const question of creates) {
      const result = route(question)
      assert.equal(result.capability, 'calendar', question)
      assert.equal(result.calendarIntent, 'prepare_create', question)
    }
  })

  test('genuine calendar questions remain lookups', () => {
    assert.equal(route('What is on my calendar today?').calendarIntent, 'today')
    assert.equal(route('Do I have anything at 7:30 pm?').calendarIntent, 'answer')
    assert.equal(route('Show my meetings tomorrow.').calendarIntent, 'tomorrow')
  })
})

describe('daily brief routing', () => {
  test('recognises brief requests', () => {
    assert.equal(route('Brief me.').capability, 'brief')
    assert.equal(route('Give me my daily brief').capability, 'brief')
    assert.equal(route("What's my day?").capability, 'brief')
  })
})

describe('routing safety', () => {
  test('an ambiguous question falls back to documents rather than guessing', () => {
    assert.equal(route('What about the audit?').capability, 'documents')
    assert.equal(route('Titan').capability, 'documents')
    assert.equal(route('').capability, 'documents')
  })

  test('a short follow-up stays with the capability already in play', () => {
    assert.equal(route('Summarise it.', { hasMailContext: true }).capability, 'mail')
    assert.equal(route('Summarise it.', { hasMailContext: false }).capability, 'documents')
  })

  test('every route records why it was chosen', () => {
    for (const q of ['Check my emails.', "What's on today?", 'Find my plan.']) {
      assert.ok(route(q).reason.length > 5)
    }
  })
})
