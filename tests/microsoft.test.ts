import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { GraphClient, GraphError, classifyResponse } from '../src/core/microsoft/graph-client'
import { mapMessage, mapEvent, parseGraphDateTime, htmlToText } from '../src/core/microsoft/mapping'
import { MailService } from '../src/core/microsoft/mail'
import { CalendarService, findFreeSlots } from '../src/core/microsoft/calendar'
import { AccountRegistry, forEachAccount, describeCoverage, describeFailure } from '../src/core/microsoft/accounts'
import { NeedsReauthError } from '../src/core/microsoft/auth'
import { EncryptedTokenCache, TOKEN_CACHE_KEY } from '../src/core/microsoft/token-cache'
import { SecretStore, type Encryptor } from '../src/core/security/secrets'
import { GRAPH_SCOPES, REQUESTED_SCOPES, TOKEN_SCOPES } from '../src/core/microsoft/scopes'
import { GraphMock, fakeAccount, graphMessage, graphEvent } from './graph-mock'
import { makeTempDir, cleanup } from './helpers'
import fs from 'node:fs/promises'

const token = async (): Promise<string> => 'fake-access-token'

// ---------------------------------------------------------------------------
// Graph error classification
// ---------------------------------------------------------------------------

describe('Graph error handling', () => {
  test('classifies each failure the user can actually hit', () => {
    assert.equal(classifyResponse(401, null, '').kind, 'auth')
    assert.equal(classifyResponse(403, null, '').kind, 'consent')
    assert.equal(classifyResponse(404, null, '').kind, 'not_found')
    assert.equal(classifyResponse(429, '30', '').kind, 'throttled')
    assert.equal(classifyResponse(429, '30', '').retryAfterSeconds, 30)
    assert.equal(classifyResponse(503, null, '').kind, 'server')
  })

  test('expired session produces an actionable message, not a stack trace', () => {
    const error = classifyResponse(401, null, '')
    assert.match(error.message, /reconnected/i)
    assert.ok(!/token|bearer/i.test(error.message))
  })

  test('surfaces the Graph message for a not-found', () => {
    const error = classifyResponse(404, null, JSON.stringify({ error: { message: 'Item not found.' } }))
    assert.equal(error.message, 'Item not found.')
  })

  test('an offline machine is reported as offline, not as an empty mailbox', async () => {
    const mock = new GraphMock([{ match: '/me/messages', networkError: true }])
    const client = new GraphClient(token, mock.fetch)
    await assert.rejects(
      () => client.request('/me/messages'),
      (err: unknown) => err instanceof GraphError && err.kind === 'offline'
    )
  })

  test('throttling and server errors are marked retryable; auth failures are not', () => {
    assert.equal(classifyResponse(429, null, '').retryable, true)
    assert.equal(classifyResponse(500, null, '').retryable, true)
    assert.equal(classifyResponse(401, null, '').retryable, false)
  })

  test('a successful 202 with an empty body resolves instead of throwing', async () => {
    // Graph answers /me/sendMail with 202 Accepted and no payload. Parsing
    // that as JSON would throw, turning a delivered email into a reported
    // failure — and, worse, into an approval that looks like it failed.
    const mock = new GraphMock([{ method: 'POST', match: '/me/sendMail', status: 202, emptyBody: true }])
    const client = new GraphClient(token, mock.fetch)

    const result = await client.request('/me/sendMail', { method: 'POST', body: { message: {} } })
    assert.equal(result, undefined)
  })

  test('sending mail against an empty 202 succeeds end to end', async () => {
    const mock = new GraphMock([{ method: 'POST', match: '/me/sendMail', status: 202, emptyBody: true }])
    const service = new MailService(new GraphClient(token, mock.fetch), fakeAccount())

    await service.sendMail({ to: ['sarah@client.example'], cc: [], subject: 'Re: Audit', body: 'Sunday works.' })
    assert.equal(mock.sendCalls().length, 1)
  })

  test('a 204 with no content still resolves', async () => {
    const mock = new GraphMock([{ method: 'PATCH', match: '/me/events/', status: 204 }])
    const client = new GraphClient(token, mock.fetch)
    assert.equal(await client.request('/me/events/evt-1', { method: 'PATCH', body: {} }), undefined)
  })

  test('a whitespace-only body is treated as no body', async () => {
    const mock = new GraphMock([])
    const client = new GraphClient(token, async () => new Response('   \n  ', { status: 200 }))
    assert.equal(await client.request('/me/anything'), undefined)
    assert.equal(mock.calls.length, 0)
  })

  test('a normal JSON response is still parsed', async () => {
    const mock = new GraphMock([{ match: '/me/messages', body: { value: [graphMessage()] } }])
    const page = await new GraphClient(token, mock.fetch).request<{ value: unknown[] }>('/me/messages')
    assert.equal(page.value.length, 1)
  })

  test('an empty body on a failed response is still an error, not a success', async () => {
    // Guards the error path: removing the duplicated ok-check must not let a
    // failure fall through to the empty-body short-circuit.
    const mock = new GraphMock([{ method: 'POST', match: '/me/sendMail', status: 403, emptyBody: true }])
    const client = new GraphClient(token, mock.fetch)
    await assert.rejects(
      () => client.request('/me/sendMail', { method: 'POST', body: {} }),
      (err: unknown) => err instanceof GraphError && err.kind === 'consent'
    )
  })

  test('the access token is sent as a bearer header and never in the URL', async () => {
    const mock = new GraphMock([{ match: '/me/messages', body: { value: [] } }])
    await new GraphClient(token, mock.fetch).request('/me/messages')
    const call = mock.calls[0]!
    assert.equal(call.headers['authorization'], 'Bearer fake-access-token')
    assert.ok(!call.url.includes('fake-access-token'))
  })
})

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

