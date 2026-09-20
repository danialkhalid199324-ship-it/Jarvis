import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { DocumentStore } from '../src/core/storage/document-store'
import { SearchIndex } from '../src/core/index/search-index'
import { Indexer } from '../src/core/index/indexer'
import { Logger } from '../src/core/logging/logger'
import { ProviderRegistry } from '../src/core/ai/registry'
import { Assistant } from '../src/core/assistant/assistant'
import { Session } from '../src/core/assistant/session'
import { JarvisRouter } from '../src/core/assistant/router'
import { MailCapability } from '../src/core/assistant/capabilities/mail-capability'
import { CalendarCapability } from '../src/core/assistant/capabilities/calendar-capability'
import { ApprovalEngine } from '../src/core/communication/approvals'
import { DailyBriefService } from '../src/core/communication/daily-brief'
import { MicrosoftWorkspace } from '../src/core/microsoft/workspace'
import { AccountRegistry } from '../src/core/microsoft/accounts'
import {
  MAX_REQUESTED_COUNT,
  detectShape,
  parseRequestedCount,
  routeQuestion
} from '../src/core/assistant/routing'
import {
  DEFAULT_ANALYSIS_COUNT,
  MAX_ANALYSIS_COUNT,
  analysisLimit,
  selectForAnalysis
} from '../src/core/assistant/capabilities/mail-analysis'
import { assessAttention, scoreMessages } from '../src/core/communication/mail-intelligence'
import { GraphMock, graphMessage, graphEvent } from './graph-mock'
import { makeTempDir, cleanup, FakeProvider } from './helpers'
import type { MailMessage } from '../src/shared/communication'

/**
 * The Ask Jarvis audit, as tests.
 *
 * Two prompts drove this work, and both are here verbatim rather than
 * paraphrased, because a paraphrase is not the thing that failed:
 *
 *   1. "Give me my daily briefing. Tell me what emails need my attention and
 *      what meetings I have today."
 *   2. "Summarise the 5 most important emails that need my attention. For each
 *      one tell me who it is from, what they want, and what action I need to
 *      take."
 *
 * The first was being answered by local document search. The second was being
 * answered with a list of cards, topped by a shop asking for a product review.
 */

const NOW = Date.parse('2026-09-18T09:00:00Z')
const CONTEXT: { accountLabels: string[] } = { accountLabels: ['GTA', 'Titan'] }

const BRIEFING_PROMPT =
  'Give me my daily briefing. Tell me what emails need my attention and what meetings I have today.'
const ANALYSIS_PROMPT =
  'Summarise the 5 most important emails that need my attention. For each one tell me who it is from, what they want, and what action I need to take.'

// ---------------------------------------------------------------------------
// Routing: what kind of answer, before which source
// ---------------------------------------------------------------------------

describe('request shape is decided before topic vocabulary', () => {
  test('the briefing prompt routes to the brief, not to documents', () => {
    const route = routeQuestion(BRIEFING_PROMPT, CONTEXT)
    assert.equal(route.capability, 'brief')
    assert.equal(route.shape, 'brief')
  })

  test('every way of asking for a brief lands on the brief', () => {
    for (const question of [
      'Give me my daily briefing.',
      'Daily brief please.',
      'Brief me.',
      'Morning briefing.',
      'My executive briefing for today.',
      'What needs my attention today?',
      "What's my day look like?",
      'Run me through my day.'
    ]) {
      assert.equal(routeQuestion(question, CONTEXT).capability, 'brief', question)
    }
  })

  test('a brief never reaches local document search', () => {
    for (const question of ['Give me my daily briefing.', 'Brief me.', 'Morning briefing.']) {
      assert.notEqual(routeQuestion(question, CONTEXT).capability, 'documents', question)
    }
  })

  test('naming a source keeps an attention question on that source', () => {
    const route = routeQuestion('What needs my attention in my inbox today?', CONTEXT)
    assert.equal(route.capability, 'mail')
    assert.equal(route.mailIntent, 'attention')
    assert.equal(route.shape, 'retrieve')
  })

  test('a question spanning mail and calendar is a brief even without the word', () => {
    const route = routeQuestion(
      'What emails need my attention and what meetings do I have today?',
      CONTEXT
    )
    assert.equal(route.capability, 'brief')
  })

  test('an instruction naming both is work, not a brief', () => {
    const route = routeQuestion(
      'Draft an email to Sarah and move my 3pm meeting to tomorrow.',
      CONTEXT
    )
    assert.notEqual(route.capability, 'brief')
  })
})

