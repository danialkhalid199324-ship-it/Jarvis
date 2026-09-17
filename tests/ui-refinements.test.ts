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
import { heuristicPlan } from '../src/core/assistant/query-plan'
import { groupSources, formatLocators } from '../src/renderer/lib/sources'
import type { CompletionRequest } from '../src/core/ai/provider'
import type { SourceReference } from '../src/shared/types'
import { makeTempDir, cleanup, FakeProvider } from './helpers'

// ---------------------------------------------------------------------------
// Source grouping (presentation only — citation data is untouched)
// ---------------------------------------------------------------------------

describe('source grouping', () => {
  const ref = (id: string, name: string, locator?: string): SourceReference => {
    const s: SourceReference = { documentId: id, fileName: name, path: `/docs/${name}` }
    if (locator) s.locator = locator
    return s
  }

  test('collapses repeated entries for one document into a single row', () => {
    const grouped = groupSources([
      ref('d1', 'GTA Plan.pdf', 'page 1'),
      ref('d1', 'GTA Plan.pdf', 'page 2'),
      ref('d1', 'GTA Plan.pdf', 'page 3')
    ])
    assert.equal(grouped.length, 1)
    assert.equal(grouped[0]!.fileName, 'GTA Plan.pdf')
    assert.deepEqual(grouped[0]!.locators, ['page 1', 'page 2', 'page 3'])
    // Nothing is discarded: the underlying citation count is preserved.
    assert.equal(grouped[0]!.citationCount, 3)
  })

  test('keeps separate documents separate, in first-cited order', () => {
    const grouped = groupSources([
      ref('d1', 'A.pdf', 'page 4'),
      ref('d2', 'B.docx', 'section 2'),
      ref('d1', 'A.pdf', 'page 5')
    ])
    assert.deepEqual(grouped.map((g) => g.fileName), ['A.pdf', 'B.docx'])
    assert.deepEqual(grouped[0]!.locators, ['page 4', 'page 5'])
  })

  test('deduplicates an identical locator cited twice', () => {
    const grouped = groupSources([ref('d1', 'A.pdf', 'page 2'), ref('d1', 'A.pdf', 'page 2')])
    assert.deepEqual(grouped[0]!.locators, ['page 2'])
    assert.equal(grouped[0]!.citationCount, 2)
  })

  test('handles sources with no locator', () => {
    const grouped = groupSources([ref('d1', 'A.txt'), ref('d1', 'A.txt')])
    assert.equal(grouped.length, 1)
    assert.deepEqual(grouped[0]!.locators, [])
  })

  test('empty in, empty out', () => {
    assert.deepEqual(groupSources([]), [])
  })
})

describe('locator formatting', () => {
  test('compresses a contiguous run of pages into a range', () => {
    assert.equal(formatLocators(['page 1', 'page 2', 'page 3']), 'pages 1–3')
  })

  test('keeps non-contiguous pages readable', () => {
    assert.equal(formatLocators(['page 1', 'page 2', 'page 7']), 'pages 1–2, 7')
    assert.equal(formatLocators(['page 4', 'page 9']), 'pages 4, 9')
  })

  test('sorts and deduplicates out-of-order pages', () => {
    assert.equal(formatLocators(['page 3', 'page 1', 'page 2', 'page 3']), 'pages 1–3')
  })

  test('a single locator is shown as-is', () => {
    assert.equal(formatLocators(['page 6']), 'page 6')
    assert.equal(formatLocators(['sheet: Invoices, rows 2–41']), 'sheet: Invoices, rows 2–41')
  })

  test('non-page locators are listed rather than ranged', () => {
    assert.equal(formatLocators(['section 1', 'section 2']), 'section 1, section 2')
    // Mixed kinds must not be misread as pages.
    assert.equal(formatLocators(['page 1', 'section 2']), 'page 1, section 2')
  })

  test('nothing to show', () => {
    assert.equal(formatLocators([]), '')
  })
})

// ---------------------------------------------------------------------------
// "Ask about this" document selection
// ---------------------------------------------------------------------------

function planningResponder(answer: string) {
  return (request: CompletionRequest): string => {
    if (request.jsonSchemaHint) {
      const question = (request.messages[0]?.content ?? '').replace(/^Question:\s*/, '')
      const plan = heuristicPlan(question)
      return JSON.stringify({
        intent: plan.intent,
        search_terms: plan.terms,
        phrases: plan.phrases,
        file_types: plan.fileTypes,
        prefer_recent: plan.preferRecent,
        refers_to_previous: plan.refersToContext
      })
    }
    return answer
  }
}

