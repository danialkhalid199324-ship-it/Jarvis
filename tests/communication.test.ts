import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { Logger } from '../src/core/logging/logger'
import { ProviderRegistry } from '../src/core/ai/registry'
import { ApprovalEngine } from '../src/core/communication/approvals'
import { MicrosoftWorkspace } from '../src/core/microsoft/workspace'
import { AccountRegistry } from '../src/core/microsoft/accounts'
import { MailCapability } from '../src/core/assistant/capabilities/mail-capability'
import { CalendarCapability } from '../src/core/assistant/capabilities/calendar-capability'
import { routeQuestion } from '../src/core/assistant/routing'
import { assessAttention, needingAttention, scoreMessages } from '../src/core/communication/mail-intelligence'
import { buildMailExcerpts, citedMailSources } from '../src/core/communication/mail-context'
import { mapMessage } from '../src/core/microsoft/mapping'
import { parseTimeOfDay, parseDayReference } from '../src/core/communication/time'
import { GraphMock, fakeAccount, graphMessage, graphEvent } from './graph-mock'
import { makeTempDir, cleanup, FakeProvider } from './helpers'
import type { CompletionRequest } from '../src/core/ai/provider'
import type { MailMessage } from '../src/shared/communication'

const OWN = ['danial@gta.example']
const msg = (o: Record<string, unknown> = {}): MailMessage =>
  mapMessage(graphMessage(o), fakeAccount())

// ---------------------------------------------------------------------------
// Attention scoring — deterministic, no AI
// ---------------------------------------------------------------------------

describe('mail attention scoring', () => {
  test('an unread, directly addressed request scores as needing attention', () => {
    const a = assessAttention(msg(), { ownAddresses: OWN })
    assert.equal(a.needsAttention, true)
    assert.ok(a.reasons.includes('unread'))
    assert.ok(a.reasons.includes('addressed to you directly'))
  })

  test('newsletters and automated senders are pushed down', () => {
    const newsletter = msg({
      from: { emailAddress: { name: 'Acme News', address: 'no-reply@acme.example' } },
      subject: 'Our monthly newsletter — unsubscribe any time'
    })
    assert.equal(assessAttention(newsletter, { ownAddresses: OWN }).needsAttention, false)
  })

  test('being only cc\'d counts for less than being addressed', () => {
    const direct = assessAttention(msg(), { ownAddresses: OWN }).score
    const copied = assessAttention(
      msg({
        toRecipients: [{ emailAddress: { address: 'someone@else.example' } }],
        ccRecipients: [{ emailAddress: { address: 'danial@gta.example' } }]
      }),
      { ownAddresses: OWN }
    ).score
    assert.ok(copied < direct)
  })

  test('high importance and flags are respected', () => {
    const plain = assessAttention(msg({ isRead: true }), { ownAddresses: OWN }).score
    const important = assessAttention(msg({ isRead: true, importance: 'high' }), { ownAddresses: OWN })
    const flagged = assessAttention(msg({ isRead: true, flag: { flagStatus: 'flagged' } }), { ownAddresses: OWN })
    assert.ok(important.score > plain)
    assert.ok(flagged.score > plain)
    assert.ok(important.reasons.includes('marked high importance'))
  })

  test('urgency language raises the score and is explained', () => {
    const urgent = assessAttention(msg({ subject: 'URGENT: deadline tomorrow' }), { ownAddresses: OWN })
    assert.ok(urgent.reasons.includes('says it is urgent'))
    assert.ok(urgent.reasons.includes('mentions a deadline'))
  })

  test('mail you sent yourself is not treated as a request', () => {
    const own = msg({ from: { emailAddress: { address: 'danial@gta.example' } }, isRead: true })
    const a = assessAttention(own, { ownAddresses: OWN })
    assert.ok(a.reasons.includes('sent by you'))
    assert.equal(a.needsAttention, false)
  })

  test('every raised message can say why it was raised', () => {
    const flagged = needingAttention([msg(), msg({ id: 'm2', subject: 'Please confirm the audit date' })], {
      ownAddresses: OWN
    })
    for (const m of flagged) assert.ok(m.attention.reasons.length > 0)
  })

  test('scoring is stable and ordered by pressing-ness', () => {
    const sorted = scoreMessages(
      [msg({ id: 'low', isRead: true, subject: 'FYI' }), msg({ id: 'high', importance: 'high', subject: 'URGENT: please confirm' })],
      { ownAddresses: OWN }
    )
    assert.equal(sorted[0]!.id, 'high')
  })
})