describe('analytical verbs outrank topic words', () => {
  test('the analysis prompt is an analysis of mail, not the attention list', () => {
    const route = routeQuestion(ANALYSIS_PROMPT, CONTEXT)
    assert.equal(route.capability, 'mail')
    assert.equal(route.shape, 'analyse')
    assert.equal(route.mailIntent, 'analyse')
    assert.equal(route.count, 5)
  })

  test('the analysis prompt does not invent a search term from its instructions', () => {
    // The old term extractor turned the whole sentence into a search string,
    // which matched nothing in Graph and returned an empty answer.
    assert.equal(routeQuestion(ANALYSIS_PROMPT, CONTEXT).searchTerms, undefined)
  })

  test('"important" alone is still retrieval', () => {
    const route = routeQuestion('Show me the important emails.', CONTEXT)
    assert.equal(route.shape, 'retrieve')
    assert.equal(route.mailIntent, 'attention')
  })

  test('analytical instructions about attention-worthy mail become analysis', () => {
    for (const question of [
      'Summarise the emails that need my attention.',
      'Prioritise my urgent emails.',
      'Triage my inbox.',
      'Walk me through the emails that need a reply.',
      'Give me a rundown of my important emails.'
    ]) {
      const route = routeQuestion(question, CONTEXT)
      assert.equal(route.shape, 'analyse', question)
      assert.equal(route.mailIntent, 'analyse', question)
    }
  })

  test('drafting still outranks analysis', () => {
    const route = routeQuestion('Summarise that email and draft a reply.', CONTEXT)
    assert.equal(route.mailIntent, 'draft')
  })

  test('detectShape is independent of the source', () => {
    assert.equal(detectShape('Show me my emails.'), 'retrieve')
    assert.equal(detectShape('Summarise my emails.'), 'analyse')
    assert.equal(detectShape('Give me my daily briefing.'), 'brief')
  })
})

describe('requested counts are honoured', () => {
  test('digits and words are both understood', () => {
    assert.equal(parseRequestedCount('Summarise the top 5 emails.'), 5)
    assert.equal(parseRequestedCount('The 5 most important emails.'), 5)
    assert.equal(parseRequestedCount('Give me the top three.'), 3)
    assert.equal(parseRequestedCount('Just a couple please.'), 2)
    assert.equal(parseRequestedCount('Show me 3 emails.'), 3)
    assert.equal(parseRequestedCount('First 4 messages.'), 4)
  })

  test('no number means no count, so callers pick their own default', () => {
    assert.equal(parseRequestedCount('Summarise my emails.'), null)
  })

  test('one word cannot ask for the whole mailbox', () => {
    assert.equal(parseRequestedCount('Summarise the top 500 emails.'), MAX_REQUESTED_COUNT)
  })

  test('the analysis limit defaults small and clamps hard', () => {
    assert.equal(analysisLimit(undefined), DEFAULT_ANALYSIS_COUNT)
    assert.equal(analysisLimit(0), DEFAULT_ANALYSIS_COUNT)
    assert.equal(analysisLimit(3), 3)
    assert.equal(analysisLimit(MAX_REQUESTED_COUNT), MAX_ANALYSIS_COUNT)
  })
})

// ---------------------------------------------------------------------------
// Ranking: what actually deserves an executive's attention
// ---------------------------------------------------------------------------

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'm',
    accountId: 'a',
    accountLabel: 'GTA',
    conversationId: 'c',
    subject: '',
    from: { name: 'Sender', address: 'sender@example.com' },
    to: [{ address: 'danial@gta.example' }],
    cc: [],
    receivedAt: NOW - 3_600_000,
    isRead: false,
    importance: 'normal',
    isFlagged: false,
    hasAttachments: false,
    preview: '',
    ...overrides
  }
}

const OWN = { ownAddresses: ['danial@gta.example'], now: NOW }

