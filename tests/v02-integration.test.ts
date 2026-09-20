import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
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
import { NeedsReauthError } from '../src/core/microsoft/auth'
import { draftApprovalPreview } from '../src/core/communication/drafts'
import { GraphMock, graphMessage, graphEvent } from './graph-mock'
import { makeTempDir, cleanup, FakeProvider } from './helpers'
import type { CompletionRequest } from '../src/core/ai/provider'
import type { EmailDraft } from '../src/shared/communication'

function provider(answer = 'Answer [1].'): FakeProvider {
  return new FakeProvider((r: CompletionRequest) => (r.jsonSchemaHint ? '{}' : answer))
}

/** A full Jarvis, with Graph mocked and local documents indexed. */
async function jarvis(
  t: { after: (fn: () => unknown) => void },
  mock: GraphMock,
  options: { accounts?: number; provider?: FakeProvider; model?: string } = {}
) {
  const archive = await makeTempDir('v02-archive')
  const dataDir = await makeTempDir('v02-data')
  const logger = new Logger(path.join(dataDir, 'logs'))
  t.after(async () => {
    await logger.flush()
    await cleanup(archive)
    await cleanup(dataDir)
  })

  await fs.writeFile(
    path.join(archive, 'GTA Operational Plan 2026.txt'),
    'GTA Operational Plan 2026. Compliance audit outstanding. Insurance renewal due in June.',
    'utf8'
  )
  await fs.writeFile(
    path.join(archive, 'Titan Security Agreement.txt'),
    'Titan Security Agreement. Licensed guards provided to the client site.',
    'utf8'
  )

  const store = await DocumentStore.open(dataDir)
  const indexer = new Indexer(store, new SearchIndex(), logger)
  await indexer.run({
    folders: [{ id: 'f1', path: archive, label: 'Business', addedAt: new Date().toISOString() }],
    maxFileSizeBytes: 40 * 1024 * 1024
  })

  const registry = await AccountRegistry.open(dataDir)
  for (let i = 0; i < (options.accounts ?? 1); i++) {
    const account = await registry.upsert({
      homeAccountId: `home-${i}`,
      username: `danial@acct${i}.example`,
      displayName: `Account ${i}`,
      tenantId: `t${i}`
    })
    await registry.setLabel(account.id, i === 0 ? 'GTA' : 'Titan')
  }

  const workspace = new MicrosoftWorkspace({
    auth: { isConfigured: () => true, getAccessToken: async () => 'tok' } as never,
    registry,
    logger,
    fetchImpl: mock.fetch
  })

  const fake = options.provider ?? provider()
  const providers = new ProviderRegistry([fake], 'fake', options.model ?? 'fake-model')
  const approvals = new ApprovalEngine(logger)
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
  const calendar = new CalendarCapability({ workspace, approvals, logger })
  const brief = new DailyBriefService({ workspace, store, providers, logger, maxContextChars })

  const router = new JarvisRouter({ documents, mail, calendar, brief, workspace, session, logger })

  return { router, approvals, workspace, mail, calendar, brief, store, provider: fake, mock, registry }
}

// ---------------------------------------------------------------------------
// V0.1 regression through the router
// ---------------------------------------------------------------------------

describe('V0.1 still works through the V0.2 router', () => {
  test('local file search returns the same document as before', async (t) => {
    const mock = new GraphMock([{ match: '/me/', body: { value: [] } }])
    const { router, mock: m } = await jarvis(t, mock)

    const reply = await router.ask('Find my latest GTA operational plan.')
    assert.equal(reply.capability, 'documents')
    assert.equal(reply.results[0]!.document.fileName, 'GTA Operational Plan 2026.txt')
    // A document question must not touch Microsoft at all.
    assert.equal(m.calls.length, 0)
  })

  test('conversational document context survives routing', async (t) => {
    const mock = new GraphMock([{ match: '/me/', body: { value: [] } }])
    const { router } = await jarvis(t, mock, { provider: provider('The audit is outstanding [1].') })

    await router.ask('Find my latest GTA operational plan.')
    const reply = await router.ask('Summarise it.')

    assert.equal(reply.capability, 'documents')
    assert.equal(reply.kind, 'answer')
    assert.equal(reply.sources[0]!.fileName, 'GTA Operational Plan 2026.txt')
  })

  test('a third follow-up still works from the same document', async (t) => {
    const mock = new GraphMock([{ match: '/me/', body: { value: [] } }])
    const { router } = await jarvis(t, mock, { provider: provider('Outstanding: the audit [1].') })

    await router.ask('Find my latest GTA operational plan.')
    await router.ask('Summarise it.')
    const reply = await router.ask('What are the outstanding priorities?')
    assert.equal(reply.capability, 'documents')
    assert.equal(reply.sources[0]!.fileName, 'GTA Operational Plan 2026.txt')
  })

  test('local search works with no Microsoft account connected', async (t) => {
    const mock = new GraphMock([])
    const { router } = await jarvis(t, mock, { accounts: 0 })
    const reply = await router.ask('Find documents relating to Titan Security.')
    assert.equal(reply.capability, 'documents')
    assert.ok(reply.results.length > 0)
  })

  test('the router sends mail questions to mail and file questions to files', async (t) => {
    const mock = new GraphMock([{ match: '/me/mailFolders/inbox/messages', body: { value: [graphMessage()] } }])
    const { router } = await jarvis(t, mock)

    assert.equal((await router.ask('Check my emails.')).capability, 'mail')
    assert.equal((await router.ask('Find my latest GTA operational plan.')).capability, 'documents')
  })
})