// ---------------------------------------------------------------------------
// AI excerpt minimisation
// ---------------------------------------------------------------------------

describe('AI excerpt minimisation for mail', () => {
  test('sends only the selected messages, never a mailbox', () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg({ id: `m${i}`, bodyPreview: `Body ${i}` }))
    const bundle = buildMailExcerpts(messages, { maxChars: 60_000, maxMessages: 5 })
    assert.equal(bundle.excerpts.length, 5, 'must not send more than asked for')
  })

  test('stops at the character budget', () => {
    const long = 'x'.repeat(5_000)
    const messages = Array.from({ length: 10 }, (_, i) => msg({ id: `m${i}`, body: { contentType: 'Text', content: long } }))
    const bundle = buildMailExcerpts(messages, { maxChars: 5_000, maxMessages: 10 })
    assert.ok(bundle.charsSent <= 6_000, `sent ${bundle.charsSent}`)
    assert.ok(bundle.excerpts.length < 10)
  })

  test('a long body is truncated rather than sent whole', () => {
    const bundle = buildMailExcerpts([msg({ body: { contentType: 'Text', content: 'y'.repeat(50_000) } })], {
      maxChars: 60_000,
      maxMessages: 1
    })
    assert.ok(bundle.excerpts[0]!.text.includes('[truncated]'))
    assert.ok(bundle.excerpts[0]!.text.length < 3_000)
  })

  test('reports exactly what was sent, for disclosure', () => {
    const bundle = buildMailExcerpts([msg(), msg({ id: 'm2', subject: 'Second' })], {
      maxChars: 60_000,
      maxMessages: 5
    })
    assert.deepEqual(bundle.subjects, ['Quarterly compliance review', 'Second'])
    assert.deepEqual(bundle.accountLabels, ['GTA'])
    assert.ok(bundle.charsSent > 0)
  })

  test('citations map back to the messages actually used', () => {
    const bundle = buildMailExcerpts([msg({ id: 'a' }), msg({ id: 'b', subject: 'B' }), msg({ id: 'c', subject: 'C' })], {
      maxChars: 60_000,
      maxMessages: 5
    })
    const sources = citedMailSources('The audit is on Friday [1]. Sarah confirmed [3].', bundle.excerpts)
    assert.deepEqual(sources.map((s) => s.messageId), ['a', 'c'])
  })

  test('no credential or token can reach the excerpt text', () => {
    const bundle = buildMailExcerpts([msg()], { maxChars: 60_000, maxMessages: 1 })
    const all = JSON.stringify(bundle)
    assert.ok(!/Bearer|access_token|refresh|client_secret/i.test(all))
  })
})

// ---------------------------------------------------------------------------
// End-to-end: mail and calendar through a mocked Graph
// ---------------------------------------------------------------------------

function planningProvider(answer: string): FakeProvider {
  return new FakeProvider((request: CompletionRequest) => {
    if (request.jsonSchemaHint) return '{}'
    return answer
  })
}