describe('marketing and automated engagement are suppressed', () => {
  const noise: Array<[string, Partial<MailMessage>]> = [
    [
      'a product review request',
      {
        subject: 'How did we do? Review your recent purchase',
        from: { name: 'Store', address: 'noreply@store.example' },
        preview: 'Tell us what you think of your recent order. Leave a review and go in the draw.'
      }
    ],
    [
      'a social notification',
      {
        subject: 'You have 3 new notifications',
        from: { name: 'Notifications', address: 'notifications@social.example' },
        preview: 'Someone viewed your profile. Don’t miss what is happening in your network.'
      }
    ],
    [
      'a newsletter',
      {
        subject: 'The weekly industry newsletter',
        from: { name: 'News', address: 'news@industry.example' },
        preview: 'This week’s round-up of sector headlines. Manage your preferences or unsubscribe.'
      }
    ],
    [
      'a promotion',
      {
        subject: '40% off everything — limited time',
        from: { name: 'Marketing', address: 'marketing@shop.example' },
        preview: 'Shop now and save. Sale ends Sunday. Free shipping on all orders.'
      }
    ],
    [
      'a survey',
      {
        subject: 'Take our quick survey',
        from: { name: 'Feedback', address: 'no-reply@vendor.example' },
        preview: 'Spare a few minutes to share your experience. Your feedback helps us improve.'
      }
    ]
  ]

  for (const [label, overrides] of noise) {
    test(`${label} is not raised`, () => {
      const assessment = assessAttention(message(overrides), OWN)
      assert.equal(assessment.needsAttention, false, `${label} scored ${assessment.score}`)
    })
  }

  test('a real matter always outranks the noise', () => {
    const scored = scoreMessages(
      [
        message({
          id: 'noise',
          subject: 'How did we do? Review your recent purchase',
          from: { name: 'Store', address: 'noreply@store.example' },
          preview: 'Leave a review of your recent order.'
        }),
        message({
          id: 'real',
          subject: 'NDIS audit evidence due Friday',
          from: { name: 'Auditor', address: 'auditor@quality.example' },
          preview: 'Please provide the corrective action evidence before the deadline on Friday.'
        })
      ],
      OWN
    )
    assert.equal(scored[0]!.id, 'real')
    assert.equal(scored[0]!.attention.needsAttention, true)
    assert.equal(scored[1]!.attention.needsAttention, false)
  })
})

describe('real business signals are raised', () => {
  const real: Array<[string, Partial<MailMessage>]> = [
    [
      'an overdue invoice from a billing system',
      {
        subject: 'Invoice INV-2291 is overdue',
        from: { name: 'Billing', address: 'no-reply@billing.example' },
        preview: 'The amount due of $4,180 is now past due. Please arrange payment.'
      }
    ],
    [
      'a compliance deadline',
      {
        subject: 'Corrective action evidence required',
        from: { name: 'Quality', address: 'quality@auditor.example' },
        preview: 'We need your compliance evidence before the closing date on 30 September.'
      }
    ],
    [
      'a client asking for something',
      {
        subject: 'Support plan for next quarter',
        from: { name: 'Jane Cooper', address: 'jane@client.example' },
        preview: 'Could you please send the updated plan so we can review it?'
      }
    ],
    [
      'a decision waiting on the user',
      {
        subject: 'Sign-off needed on the service agreement',
        from: { name: 'Amir Hassan', address: 'amir@partner.example' },
        preview: 'Approval required before we can proceed. Awaiting your decision.'
      }
    ]
  ]

  for (const [label, overrides] of real) {
    test(`${label} is raised`, () => {
      const assessment = assessAttention(message(overrides), OWN)
      assert.equal(assessment.needsAttention, true, `${label} scored ${assessment.score}`)
    })
  }

  test('an automated sender is not suppressed when the matter is significant', () => {
    const overdue = assessAttention(
      message({
        subject: 'Invoice INV-2291 is overdue',
        from: { name: 'Billing', address: 'no-reply@billing.example' },
        preview: 'Payment past due.'
      }),
      OWN
    )
    assert.equal(overdue.needsAttention, true)
  })

  test('no business, sender or domain is hardcoded', async () => {
    const source = await (await import('node:fs/promises')).readFile(
      'src/core/communication/mail-intelligence.ts',
      'utf8'
    )
    for (const forbidden of ['bunnings', 'linkedin', '@gmail', 'ndis', 'gta', 'titan']) {
      assert.equal(
        new RegExp(forbidden, 'i').test(source),
        false,
        `scoring must not mention "${forbidden}"`
      )
    }
  })
})