// ---------------------------------------------------------------------------
// Send is blocked without approval, end to end
// ---------------------------------------------------------------------------

describe('sending email requires explicit approval', () => {
  const draft = (): EmailDraft => ({
    accountId: 'x',
    accountLabel: 'GTA',
    fromAddress: 'danial@acct0.example',
    to: [{ address: 'sarah@client.example' }],
    cc: [],
    subject: 'Re: Quarterly compliance review',
    body: 'Sunday on Zoom works.'
  })

  test('preparing a send proposes an action and sends nothing', async (t) => {
    const mock = new GraphMock([{ match: '/me/', body: { value: [] } }])
    const { approvals, workspace, mock: m } = await jarvis(t, mock)
    const accountId = workspace.accounts()[0]!.id

    const action = approvals.propose({
      type: 'SEND_EMAIL',
      riskLevel: 'high',
      description: 'Send email',
      source: 'Review & Send',
      accountId,
      accountLabel: 'GTA',
      preview: draftApprovalPreview({ ...draft(), accountId }),
      payload: { accountId, to: ['sarah@client.example'], cc: [], subject: 'Re: x', body: 'y' }
    })

    assert.equal(action.status, 'PROPOSED')
    assert.equal(m.sendCalls().length, 0, 'nothing may be sent at propose time')
  })

  test('approving sends exactly once, and only then', async (t) => {
    const mock = new GraphMock([
      { method: 'POST', match: '/me/sendMail', status: 202, body: {} },
      { match: '/me/', body: { value: [] } }
    ])
    const { approvals, workspace, mock: m } = await jarvis(t, mock)
    const account = workspace.accounts()[0]!

    approvals.registerExecutor<{ to: string[]; cc: string[]; subject: string; body: string }>(
      'SEND_EMAIL',
      async (payload) => {
        await workspace.mailFor(account).sendMail(payload)
        return 'sent'
      }
    )

    const action = approvals.propose({
      type: 'SEND_EMAIL',
      riskLevel: 'high',
      description: 'Send email',
      source: 'Review & Send',
      accountId: account.id,
      accountLabel: account.label,
      preview: [],
      payload: { to: ['sarah@client.example'], cc: [], subject: 'Re: x', body: 'y' }
    })

    assert.equal(m.sendCalls().length, 0)
    const done = await approvals.approve(action.id)
    assert.equal(done.status, 'COMPLETED')
    assert.equal(m.sendCalls().length, 1, 'exactly one send')
  })

  test('rejecting sends nothing, ever', async (t) => {
    const mock = new GraphMock([
      { method: 'POST', match: '/me/sendMail', body: {} },
      { match: '/me/', body: { value: [] } }
    ])
    const { approvals, workspace, mock: m } = await jarvis(t, mock)
    const account = workspace.accounts()[0]!
    approvals.registerExecutor('SEND_EMAIL', async () => {
      await workspace.mailFor(account).sendMail({ to: [], cc: [], subject: '', body: '' })
      return 'sent'
    })

    const action = approvals.propose({
      type: 'SEND_EMAIL',
      riskLevel: 'high',
      description: 'Send',
      source: 'x',
      accountId: account.id,
      accountLabel: account.label,
      preview: [],
      payload: {}
    })
    approvals.reject(action.id)
    await assert.rejects(() => approvals.approve(action.id))
    assert.equal(m.sendCalls().length, 0)
  })

  test('the approval preview shows the exact recipients, subject and body', () => {
    const fields = draftApprovalPreview(draft())
    const byLabel = Object.fromEntries(fields.map((f) => [f.label, f.value]))
    assert.equal(byLabel['To'], 'sarah@client.example')
    assert.equal(byLabel['Subject'], 'Re: Quarterly compliance review')
    assert.equal(byLabel['Message'], 'Sunday on Zoom works.')
    assert.match(byLabel['From account'] ?? '', /GTA/)
  })

  test('a draft with no recipient cannot even be prepared for sending', () => {
    const fields = draftApprovalPreview({ ...draft(), to: [] })
    assert.equal(fields.find((f) => f.label === 'To')!.value, '(no recipient)')
  })
})