async function harness(
  t: { after: (fn: () => unknown) => void },
  mock: GraphMock,
  options: { accounts?: Array<{ label: string; username: string }>; provider?: FakeProvider } = {}
) {
  const dir = await makeTempDir('comm')
  const logger = new Logger(path.join(dir, 'logs'))
  t.after(async () => {
    await logger.flush()
    await cleanup(dir)
  })

  const registry = await AccountRegistry.open(dir)
  const specs = options.accounts ?? [{ label: 'GTA', username: 'danial@gta.example' }]
  for (const [i, spec] of specs.entries()) {
    const account = await registry.upsert({
      homeAccountId: `home-${i}`,
      username: spec.username,
      displayName: spec.label,
      tenantId: `tenant-${i}`
    })
    await registry.setLabel(account.id, spec.label)
  }

  const auth = {
    isConfigured: () => true,
    getAccessToken: async (homeAccountId: string) => {
      if (homeAccountId === 'expired') throw new (await import('../src/core/microsoft/auth')).NeedsReauthError('expired')
      return 'fake-token'
    },
    signIn: async () => ({ homeAccountId: 'h', username: 'u', displayName: 'd', tenantId: 't' }),
    signOut: async () => undefined,
    listCachedAccounts: async () => [],
    requestedScopes: () => []
  }

  const workspace = new MicrosoftWorkspace({
    auth: auth as never,
    registry,
    logger,
    fetchImpl: mock.fetch
  })

  const provider = options.provider ?? planningProvider('Answer from the messages [1].')
  const providers = new ProviderRegistry([provider], 'fake', 'fake-model')
  const approvals = new ApprovalEngine(logger)

  const mail = new MailCapability({ workspace, providers, logger, maxContextChars: () => 60_000 })
  const calendar = new CalendarCapability({
    workspace,
    approvals,
    logger,
    now: () => Date.parse('2026-09-18T02:00:00Z')
  })

  return { workspace, mail, calendar, approvals, provider, registry, logger }
}

const ctx = { accountLabels: ['GTA', 'Titan'] }

describe('email retrieval end to end', () => {
  test('"Check my emails." returns real mailbox data tagged with the account', async (t) => {
    const mock = new GraphMock([
      { match: '/me/mailFolders/inbox/messages', body: { value: [graphMessage(), graphMessage({ id: 'm2', subject: 'Second' })] } }
    ])
    const { mail } = await harness(t, mock)
    const reply = await mail.handle('Check my emails.', routeQuestion('Check my emails.', ctx))

    assert.equal(reply.capability, 'mail')
    assert.equal(reply.messages!.length, 2)
    assert.ok(reply.messages!.every((m) => m.accountLabel === 'GTA'))
    // Listing mail must not involve the AI provider at all.
    assert.equal(reply.disclosure, undefined)
  })

  test('search names the account and the term', async (t) => {
    const mock = new GraphMock([{ match: '/me/messages', body: { value: [graphMessage()] } }])
    const { mail } = await harness(t, mock)
    const q = 'Find the email about the Titan capability statement.'
    const reply = await mail.handle(q, routeQuestion(q, ctx))
    assert.equal(reply.messages!.length, 1)
    assert.match(reply.text, /capability statement/i)
  })

  test('attention triage uses deterministic signals and sends nothing', async (t) => {
    const mock = new GraphMock([
      {
        match: '/me/mailFolders/inbox/messages',
        body: {
          value: [
            graphMessage({ id: 'urgent', subject: 'URGENT: please confirm the audit date', importance: 'high' }),
            graphMessage({ id: 'news', subject: 'Monthly newsletter', from: { emailAddress: { address: 'no-reply@x.example' } }, isRead: true })
          ]
        }
      }
    ])
    const { mail, provider } = await harness(t, mock)
    const q = 'What important emails need my attention?'
    const reply = await mail.handle(q, routeQuestion(q, ctx))

    assert.ok(reply.messages!.length >= 1)
    assert.equal(reply.messages![0]!.id, 'urgent')
    assert.ok(!reply.messages!.some((m) => m.id === 'news'))
    assert.equal(provider.calls.length, 0, 'triage must not call the model')
  })
})