describe('the analysis shortlist is chosen deterministically', () => {
  const inbox = (): MailMessage[] => [
    message({
      id: 'noise',
      subject: 'How did we do? Rate your recent order',
      from: { name: 'Store', address: 'noreply@store.example' },
      preview: 'Leave a review and tell us what you think.'
    }),
    message({
      id: 'overdue',
      subject: 'Invoice INV-2291 overdue',
      preview: 'The amount due is past due. Please arrange payment.'
    }),
    message({
      id: 'audit',
      subject: 'Audit evidence deadline',
      preview: 'Compliance evidence required before the closing date.'
    }),
    message({ id: 'fyi', subject: 'Notes from Tuesday', preview: 'Sharing the notes.', isRead: true })
  ]

  test('only attention-worthy mail is analysed when that is what was asked', () => {
    const selection = selectForAnalysis(scoreMessages(inbox(), OWN), { attentionOnly: true })
    assert.equal(selection.candidates.some((m) => m.id === 'noise'), false)
    assert.ok(selection.candidates.length >= 2)
    assert.equal(selection.attentionOnly, true)
  })

  test('the shortlist never exceeds the requested count', () => {
    const selection = selectForAnalysis(scoreMessages(inbox(), OWN), {
      attentionOnly: true,
      requested: 1
    })
    assert.equal(selection.candidates.length, 1)
    assert.equal(selection.limit, 1)
  })

  test('the count is a ceiling, not a quota', () => {
    // Asking for five when only two matter must return two, not two plus
    // three things padded in to make up the number.
    const selection = selectForAnalysis(scoreMessages(inbox(), OWN), {
      attentionOnly: true,
      requested: 5
    })
    assert.ok(selection.candidates.length < 5)
    assert.ok(selection.candidates.every((m) => m.attention.needsAttention))
  })

  test('the shortlist is ordered by how pressing each message is', () => {
    const selection = selectForAnalysis(scoreMessages(inbox(), OWN), { attentionOnly: true })
    const scores = selection.candidates.map((m) => m.attention.score)
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a))
  })
})

// ---------------------------------------------------------------------------
// End to end, through the real router with Graph mocked
// ---------------------------------------------------------------------------

async function harness(
  t: { after: (fn: () => unknown) => void },
  mock: GraphMock,
  options: { provider?: FakeProvider | null } = {}
) {
  const dataDir = await makeTempDir('ask-jarvis')
  const logger = new Logger(path.join(dataDir, 'logs'))
  t.after(async () => {
    await logger.flush()
    await cleanup(dataDir)
  })

  const store = await DocumentStore.open(dataDir)
  const indexer = new Indexer(store, new SearchIndex(), logger)
  const registry = await AccountRegistry.open(dataDir)
  const account = await registry.upsert({
    homeAccountId: 'home-0',
    username: 'danial@gta.example',
    displayName: 'Danial Khalid',
    tenantId: 't0'
  })
  await registry.setLabel(account.id, 'GTA')

  const workspace = new MicrosoftWorkspace({
    auth: { isConfigured: () => true, getAccessToken: async () => 'tok' } as never,
    registry,
    logger,
    fetchImpl: mock.fetch
  })

  const fake = options.provider === undefined ? new FakeProvider(() => 'Synthesis.') : options.provider
  const providers = fake
    ? new ProviderRegistry([fake], 'fake', 'fake-model')
    : new ProviderRegistry([], 'none', 'none')

  const session = new Session()
  const maxContextChars = (): number => 60_000
  const documents = new Assistant({
    store,
    index: indexer.searchIndex,
    providers,
    logger,
    session,
    maxContextChars
  })
  const mail = new MailCapability({ workspace, providers, logger, maxContextChars })
  const calendar = new CalendarCapability({
    workspace,
    approvals: new ApprovalEngine(logger),
    logger
  })
  const brief = new DailyBriefService({ workspace, store, providers, logger, maxContextChars })
  const router = new JarvisRouter({ documents, mail, calendar, brief, workspace, session, logger })

  return { router, provider: fake, mock }
}