// ---------------------------------------------------------------------------
// Daily brief and dashboard
// ---------------------------------------------------------------------------

describe('daily brief', () => {
  test('separates retrieved fact from AI prioritisation', async (t) => {
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [graphEvent()] } },
      { match: '/me/mailFolders/inbox/messages', body: { value: [graphMessage({ importance: 'high' })] } },
      { match: '/me/messages/', body: graphMessage() }
    ])
    const { brief } = await jarvis(t, mock, { provider: provider('The compliance deadline is the pressing item.') })
    const result = await brief.build()

    // Facts are retrieved, not generated.
    assert.equal(result.facts.meetingsToday.length, 1)
    assert.equal(result.facts.meetingsToday[0]!.subject, 'Titan Strategy Call')
    assert.equal(result.facts.unreadCount, 1)
    assert.ok(result.facts.needsAttentionCount >= 1)

    // The AI portion is separate and labelled.
    assert.equal(result.focus, 'The compliance deadline is the pressing item.')
    assert.ok(result.disclosure, 'the brief must disclose what it sent')
  })

  test('works without an AI provider, saying why the summary is missing', async (t) => {
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [graphEvent()] } },
      { match: '/me/mailFolders/inbox/messages', body: { value: [graphMessage()] } }
    ])
    const archive = await makeTempDir('brief-noai')
    const dataDir = await makeTempDir('brief-noai-data')
    const logger = new Logger(path.join(dataDir, 'logs'))
    t.after(async () => { await logger.flush(); await cleanup(archive); await cleanup(dataDir) })

    const store = await DocumentStore.open(dataDir)
    const registry = await AccountRegistry.open(dataDir)
    await registry.upsert({ homeAccountId: 'h', username: 'd@x.example', displayName: 'GTA', tenantId: 't' })
    const workspace = new MicrosoftWorkspace({
      auth: { isConfigured: () => true, getAccessToken: async () => 'tok' } as never,
      registry, logger, fetchImpl: mock.fetch
    })
    const brief = new DailyBriefService({
      workspace, store,
      providers: new ProviderRegistry([], 'anthropic', 'claude-opus-5'),
      logger, maxContextChars: () => 60_000
    })

    const result = await brief.build()
    assert.equal(result.focus, null)
    assert.match(result.focusUnavailableReason ?? '', /AI provider/i)
    // The facts are still there — the brief degrades, it does not disappear.
    assert.equal(result.facts.meetingsToday.length, 1)
  })

  test('reports partial coverage rather than a rosy picture', async (t) => {
    let calls = 0
    const mock = new GraphMock([])
    mock.add({ match: '/me/calendarView', get status() { return ++calls > 1 ? 401 : 200 }, body: { value: [graphEvent()] } } as never)
    mock.add({ match: '/me/mailFolders/inbox/messages', body: { value: [graphMessage()] } })

    const { brief } = await jarvis(t, mock, { accounts: 2 })
    const result = await brief.build()
    assert.ok(result.failures.length > 0)
    assert.ok(result.accountsChecked < result.accountsTotal || result.failures.length > 0)
  })

  test('never invents a meeting or a message', async (t) => {
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [] } },
      { match: '/me/mailFolders/inbox/messages', body: { value: [] } }
    ])
    const { brief, provider: p } = await jarvis(t, mock)
    const result = await brief.build()
    assert.deepEqual(result.facts.meetingsToday, [])
    assert.deepEqual(result.facts.priorityMail, [])
    assert.equal(result.facts.unreadCount, 0)
    assert.equal(result.focus, null, 'nothing to summarise means no summary')
    assert.equal(p.calls.length, 0, 'an empty day must not cost a model call')
  })
})