async function harness(t: { after: (fn: () => unknown) => void }) {
  const archive = await makeTempDir('select-archive')
  const dataDir = await makeTempDir('select-data')
  t.after(() => cleanup(archive))
  t.after(() => cleanup(dataDir))

  await fs.writeFile(
    path.join(archive, 'GTA Operational Plan 2026.txt'),
    'GTA Operational Plan 2026. Compliance audit outstanding. Insurance renewal due in June.',
    'utf8'
  )
  await fs.writeFile(
    path.join(archive, 'GTA Operational Plan 2024.txt'),
    'GTA Operational Plan 2024. Compliance audit completed. Superseded edition.',
    'utf8'
  )
  await fs.writeFile(
    path.join(archive, 'Titan Security Agreement.txt'),
    'Titan Security Agreement. Compliance with the Security Providers Act is required.',
    'utf8'
  )

  const store = await DocumentStore.open(dataDir)
  const logger = new Logger(path.join(dataDir, 'logs'))
  const indexer = new Indexer(store, new SearchIndex(), logger)
  await indexer.run({
    folders: [{ id: 'f1', path: archive, label: 'Business', addedAt: new Date().toISOString() }],
    maxFileSizeBytes: 40 * 1024 * 1024
  })

  const provider = new FakeProvider(planningResponder('Answer grounded in the excerpts [1].'))
  const session = new Session()
  const assistant = new Assistant({
    store,
    index: indexer.searchIndex,
    providers: new ProviderRegistry([provider], 'fake', 'fake-model'),
    logger,
    session,
    maxContextChars: () => 60_000
  })

  const idOf = (fileName: string): string =>
    store.allDocuments().find((d) => d.fileName === fileName)!.id

  return { assistant, session, provider, store, idOf }
}

describe('"Ask about this" document selection', () => {
  test('multi-result search is unchanged — several candidates still come back', async (t) => {
    const { assistant } = await harness(t)
    const reply = await assistant.ask('Find GTA operational plan')
    assert.equal(reply.kind, 'results')
    assert.ok(reply.results.length >= 2, `expected multiple candidates, got ${reply.results.length}`)
  })

  test('a selected document scopes a question that names no subject', async (t) => {
    const { assistant, session, provider, idOf } = await harness(t)

    // "compliance" appears in all three documents. Without a selection the
    // question would search the whole archive.
    session.pin([idOf('Titan Security Agreement.txt')])
    const reply = await assistant.ask('What does it say about compliance?')

    assert.equal(reply.kind, 'answer')
    assert.deepEqual(
      [...new Set(reply.sources.map((s) => s.fileName))],
      ['Titan Security Agreement.txt']
    )

    const sent = provider.calls.filter((c) => !c.request.jsonSchemaHint).pop()!
    assert.ok(sent.request.messages[0]!.content.includes('Titan Security Agreement.txt'))
    assert.ok(!sent.request.messages[0]!.content.includes('GTA Operational Plan'))
  })

  test('selection holds even when the question has no pronoun at all', async (t) => {
    const { assistant, session, idOf } = await harness(t)
    session.pin([idOf('GTA Operational Plan 2024.txt')])

    // No "it"/"this" for the planner's pronoun heuristic to catch.
    const reply = await assistant.ask('Summarise the compliance position')
    assert.equal(reply.kind, 'answer')
    assert.deepEqual(
      [...new Set(reply.sources.map((s) => s.fileName))],
      ['GTA Operational Plan 2024.txt']
    )
  })

  test('clearing the selection restores archive-wide search', async (t) => {
    const { assistant, session, idOf } = await harness(t)
    session.pin([idOf('Titan Security Agreement.txt')])
    session.pin([])
    assert.deepEqual(session.pinnedDocuments(), [])

    const reply = await assistant.ask('Which documents mention compliance?')
    const names = new Set(reply.results.map((r) => r.document.fileName))
    assert.ok(names.size > 1, 'search should span the archive again')
  })

  test('changing the selection switches which document is discussed', async (t) => {
    const { assistant, session, idOf } = await harness(t)

    session.pin([idOf('Titan Security Agreement.txt')])
    let reply = await assistant.ask('Summarise the compliance position')
    assert.equal(reply.sources[0]!.fileName, 'Titan Security Agreement.txt')

    session.pin([idOf('GTA Operational Plan 2026.txt')])
    reply = await assistant.ask('Summarise the compliance position')
    assert.equal(reply.sources[0]!.fileName, 'GTA Operational Plan 2026.txt')
  })

  test('an explicit new search is not hijacked by the selection', async (t) => {
    const { assistant, session, idOf } = await harness(t)
    session.pin([idOf('Titan Security Agreement.txt')])

    // "find" means the user is looking for something else entirely.
    const reply = await assistant.ask('Find the GTA operational plans')
    assert.equal(reply.kind, 'results')
    assert.ok(
      reply.results.some((r) => r.document.fileName.startsWith('GTA')),
      'a find should still reach the whole archive'
    )
  })

  test('with nothing selected, existing conversational context is untouched', async (t) => {
    const { assistant, session } = await harness(t)
    assert.deepEqual(session.pinnedDocuments(), [])

    await assistant.ask('Find the latest GTA operational plan')
    const reply = await assistant.ask('Summarise it')

    assert.equal(reply.kind, 'answer')
    assert.ok(reply.sources[0]!.fileName.startsWith('GTA Operational Plan'))
  })

  test('clearing the conversation also clears the selection', async (t) => {
    const { session, idOf } = await harness(t)
    session.pin([idOf('Titan Security Agreement.txt')])
    session.clear()
    assert.deepEqual(session.pinnedDocuments(), [])
  })

  test('selection never widens what is sent to the provider', async (t) => {
    const { assistant, session, provider, idOf } = await harness(t)
    session.pin([idOf('GTA Operational Plan 2026.txt')])
    await assistant.ask('Summarise the compliance position')

    const sent = provider.calls.filter((c) => !c.request.jsonSchemaHint).pop()!
    const body = sent.request.messages[0]!.content
    assert.ok(body.includes('GTA Operational Plan 2026.txt'))
    assert.ok(!body.includes('Titan Security Agreement.txt'))
    assert.ok(!body.includes('GTA Operational Plan 2024.txt'))
  })
})