/** An inbox with two real matters and three pieces of noise. */
function mixedInbox(): Array<Record<string, unknown>> {
  return [
    graphMessage({
      id: 'noise-1',
      subject: 'How did we do? Review your recent purchase',
      bodyPreview: 'Leave a review of your recent order and tell us what you think.',
      body: { contentType: 'text', content: 'Leave a review of your recent order.' },
      from: { emailAddress: { name: 'Store', address: 'noreply@store.example' } },
      receivedDateTime: '2026-09-18T08:50:00Z'
    }),
    graphMessage({
      id: 'noise-2',
      subject: '40% off everything — limited time',
      bodyPreview: 'Shop now and save. Sale ends Sunday. Unsubscribe any time.',
      body: { contentType: 'text', content: 'Shop now and save. Sale ends Sunday.' },
      from: { emailAddress: { name: 'Marketing', address: 'marketing@shop.example' } },
      receivedDateTime: '2026-09-18T08:45:00Z'
    }),
    graphMessage({
      id: 'noise-3',
      subject: 'You have 4 new notifications',
      bodyPreview: 'Someone viewed your profile. Manage your email preferences.',
      body: { contentType: 'text', content: 'Someone viewed your profile.' },
      from: { emailAddress: { name: 'Notifications', address: 'notifications@social.example' } },
      receivedDateTime: '2026-09-18T08:40:00Z'
    }),
    graphMessage({
      id: 'invoice',
      subject: 'Invoice INV-2291 is overdue',
      bodyPreview: 'The amount due of $4,180 is now past due. Please arrange payment.',
      body: {
        contentType: 'text',
        content: 'The amount due of $4,180 is now past due. Please arrange payment.'
      },
      from: { emailAddress: { name: 'Accounts', address: 'accounts@supplier.example' } },
      receivedDateTime: '2026-09-17T16:00:00Z'
    }),
    graphMessage({
      id: 'audit',
      subject: 'Corrective action evidence required',
      bodyPreview: 'Please provide your compliance evidence before the closing date on 30 September.',
      body: {
        contentType: 'text',
        content: 'Please provide your compliance evidence before the closing date on 30 September.'
      },
      from: { emailAddress: { name: 'Quality Team', address: 'quality@auditor.example' } },
      receivedDateTime: '2026-09-17T11:00:00Z'
    })
  ]
}