describe('multi-account behaviour', () => {
  test('searches every account and labels each result', async (t) => {
    const mock = new GraphMock([{ match: '/me/messages', body: { value: [graphMessage()] } }])
    const { mail } = await harness(t, mock, {
      accounts: [
        { label: 'GTA', username: 'd@gta.example' },
        { label: 'Titan', username: 'd@titan.example' }
      ]
    })
    const q = 'Search all my accounts for emails about LRD.'
    const reply = await mail.handle(q, routeQuestion(q, ctx))
    assert.equal(reply.messages!.length, 2)
    assert.deepEqual([...new Set(reply.messages!.map((m) => m.accountLabel))].sort(), ['GTA', 'Titan'])
  })

  test('one unreachable account is reported, never hidden', async (t) => {
    let call = 0
    const mock = new GraphMock([])
    mock.add({
      match: '/me/mailFolders/inbox/messages',
      get status() {
        // Second account's request fails with an expired session.
        return ++call === 2 ? 401 : 200
      },
      body: { value: [graphMessage()] }
    } as never)

    const { mail } = await harness(t, mock, {
      accounts: [
        { label: 'GTA', username: 'd@gta.example' },
        { label: 'Titan', username: 'd@titan.example' }
      ]
    })
    const reply = await mail.handle('Check my emails.', routeQuestion('Check my emails.', ctx))

    assert.ok(reply.coverage, 'partial failure must be stated')
    assert.match(reply.coverage!, /checked 1 of your 2 connected accounts/i)
    assert.match(reply.coverage!, /Titan|GTA/)
  })

  test('asking about one account does not read the others', async (t) => {
    const mock = new GraphMock([{ match: '/me/mailFolders/inbox/messages', body: { value: [graphMessage()] } }])
    const { mail } = await harness(t, mock, {
      accounts: [
        { label: 'GTA', username: 'd@gta.example' },
        { label: 'Titan', username: 'd@titan.example' }
      ]
    })
    const q = 'Check my GTA emails.'
    await mail.handle(q, routeQuestion(q, ctx))
    assert.equal(mock.calls.length, 1, 'only the named account should be queried')
  })
})

describe('answering from mail sends only what it read', () => {
  test('grounded answer with citations and a disclosure', async (t) => {
    const mock = new GraphMock([
      { match: '/me/messages/', body: graphMessage({ body: { contentType: 'Text', content: 'The audit is booked for Friday.' } }) },
      { match: '/me/messages', body: { value: [graphMessage()] } }
    ])
    const provider = planningProvider('The audit is booked for Friday [1].')
    const { mail } = await harness(t, mock, { provider })

    const q = 'What happened with the Bluebird invoice?'
    const reply = await mail.handle(q, { capability: 'mail', mailIntent: 'answer', searchTerms: 'Bluebird invoice', reason: 'test' })

    assert.equal(reply.kind, 'answer')
    assert.ok(reply.disclosure)
    assert.equal(reply.disclosure!.itemKind, 'emails')
    assert.deepEqual(reply.disclosure!.accountLabels, ['GTA'])
    assert.ok(reply.mailSources!.length > 0)

    // What actually went to the model: only the selected excerpts.
    const sent = provider.calls[0]!.request.messages[0]!.content
    assert.ok(sent.includes('Quarterly compliance review'))
    assert.ok(!/Bearer|fake-token/.test(sent), 'no token may reach the provider')
  })

  test('says so plainly when the mail does not contain the answer', async (t) => {
    const mock = new GraphMock([
      { match: '/me/messages/', body: graphMessage({ body: { contentType: 'Text', content: 'Unrelated.' } }) },
      { match: '/me/messages', body: { value: [graphMessage()] } }
    ])
    const provider = planningProvider('INSUFFICIENT: these messages say nothing about that.')
    const { mail } = await harness(t, mock, { provider })
    const reply = await mail.handle('What happened?', { capability: 'mail', mailIntent: 'answer', searchTerms: 'x', reason: 't' })
    assert.equal(reply.kind, 'insufficient')
    assert.match(reply.text, /could not find enough/i)
  })

  test('without a provider, mail still lists but says why it cannot summarise', async (t) => {
    const mock = new GraphMock([{ match: '/me/messages', body: { value: [graphMessage()] } }])
    const dir = await makeTempDir('noai')
    const logger = new Logger(path.join(dir, 'logs'))
    t.after(async () => { await logger.flush(); await cleanup(dir) })
    const registry = await AccountRegistry.open(dir)
    const acc = await registry.upsert({ homeAccountId: 'h', username: 'd@gta.example', displayName: 'GTA', tenantId: 't' })
    await registry.setLabel(acc.id, 'GTA')
    const workspace = new MicrosoftWorkspace({
      auth: { isConfigured: () => true, getAccessToken: async () => 'tok' } as never,
      registry,
      logger,
      fetchImpl: mock.fetch
    })
    const mail = new MailCapability({
      workspace,
      providers: new ProviderRegistry([], 'anthropic', 'claude-opus-5'),
      logger,
      maxContextChars: () => 60_000
    })
    const reply = await mail.handle('What happened?', { capability: 'mail', mailIntent: 'answer', searchTerms: 'x', reason: 't' })
    assert.equal(reply.kind, 'notice')
    assert.match(reply.text, /AI provider/i)
    assert.ok(reply.messages!.length > 0, 'retrieval still works without AI')
  })
})