describe('Graph response mapping', () => {
  test('maps a message and stamps it with its owning account', () => {
    const account = fakeAccount()
    const message = mapMessage(graphMessage(), account)
    assert.equal(message.accountId, 'acc-gta')
    assert.equal(message.accountLabel, 'GTA')
    assert.equal(message.subject, 'Quarterly compliance review')
    assert.equal(message.from!.address, 'sarah@client.example')
    assert.equal(message.isRead, false)
    assert.equal(message.receivedAt, Date.parse('2026-09-17T09:30:00Z'))
  })

  test('tolerates missing fields rather than throwing', () => {
    const message = mapMessage({}, fakeAccount())
    assert.equal(message.subject, '(no subject)')
    assert.equal(message.from, null)
    assert.deepEqual(message.to, [])
    assert.equal(message.receivedAt, 0)
  })

  test('an unzoned Graph timestamp is read as UTC, not local time', () => {
    assert.equal(
      parseGraphDateTime('2026-09-18T00:30:00.0000000', 'UTC'),
      Date.parse('2026-09-18T00:30:00Z')
    )
  })

  test('HTML bodies become readable text', () => {
    assert.equal(
      htmlToText('<p>Hello&nbsp;Sarah</p><p>Can we meet &lt;Friday&gt;?</p>'),
      'Hello Sarah\nCan we meet <Friday>?'
    )
  })

  test('maps an event with attendees and its online meeting link', () => {
    const event = mapEvent(graphEvent(), fakeAccount({ id: 'acc-titan', label: 'Titan' }))
    assert.equal(event.accountLabel, 'Titan')
    assert.equal(event.subject, 'Titan Strategy Call')
    assert.equal(event.attendees[0]!.address, 'ali@titan.example')
    assert.equal(event.onlineMeetingUrl, 'https://teams.microsoft.com/l/meetup-join/abc')
    assert.equal(event.end - event.start, 60 * 60 * 1000)
  })
})

// ---------------------------------------------------------------------------
// Mail retrieval and search
// ---------------------------------------------------------------------------