describe('the analysis prompt, end to end', () => {
  test('it produces a written analysis of a bounded shortlist', async (t) => {
    const mock = new GraphMock([
      { match: '/me/mailFolders/inbox/messages', body: { value: mixedInbox() } }
    ])
    const { router, provider } = await harness(t, mock, {
      provider: new FakeProvider(() => '**Invoice INV-2291** [1]\nFrom: Accounts\n')
    })

    const reply = await router.ask(ANALYSIS_PROMPT)

    assert.equal(reply.capability, 'mail')
    assert.equal(reply.shape, 'analyse')
    assert.equal(reply.kind, 'answer')
    assert.equal(provider!.calls.length, 1, 'analysis calls the provider exactly once')
    assert.ok(reply.disclosure, 'the user is told what was sent')
    assert.ok(reply.mailSources && reply.mailSources.length > 0)
  })

  test('the marketing is gone and the real matters are what got analysed', async (t) => {
    const mock = new GraphMock([
      { match: '/me/mailFolders/inbox/messages', body: { value: mixedInbox() } }
    ])
    const { router, provider } = await harness(t, mock)

    const reply = await router.ask(ANALYSIS_PROMPT)
    const ids = (reply.messages ?? []).map((m) => m.id)

    assert.ok(ids.includes('invoice'))
    assert.ok(ids.includes('audit'))
    for (const noise of ['noise-1', 'noise-2', 'noise-3']) {
      assert.equal(ids.includes(noise), false, `${noise} must not be analysed`)
    }

    // And none of it was sent to the provider either.
    const sent = String(provider!.calls[0]!.request.messages[0]!.content)
    assert.equal(/Review your recent purchase/.test(sent), false)
    assert.equal(/40% off/.test(sent), false)
  })

  test('only the shortlist is sent, never the mailbox', async (t) => {
    const many = Array.from({ length: 30 }, (_, i) =>
      graphMessage({
        id: `m-${i}`,
        conversationId: `c-${i}`,
        subject: `Invoice INV-${1000 + i} is overdue`,
        bodyPreview: 'The amount due is now past due. Please arrange payment.',
        body: { contentType: 'text', content: 'The amount due is now past due.' },
        receivedDateTime: new Date(NOW - i * 3_600_000).toISOString()
      })
    )
    const mock = new GraphMock([{ match: '/me/mailFolders/inbox/messages', body: { value: many } }])
    const { router, provider } = await harness(t, mock)

    const reply = await router.ask(ANALYSIS_PROMPT)

    assert.equal(reply.messages!.length, 5, 'the requested five, not thirty')
    assert.equal(provider!.calls.length, 1)
    const sent = String(provider!.calls[0]!.request.messages[0]!.content)
    assert.equal((sent.match(/^\[\d+\]$/gm) ?? []).length, 5, 'five numbered excerpts')
    assert.equal(reply.disclosure!.excerptCount, 5)
  })

  test('a smaller count is honoured too', async (t) => {
    const mock = new GraphMock([
      { match: '/me/mailFolders/inbox/messages', body: { value: mixedInbox() } }
    ])
    const { router } = await harness(t, mock)
    const reply = await router.ask('Summarise the top 1 email that needs my attention.')
    assert.equal(reply.messages!.length, 1)
  })

  test('nothing pressing is said plainly, and costs nothing', async (t) => {
    const quiet = [
      graphMessage({
        id: 'noise-1',
        subject: 'How did we do? Review your recent purchase',
        bodyPreview: 'Leave a review of your recent order.',
        from: { emailAddress: { name: 'Store', address: 'noreply@store.example' } }
      })
    ]
    const mock = new GraphMock([
      { match: '/me/mailFolders/inbox/messages', body: { value: quiet } }
    ])
    const { router, provider } = await harness(t, mock)

    const reply = await router.ask(ANALYSIS_PROMPT)

    assert.equal(reply.kind, 'insufficient')
    assert.match(reply.text, /nothing/i)
    assert.equal(provider!.calls.length, 0, 'no provider call when there is nothing to analyse')
  })

  test('with no AI provider it still says what matters, honestly', async (t) => {
    const mock = new GraphMock([
      { match: '/me/mailFolders/inbox/messages', body: { value: mixedInbox() } }
    ])
    const { router } = await harness(t, mock, { provider: null })

    const reply = await router.ask(ANALYSIS_PROMPT)

    assert.equal(reply.kind, 'notice')
    assert.match(reply.text, /AI provider/i)
    assert.ok(reply.messages!.length > 0, 'the shortlist is still shown')
  })
})

describe('the briefing prompt, end to end', () => {
  const routes = (messages: Array<Record<string, unknown>>, events: Array<Record<string, unknown>>) => [
    { match: '/me/mailFolders/inbox/messages', body: { value: messages } },
    { match: '/me/calendarView', body: { value: events } }
  ]

  test('it answers from mail and calendar, not from local documents', async (t) => {
    const mock = new GraphMock(routes(mixedInbox(), [graphEvent()]))
    const { router } = await harness(t, mock, {
      provider: new FakeProvider(() => 'Deal with the overdue invoice first.')
    })

    const reply = await router.ask(BRIEFING_PROMPT)

    assert.equal(reply.capability, 'brief')
    assert.equal(reply.shape, 'brief')
    assert.equal(reply.results.length, 0, 'a brief is not a file search')
    assert.ok(reply.events && reply.events.length > 0, 'the meetings half was answered')
    assert.ok(reply.messages && reply.messages.length > 0, 'the email half was answered')
    assert.match(reply.text, /Deal with the overdue invoice first\./)
  })

  test('the headline states the day in facts the user can check', async (t) => {
    const mock = new GraphMock(routes(mixedInbox(), [graphEvent()]))
    const { router } = await harness(t, mock)
    const reply = await router.ask('Brief me.')
    assert.match(reply.text, /meeting/i)
    assert.match(reply.text, /unread/i)
  })

  test('an empty day is said plainly, without inventing urgency', async (t) => {
    const mock = new GraphMock(routes([], []))
    const { router, provider } = await harness(t, mock)

    const reply = await router.ask('Give me my daily briefing.')

    assert.match(reply.text, /No meetings today/i)
    assert.match(reply.text, /clear|nothing/i)
    assert.equal(provider!.calls.length, 0, 'nothing to summarise means nothing is sent')
  })

  test('meetings with a quiet inbox still get a written brief', async (t) => {
    const mock = new GraphMock(routes([], [graphEvent()]))
    const { router, provider } = await harness(t, mock, {
      provider: new FakeProvider(() => 'One meeting, nothing pressing in the inbox.')
    })

    const reply = await router.ask('Give me my daily briefing.')

    assert.equal(provider!.calls.length, 1)
    assert.match(reply.text, /One meeting, nothing pressing in the inbox\./)
  })
})