describe('dashboard counts', () => {
  test('reports real numbers from real data', async (t) => {
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [graphEvent(), graphEvent({ id: 'e2' })] } },
      { match: '/me/mailFolders/inbox/messages', body: { value: [graphMessage(), graphMessage({ id: 'm2', isRead: true })] } }
    ])
    const { brief } = await jarvis(t, mock)
    const summary = await brief.dashboard()

    assert.equal(summary.calendar.today, 2)
    assert.equal(summary.calendar.available, true)
    assert.equal(summary.mail.unread, 1)
    assert.equal(summary.documents.indexed, 2)
    assert.equal(summary.accountsTotal, 1)
  })

  test('marks a capability unavailable rather than showing zero', async (t) => {
    const mock = new GraphMock([
      { match: '/me/calendarView', status: 401, body: {} },
      { match: '/me/mailFolders/inbox/messages', status: 401, body: {} }
    ])
    const { brief } = await jarvis(t, mock)
    const summary = await brief.dashboard()
    assert.equal(summary.mail.available, false)
    assert.equal(summary.calendar.available, false)
    assert.ok(summary.failures.length > 0)
  })

  test('with no accounts, communication cards are simply absent', async (t) => {
    const mock = new GraphMock([])
    const { brief } = await jarvis(t, mock, { accounts: 0 })
    const summary = await brief.dashboard()
    assert.equal(summary.accountsTotal, 0)
    assert.equal(summary.mail.available, false)
    assert.equal(summary.documents.indexed, 2, 'local intelligence still reports')
  })
})

// ---------------------------------------------------------------------------
// Provider/model selection
// ---------------------------------------------------------------------------

describe('AI model selection is respected everywhere', () => {
  test('mail answering uses the configured model, not a hardcoded one', async (t) => {
    const mock = new GraphMock([
      { match: '/me/messages/', body: graphMessage({ body: { contentType: 'Text', content: 'Body.' } }) },
      { match: '/me/messages', body: { value: [graphMessage()] } }
    ])
    const { mail, provider: p } = await jarvis(t, mock, { model: 'claude-sonnet-5' })
    await mail.handle('What happened?', { capability: 'mail', shape: 'retrieve', mailIntent: 'answer', searchTerms: 'x', reason: 't' })
    assert.ok(p.calls.length > 0)
    assert.ok(p.calls.every((c) => c.model === 'claude-sonnet-5'), 'must use the selected model')
  })

  test('the daily brief uses the configured model too', async (t) => {
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [graphEvent()] } },
      { match: '/me/mailFolders/inbox/messages', body: { value: [graphMessage({ importance: 'high' })] } }
    ])
    const { brief, provider: p } = await jarvis(t, mock, { model: 'claude-sonnet-5' })
    await brief.build()
    assert.ok(p.calls.every((c) => c.model === 'claude-sonnet-5'))
  })
})

// ---------------------------------------------------------------------------
// Expired / revoked accounts
// ---------------------------------------------------------------------------

describe('expired and revoked accounts', () => {
  test('an expired session is reported as needing reconnection', async (t) => {
    const dataDir = await makeTempDir('expired')
    const logger = new Logger(path.join(dataDir, 'logs'))
    t.after(async () => { await logger.flush(); await cleanup(dataDir) })

    const registry = await AccountRegistry.open(dataDir)
    const account = await registry.upsert({ homeAccountId: 'h', username: 'd@x.example', displayName: 'GTA', tenantId: 't' })
    await registry.setLabel(account.id, 'GTA')

    const workspace = new MicrosoftWorkspace({
      auth: {
        isConfigured: () => true,
        getAccessToken: async () => { throw new NeedsReauthError(account.id) }
      } as never,
      registry,
      logger,
      fetchImpl: new GraphMock([]).fetch
    })

    const result = await workspace.listMail({})
    assert.equal(result.items.length, 0)
    assert.equal(result.failures.length, 1)
    assert.equal(result.failures[0]!.kind, 'auth')
    assert.match(result.failures[0]!.reason, /renewed|reconnect/i)

    // The account card reflects it.
    assert.equal(registry.get(account.id)!.status, 'needs_reauth')
  })

  test('consent revoked is distinguished from an expired session', async (t) => {
    const mock = new GraphMock([{ match: '/me/mailFolders/inbox/messages', status: 403, body: {} }])
    const { workspace } = await jarvis(t, mock)
    const result = await workspace.listMail({})
    assert.equal(result.failures[0]!.kind, 'consent')
  })

  test('an offline machine is reported as offline', async (t) => {
    const mock = new GraphMock([{ match: '/me/mailFolders/inbox/messages', networkError: true }])
    const { workspace } = await jarvis(t, mock)
    const result = await workspace.listMail({})
    assert.equal(result.failures[0]!.kind, 'offline')
    assert.match(result.failures[0]!.reason, /internet connection/i)
  })
})