describe('mail retrieval', () => {
  test('lists recent inbox messages', async () => {
    const mock = new GraphMock([
      { match: '/me/mailFolders/inbox/messages', body: { value: [graphMessage(), graphMessage({ id: 'msg-2' })] } }
    ])
    const service = new MailService(new GraphClient(token, mock.fetch), fakeAccount())
    const messages = await service.recent(10)
    assert.equal(messages.length, 2)
    assert.ok(decodeURIComponent(mock.calls[0]!.url).includes('$orderby=receivedDateTime desc'))
  })

  test('unread-only adds a filter rather than filtering client-side', async () => {
    const mock = new GraphMock([{ match: '/me/mailFolders/inbox/messages', body: { value: [] } }])
    await new MailService(new GraphClient(token, mock.fetch), fakeAccount()).recent(10, true)
    assert.ok(decodeURIComponent(mock.calls[0]!.url).includes('isRead eq false'))
  })

  test('search quotes the term and asks for eventual consistency', async () => {
    const mock = new GraphMock([{ match: '/me/messages', body: { value: [graphMessage()] } }])
    const service = new MailService(new GraphClient(token, mock.fetch), fakeAccount())
    const results = await service.search('Bluebird invoice')
    assert.equal(results.length, 1)
    const call = mock.calls[0]!
    assert.ok(decodeURIComponent(call.url).includes('"Bluebird invoice"'))
    assert.equal(call.headers['ConsistencyLevel'], 'eventual')
  })

  test('an empty search returns nothing without calling Graph', async () => {
    const mock = new GraphMock([])
    const results = await new MailService(new GraphClient(token, mock.fetch), fakeAccount()).search('  ')
    assert.deepEqual(results, [])
    assert.equal(mock.calls.length, 0)
  })

  test('paging stops at the requested limit', async () => {
    const page = (ids: string[], next?: string): Record<string, unknown> => ({
      value: ids.map((id) => graphMessage({ id })),
      ...(next ? { '@odata.nextLink': next } : {})
    })
    const mock = new GraphMock([
      { match: 'nextpage', body: page(['m3', 'm4']) },
      { match: '/me/mailFolders/inbox/messages', body: page(['m1', 'm2'], 'https://graph.microsoft.com/v1.0/nextpage') }
    ])
    const messages = await new MailService(new GraphClient(token, mock.fetch), fakeAccount()).recent(3)
    assert.equal(messages.length, 3)
  })
})

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

describe('calendar retrieval', () => {
  test('uses calendarView so recurring meetings appear on the day asked about', async () => {
    const mock = new GraphMock([{ match: '/me/calendarView', body: { value: [graphEvent()] } }])
    const service = new CalendarService(new GraphClient(token, mock.fetch), fakeAccount())
    const events = await service.eventsBetween(Date.parse('2026-09-18T00:00:00Z'), Date.parse('2026-09-19T00:00:00Z'))
    assert.equal(events.length, 1)
    assert.ok(mock.calls[0]!.url.includes('/me/calendarView'))
    assert.equal(mock.calls[0]!.headers['Prefer'], 'outlook.timezone="UTC"')
  })

  test('cancelled events are not presented as upcoming meetings', async () => {
    const mock = new GraphMock([
      { match: '/me/calendarView', body: { value: [graphEvent(), graphEvent({ id: 'evt-2', isCancelled: true })] } }
    ])
    const events = await new CalendarService(new GraphClient(token, mock.fetch), fakeAccount()).eventsBetween(0, Date.now() + 1e10)
    assert.equal(events.length, 1)
    assert.equal(events[0]!.id, 'evt-1')
  })
})

describe('free-slot finding', () => {
  const hour = (h: number): number => Date.parse(`2026-09-18T${String(h).padStart(2, '0')}:00:00Z`)
  const event = (startHour: number, endHour: number): ReturnType<typeof mapEvent> =>
    mapEvent(
      graphEvent({
        start: { dateTime: new Date(hour(startHour)).toISOString(), timeZone: 'UTC' },
        end: { dateTime: new Date(hour(endHour)).toISOString(), timeZone: 'UTC' }
      }),
      fakeAccount()
    )

  test('finds the gaps between meetings', () => {
    const slots = findFreeSlots([event(9, 10), event(13, 14)], hour(9), hour(17))
    assert.deepEqual(
      slots.map((s) => [new Date(s.start).getUTCHours(), new Date(s.end).getUTCHours()]),
      [[10, 13], [14, 17]]
    )
  })

  test('merges overlapping meetings so no fake gap appears', () => {
    const slots = findFreeSlots([event(9, 11), event(10, 12)], hour(9), hour(13))
    assert.equal(slots.length, 1)
    assert.equal(new Date(slots[0]!.start).getUTCHours(), 12)
  })

  test('a fully booked window has no free slots', () => {
    assert.deepEqual(findFreeSlots([event(9, 17)], hour(9), hour(17)), [])
  })

  test('gaps shorter than the minimum are not offered', () => {
    const slots = findFreeSlots([event(9, 10), event(10, 17)], hour(9), hour(17), 30)
    assert.deepEqual(slots, [])
  })
})

// ---------------------------------------------------------------------------
// Accounts: isolation, aggregation, partial failure
// ---------------------------------------------------------------------------