// ---------------------------------------------------------------------------
// Everything that was already true must stay true
// ---------------------------------------------------------------------------

describe('retrieval is unchanged and still free', () => {
  test('asking to see what needs attention sends nothing anywhere', async (t) => {
    const mock = new GraphMock([
      { match: '/me/mailFolders/inbox/messages', body: { value: mixedInbox() } }
    ])
    const { router, provider } = await harness(t, mock)

    const reply = await router.ask('What needs my attention in my inbox?')

    assert.equal(reply.capability, 'mail')
    assert.equal(reply.shape, 'retrieve')
    assert.equal(reply.kind, 'results')
    assert.equal(provider!.calls.length, 0, 'retrieval never calls a model')
    assert.equal(reply.disclosure, undefined)
  })

  test('the attention list is still newest first', async (t) => {
    const mock = new GraphMock([
      { match: '/me/mailFolders/inbox/messages', body: { value: mixedInbox() } }
    ])
    const { router } = await harness(t, mock)

    const reply = await router.ask('What needs my attention in my inbox?')
    const times = reply.messages!.map((m) => m.receivedAt)
    assert.deepEqual(times, [...times].sort((a, b) => b - a))
  })

  test('a count shortens a retrieval list and says what was cut', async (t) => {
    const mock = new GraphMock([
      { match: '/me/mailFolders/inbox/messages', body: { value: mixedInbox() } }
    ])
    const { router } = await harness(t, mock)

    const reply = await router.ask('Show me my 2 most recent emails.')
    assert.equal(reply.messages!.length, 2)
    assert.match(reply.text, /of 5/)
  })
})

describe('the safety architecture is untouched', () => {
  test('analysing mail never sends, creates or changes anything', async (t) => {
    const mock = new GraphMock([
      { match: '/me/mailFolders/inbox/messages', body: { value: mixedInbox() } },
      { match: '/me/calendarView', body: { value: [graphEvent()] } }
    ])
    const { router, mock: m } = await harness(t, mock)

    for (const question of [ANALYSIS_PROMPT, BRIEFING_PROMPT, 'What needs my attention in my inbox?']) {
      await router.ask(question)
    }

    assert.equal(m.mutatingCalls().length, 0, 'reading mail must never write to Microsoft 365')
    assert.equal(m.sendCalls().length, 0, 'nothing may be sent')
  })

  test('an analysis never produces a draft or a pending action on its own', async (t) => {
    const mock = new GraphMock([
      { match: '/me/mailFolders/inbox/messages', body: { value: mixedInbox() } }
    ])
    const { router } = await harness(t, mock)

    const reply = await router.ask(ANALYSIS_PROMPT)
    assert.equal(reply.draft, undefined)
    assert.equal(reply.pendingAction, undefined)
  })

  test('no Microsoft token or address book reaches the AI provider', async (t) => {
    const mock = new GraphMock([
      { match: '/me/mailFolders/inbox/messages', body: { value: mixedInbox() } }
    ])
    const { router, provider } = await harness(t, mock)

    await router.ask(ANALYSIS_PROMPT)
    const sent = JSON.stringify(provider!.calls[0]!.request)
    assert.equal(/tok|Bearer|refresh_token|client_secret/.test(sent), false)
  })

  test('V0.1 document questions still go to documents', async (t) => {
    const mock = new GraphMock([{ match: '/me/', body: { value: [] } }])
    const { router } = await harness(t, mock)
    const reply = await router.ask('Find my latest GTA operational plan.')
    assert.equal(reply.capability, 'documents')
  })
})