describe('drafting never sends', () => {
  test('a draft is produced and nothing is sent', async (t) => {
    const mock = new GraphMock([
      { match: '/me/messages/', body: graphMessage({ body: { contentType: 'Text', content: 'Can we meet Sunday?' } }) },
      { match: '/me/mailFolders/inbox/messages', body: { value: [graphMessage()] } },
      { match: '/me/messages', body: { value: [graphMessage()] } }
    ])
    const provider = planningProvider('Hi Sarah,\n\nSunday on Zoom works for me.')
    const { mail } = await harness(t, mock, { provider })

    const q = 'Draft a reply to Sarah saying Sunday Zoom works.'
    const reply = await mail.handle(q, routeQuestion(q, ctx))

    assert.ok(reply.draft, 'a draft must be produced')
    assert.match(reply.draft!.body, /Sunday/)
    assert.equal(reply.draft!.subject, 'Re: Quarterly compliance review')
    assert.equal(reply.draft!.accountLabel, 'GTA')
    assert.match(reply.text, /Nothing has been sent/i)

    // The decisive check: no send request reached Graph.
    assert.equal(mock.sendCalls().length, 0)
    assert.equal(mock.mutatingCalls().length, 0)
  })

  test('the reply is addressed to the sender, and never to the user themselves', async (t) => {
    const mock = new GraphMock([
      { match: '/me/messages/', body: graphMessage({ body: { contentType: 'Text', content: 'Hello' } }) },
      { match: '/me/mailFolders/inbox/messages', body: { value: [graphMessage()] } },
      { match: '/me/messages', body: { value: [graphMessage()] } }
    ])
    const { mail } = await harness(t, mock, { provider: planningProvider('Reply body.') })
    const reply = await mail.handle('Draft a reply to Sarah.', { capability: 'mail', mailIntent: 'draft', reason: 't' })

    const draft = reply.draft!
    assert.deepEqual(draft.to.map((r) => r.address), ['sarah@client.example'])
    assert.ok(!draft.to.concat(draft.cc).some((r) => r.address === 'danial@gta.example'))
  })
})

describe('calendar end to end', () => {
  test('"What\'s on today?" returns real events with their account', async (t) => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [graphEvent()] } }])
    const { calendar } = await harness(t, mock)
    const reply = await calendar.handle("What's on today?", routeQuestion("What's on today?", ctx))
    assert.equal(reply.capability, 'calendar')
    assert.equal(reply.events!.length, 1)
    assert.equal(reply.events![0]!.accountLabel, 'GTA')
  })

  test('a specific-time question is answered directly', async (t) => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [graphEvent()] } }])
    const { calendar } = await harness(t, mock)
    const q = 'Do I have anything at 10:30 am?'
    const reply = await calendar.handle(q, routeQuestion(q, ctx))
    assert.equal(reply.capability, 'calendar')
  })
})