describe('account registry', () => {
  test('persists accounts across restarts without storing any credential', async (t) => {
    const dir = await makeTempDir('ms-accounts')
    t.after(() => cleanup(dir))

    const registry = await AccountRegistry.open(dir)
    await registry.upsert({
      homeAccountId: 'home-1',
      username: 'danial@gta.example',
      displayName: 'Danial Khalid',
      tenantId: 'tenant-1'
    })

    const reopened = await AccountRegistry.open(dir)
    assert.equal(reopened.list().length, 1)
    assert.equal(reopened.list()[0]!.username, 'danial@gta.example')

    // Nothing token-shaped is on disk.
    const raw = await fs.readFile(path.join(dir, 'microsoft-accounts.json'), 'utf8')
    assert.ok(!/token|secret|Bearer|refresh/i.test(raw))
  })

  test('reconnecting an existing account updates it instead of duplicating', async (t) => {
    const dir = await makeTempDir('ms-dup')
    t.after(() => cleanup(dir))
    const registry = await AccountRegistry.open(dir)
    const base = { homeAccountId: 'home-1', username: 'a@x.example', displayName: 'A', tenantId: 't' }
    await registry.upsert(base)
    await registry.upsert({ ...base, displayName: 'A Renamed' })
    assert.equal(registry.list().length, 1)
    assert.equal(registry.list()[0]!.displayName, 'A Renamed')
  })

  test('accounts keep independent labels and ids', async (t) => {
    const dir = await makeTempDir('ms-multi')
    t.after(() => cleanup(dir))
    const registry = await AccountRegistry.open(dir)
    const gta = await registry.upsert({ homeAccountId: 'h1', username: 'd@gta.example', displayName: 'GTA User', tenantId: 't1' })
    const titan = await registry.upsert({ homeAccountId: 'h2', username: 'd@titan.example', displayName: 'Titan User', tenantId: 't2' })

    await registry.setLabel(gta.id, 'GTA')
    await registry.setLabel(titan.id, 'Titan')

    assert.notEqual(gta.id, titan.id)
    assert.equal(registry.get(gta.id)!.label, 'GTA')
    assert.equal(registry.get(titan.id)!.label, 'Titan')
    assert.equal(registry.homeAccountId(titan.id), 'h2')
  })

  test('disconnecting removes only that account', async (t) => {
    const dir = await makeTempDir('ms-remove')
    t.after(() => cleanup(dir))
    const registry = await AccountRegistry.open(dir)
    const a = await registry.upsert({ homeAccountId: 'h1', username: 'a@x', displayName: 'A', tenantId: 't' })
    await registry.upsert({ homeAccountId: 'h2', username: 'b@x', displayName: 'B', tenantId: 't' })
    await registry.remove(a.id)
    assert.deepEqual(registry.list().map((x) => x.username), ['b@x'])
  })
})

describe('multi-account aggregation', () => {
  const gta = fakeAccount({ id: 'a1', label: 'GTA' })
  const titan = fakeAccount({ id: 'a2', label: 'Titan' })
  const icc = fakeAccount({ id: 'a3', label: 'ICC' })

  test('combines results from every account', async () => {
    const result = await forEachAccount([gta, titan], async (account) => [`${account.label}-item`])
    assert.deepEqual(result.items.sort(), ['GTA-item', 'Titan-item'])
    assert.deepEqual(result.checkedAccounts.sort(), ['GTA', 'Titan'])
    assert.deepEqual(result.failures, [])
  })

  test('one failing account does not lose the others, and is reported', async () => {
    const result = await forEachAccount([gta, titan, icc], async (account) => {
      if (account.label === 'Titan') throw new NeedsReauthError(account.id)
      return [`${account.label}-item`]
    })

    assert.equal(result.items.length, 2)
    assert.equal(result.failures.length, 1)
    assert.equal(result.failures[0]!.accountLabel, 'Titan')
    assert.equal(result.failures[0]!.kind, 'auth')
    assert.match(result.failures[0]!.reason, /renewed/i)
  })

  test('partial failure is described honestly, naming the coverage', async () => {
    const result = await forEachAccount([gta, titan, icc], async (account) => {
      if (account.label === 'Titan') throw new NeedsReauthError(account.id)
      return [1]
    })
    const coverage = describeCoverage(result, 3)
    assert.ok(coverage)
    assert.match(coverage!, /checked 2 of your 3 connected accounts/i)
    assert.match(coverage!, /Titan/)
  })

  test('nothing is said about coverage when everything was reachable', async () => {
    const result = await forEachAccount([gta, titan], async () => [1])
    assert.equal(describeCoverage(result, 2), null)
  })

  test('failure descriptions never leak internals', () => {
    const failure = describeFailure(gta, new Error('Bearer eyJ0eXAiOiJKV1Qi... at Object.<anonymous>'))
    assert.ok(!/Bearer|eyJ/.test(failure.reason))
    assert.match(failure.reason, /could not be reached/i)
  })

  test('a throttled account is classified as throttled, not as auth failure', async () => {
    const result = await forEachAccount([gta], async () => {
      throw new GraphError('throttled', 'Microsoft is rate limiting requests for this account.')
    })
    assert.equal(result.failures[0]!.kind, 'throttled')
  })
})

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

const reversible: Encryptor = {
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from([...Buffer.from(plain, 'utf8')].map((b) => b ^ 0x5a)),
  decrypt: (cipher) => Buffer.from([...cipher].map((b) => b ^ 0x5a)).toString('utf8')
}

const unavailable: Encryptor = {
  isAvailable: () => false,
  encrypt: () => { throw new Error('unavailable') },
  decrypt: () => { throw new Error('unavailable') }
}

describe('token cache', () => {
  test('round-trips the MSAL cache and never writes it in plain text', async (t) => {
    const dir = await makeTempDir('ms-tokens')
    t.after(() => cleanup(dir))
    const secrets = await SecretStore.open(dir, reversible)
    const cache = new EncryptedTokenCache(secrets)

    const serialised = JSON.stringify({ RefreshToken: { 'x': { secret: 'super-secret-refresh' } } })
    let stored = ''
    await cache.afterCacheAccess({
      cacheHasChanged: true,
      tokenCache: { serialize: () => serialised, deserialize: (s: string) => { stored = s } }
    } as never)

    const onDisk = await fs.readFile(path.join(dir, 'secrets.enc.json'), 'utf8')
    assert.ok(!onDisk.includes('super-secret-refresh'), 'refresh token must not be readable on disk')

    await cache.beforeCacheAccess({
      cacheHasChanged: false,
      tokenCache: { serialize: () => '', deserialize: (s: string) => { stored = s } }
    } as never)
    assert.equal(stored, serialised)
  })

  test('nothing is written when the cache is unchanged', async (t) => {
    const dir = await makeTempDir('ms-tokens-noop')
    t.after(() => cleanup(dir))
    const secrets = await SecretStore.open(dir, reversible)
    await new EncryptedTokenCache(secrets).afterCacheAccess({
      cacheHasChanged: false,
      tokenCache: { serialize: () => 'x', deserialize: () => undefined }
    } as never)
    assert.equal(secrets.has(TOKEN_CACHE_KEY), false)
  })

  test('refuses to persist tokens when the keychain is unavailable', async (t) => {
    const dir = await makeTempDir('ms-tokens-locked')
    t.after(() => cleanup(dir))
    const secrets = await SecretStore.open(dir, unavailable)
    await assert.rejects(
      () =>
        new EncryptedTokenCache(secrets).afterCacheAccess({
          cacheHasChanged: true,
          tokenCache: { serialize: () => 'tokens', deserialize: () => undefined }
        } as never),
      /OS-backed encryption/
    )
  })
})

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

describe('requested Graph permissions', () => {
  test('only least-privilege delegated scopes are requested', () => {
    assert.deepEqual(REQUESTED_SCOPES, [
      'openid',
      'profile',
      'offline_access',
      'User.Read',
      'Mail.Read',
      'Calendars.ReadWrite',
      'Mail.Send'
    ].sort((a, b) => REQUESTED_SCOPES.indexOf(a) - REQUESTED_SCOPES.indexOf(b)))
  })

  test('no application-wide or admin-only scope is requested', () => {
    for (const scope of REQUESTED_SCOPES) {
      assert.ok(!/\.All$/.test(scope), `${scope} would be an organisation-wide permission`)
      assert.ok(!/ReadWrite\.Shared|Mail\.ReadWrite$/.test(scope), `${scope} is broader than needed`)
    }
    assert.ok(GRAPH_SCOPES.every((s) => !s.requiresAdminConsent))
  })

  test('every scope carries a documented reason', () => {
    for (const entry of GRAPH_SCOPES) {
      assert.ok(entry.neededFor.length > 20, `${entry.scope} needs a real rationale`)
    }
  })

  test('reserved OIDC scopes are not sent on token requests', () => {
    for (const reserved of ['openid', 'profile', 'offline_access']) {
      assert.ok(!TOKEN_SCOPES.includes(reserved))
    }
    assert.ok(TOKEN_SCOPES.includes('Mail.Read'))
  })
})