describe('calendar changes require approval', () => {
  test('"Move ... to 3 PM" prepares a change and touches nothing', async (t) => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [graphEvent()] } }])
    const { calendar, approvals } = await harness(t, mock)

    const q = 'Move my Titan Strategy Call tomorrow to 3 PM.'
    const reply = await calendar.handle(q, routeQuestion(q, ctx))

    assert.ok(reply.pendingAction, 'a change must be proposed')
    assert.equal(reply.pendingAction!.type, 'UPDATE_EVENT')
    assert.equal(reply.pendingAction!.status, 'PROPOSED')
    assert.equal(mock.mutatingCalls().length, 0, 'the calendar must be untouched')

    // The proposal shows before and after.
    const timeField = reply.pendingAction!.preview.find((f) => f.label === 'Time')!
    assert.ok(timeField.previous, 'must show the current time')
    assert.ok(timeField.value, 'must show the proposed time')
    assert.notEqual(timeField.previous, timeField.value)
    assert.equal(approvals.pending().length, 1)
  })

  test('cancellation is prepared with a clear warning, and nothing is cancelled', async (t) => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [graphEvent()] } }])
    const { calendar } = await harness(t, mock)
    const q = 'Cancel the Titan Strategy Call tomorrow.'
    const reply = await calendar.handle(q, routeQuestion(q, ctx))

    assert.equal(reply.pendingAction!.type, 'DELETE_EVENT')
    assert.equal(reply.pendingAction!.riskLevel, 'high')
    assert.match(reply.pendingAction!.warning ?? '', /cannot be undone|everyone invited/i)
    assert.equal(mock.mutatingCalls().length, 0)
  })

  test('approving performs exactly one Graph mutation', async (t) => {
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [graphEvent()] } },
      { method: 'PATCH', match: '/me/events/', status: 200, body: {} }
    ])
    const { calendar, approvals, workspace } = await harness(t, mock)

    approvals.registerExecutor('UPDATE_EVENT', async (payload) => {
      const p = payload as { accountId: string; eventId: string; changes: { start?: number; end?: number } }
      const account = workspace.accounts().find((a) => a.id === p.accountId)!
      await workspace.calendarFor(account).updateEvent(p.eventId, p.changes)
      return 'Meeting moved'
    })

    const q = 'Move my Titan Strategy Call tomorrow to 3 PM.'
    const reply = await calendar.handle(q, routeQuestion(q, ctx))
    assert.equal(mock.mutatingCalls().length, 0)

    const done = await approvals.approve(reply.pendingAction!.id)
    assert.equal(done.status, 'COMPLETED')
    const mutations = mock.mutatingCalls()
    assert.equal(mutations.length, 1, 'exactly one mutation')
    assert.equal(mutations[0]!.method, 'PATCH')
  })

  test('rejecting leaves the calendar untouched', async (t) => {
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [graphEvent()] } },
      { method: 'PATCH', match: '/me/events/', body: {} }
    ])
    const { calendar, approvals } = await harness(t, mock)
    const q = 'Move my Titan Strategy Call tomorrow to 3 PM.'
    const reply = await calendar.handle(q, routeQuestion(q, ctx))
    approvals.reject(reply.pendingAction!.id)
    assert.equal(mock.mutatingCalls().length, 0)
  })

  test('a meeting that cannot be found changes nothing', async (t) => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [] } }])
    const { calendar } = await harness(t, mock)
    const q = 'Move my Nonexistent Meeting tomorrow to 3 PM.'
    const reply = await calendar.handle(q, routeQuestion(q, ctx))
    assert.equal(reply.pendingAction, undefined)
    assert.match(reply.text, /could not find|Nothing has been changed/i)
    assert.equal(mock.mutatingCalls().length, 0)
  })
})

describe('time parsing', () => {
  test('reads the times people actually type', () => {
    assert.equal(parseTimeOfDay('move it to 3 PM'), 15 * 60)
    assert.equal(parseTimeOfDay('at 9:30am'), 9 * 60 + 30)
    assert.equal(parseTimeOfDay('at 12 am'), 0)
    assert.equal(parseTimeOfDay('at 12 pm'), 12 * 60)
    assert.equal(parseTimeOfDay('at 15:45'), 15 * 60 + 45)
    assert.equal(parseTimeOfDay('no time here'), null)
  })

  test('resolves day references relative to now', () => {
    const now = Date.parse('2026-09-18T02:00:00Z')
    assert.notEqual(parseDayReference('tomorrow', now), parseDayReference('today', now))
    assert.equal(parseDayReference('no day mentioned', now), parseDayReference('today', now))
  })
})
