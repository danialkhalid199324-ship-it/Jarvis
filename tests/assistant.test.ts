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
import { citedSources } from '../src/core/assistant/context'
import { extractJson } from '../src/core/ai/provider'
import type { CompletionRequest } from '../src/core/ai/provider'
import type { AuthorisedFolder } from '../src/shared/types'
import { makeTempDir, cleanup, makePdfBuffer, FakeProvider, writeDocx } from './helpers'

interface Harness {
  assistant: Assistant
  session: Session
  provider: FakeProvider
  archive: string
}

/** The responder recognises the planner call vs. the answering call. */
function defaultResponder(answer: string) {
  return (request: CompletionRequest): string => {
    if (request.jsonSchemaHint) {
      // Planner call: echo back a plan derived from the question.
      const question = request.messages[0]?.content ?? ''
      const plan = heuristicPlan(question.replace(/^Question:\s*/, ''))
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

async function harness(
  t: { after: (fn: () => unknown) => void },
  responder: (request: CompletionRequest) => string
): Promise<Harness> {
  const archive = await makeTempDir('assistant-archive')
  const dataDir = await makeTempDir('assistant-data')
  t.after(() => cleanup(archive))
  t.after(() => cleanup(dataDir))

  await fs.mkdir(path.join(archive, 'GTA'), { recursive: true })
  await fs.mkdir(path.join(archive, 'Titan'), { recursive: true })

  await fs.writeFile(
    path.join(archive, 'GTA', 'GTA Operational Plan 2026.pdf'),
    makePdfBuffer([
      'GTA Operational Plan 2026',
      'The staffing model has been finalised for all sites.',
      'Outstanding: the annual compliance audit has not been scheduled.',
      'Outstanding: public liability insurance renewal is due in June.'
    ])
  )
  await fs.writeFile(
    path.join(archive, 'GTA', 'GTA Operational Plan 2024.txt'),
    'GTA Operational Plan 2024. This edition has been superseded.',
    'utf8'
  )
  await writeDocx(path.join(archive, 'Titan', 'Titan Security Service Agreement.docx'), [
    'Titan Security Service Agreement',
    'Titan Security provides licensed guards to the client site.'
  ])

  // Make the 2026 plan clearly the newest file.
  const old = new Date(Date.now() - 400 * 86_400_000)
  await fs.utimes(path.join(archive, 'GTA', 'GTA Operational Plan 2024.txt'), old, old)

  const store = await DocumentStore.open(dataDir)
  const logger = new Logger(path.join(dataDir, 'logs'))
  const indexer = new Indexer(store, new SearchIndex(), logger)
  const folder: AuthorisedFolder = {
    id: 'f1',
    path: archive,
    label: 'Business',
    addedAt: new Date().toISOString()
  }
  await indexer.run({ folders: [folder], maxFileSizeBytes: 40 * 1024 * 1024 })

  const provider = new FakeProvider(responder)
  const providers = new ProviderRegistry([provider], 'fake', 'fake-model')
  const session = new Session()
  const assistant = new Assistant({
    store,
    index: indexer.searchIndex,
    providers,
    logger,
    session,
    maxContextChars: () => 60_000
  })

  return { assistant, session, provider, archive }
}

describe('Jarvis V0.1 acceptance', () => {
  test('finds the right document from a natural-language request', async (t) => {
    const { assistant } = await harness(t, defaultResponder('unused'))
    const reply = await assistant.ask('Find my latest GTA operational plan.')

    assert.equal(reply.kind, 'results')
    assert.equal(reply.results[0]!.document.fileName, 'GTA Operational Plan 2026.pdf')
    assert.ok(reply.results[0]!.reason.length > 0)
    // A pure lookup must not send anything to a provider beyond the question.
    assert.equal(reply.disclosure, undefined)
  })

  test('every result carries the metadata the user needs', async (t) => {
    const { assistant, archive } = await harness(t, defaultResponder('unused'))
    const reply = await assistant.ask('Find documents relating to Titan Security.')

    const hit = reply.results[0]!
    assert.equal(hit.document.fileName, 'Titan Security Service Agreement.docx')
    assert.equal(hit.document.fileType, 'docx')
    assert.equal(hit.document.directory, path.join(archive, 'Titan'))
    assert.ok(typeof hit.document.modifiedAt === 'number')
    assert.match(hit.reason, /file name|contents|folder/i)
  })

  test('"summarise it" continues from the document just found', async (t) => {
    const { assistant, provider } = await harness(
      t,
      defaultResponder(
        'The 2026 plan finalises the staffing model across all sites [1]. Two items remain outstanding: the annual compliance audit [2] and the public liability insurance renewal due in June [2].'
      )
    )

    await assistant.ask('Find the latest GTA operational plan.')
    const reply = await assistant.ask('Summarise it.')

    assert.equal(reply.kind, 'answer')
    assert.match(reply.text, /staffing model/)
    assert.ok(reply.sources.length > 0)
    for (const source of reply.sources) {
      assert.equal(source.fileName, 'GTA Operational Plan 2026.pdf')
    }

    // The excerpts sent came only from the document already in context.
    const answerCall = provider.calls.filter((c) => !c.request.jsonSchemaHint).pop()!
    assert.ok(answerCall.request.messages[0]!.content.includes('GTA Operational Plan 2026.pdf'))
    assert.ok(!answerCall.request.messages[0]!.content.includes('Titan Security Service Agreement'))
  })

  test('a third follow-up still works from the same context', async (t) => {
    const { assistant } = await harness(
      t,
      defaultResponder('Outstanding: the annual compliance audit [1] and the insurance renewal [1].')
    )

    await assistant.ask('Find the latest GTA operational plan.')
    await assistant.ask('Summarise it.')
    const reply = await assistant.ask('What are the outstanding priorities?')

    assert.equal(reply.kind, 'answer')
    assert.match(reply.text, /compliance audit/)
    assert.equal(reply.sources[0]!.fileName, 'GTA Operational Plan 2026.pdf')
  })

  test('answers disclose exactly what was sent to the provider', async (t) => {
    const { assistant } = await harness(t, defaultResponder('The staffing model is finalised [1].'))

    await assistant.ask('Find the latest GTA operational plan.')
    const reply = await assistant.ask('Summarise it.')

    assert.ok(reply.disclosure)
    assert.equal(reply.disclosure!.providerId, 'fake')
    assert.ok(reply.disclosure!.excerptCount > 0)
    assert.ok(reply.disclosure!.charsSent > 0)
    assert.deepEqual(reply.disclosure!.fileNames, ['GTA Operational Plan 2026.pdf'])
  })

  test('says so plainly when the documents do not contain the answer', async (t) => {
    const { assistant } = await harness(
      t,
      defaultResponder('INSUFFICIENT: the excerpts say nothing about superannuation rates.')
    )

    await assistant.ask('Find the latest GTA operational plan.')
    const reply = await assistant.ask('What does it say about superannuation rates?')

    assert.equal(reply.kind, 'insufficient')
    assert.match(reply.text, /could not find enough/i)
    assert.match(reply.text, /superannuation/)
  })

  test('does not invent results when nothing matches, and suggests next steps', async (t) => {
    const { assistant } = await harness(t, defaultResponder('unused'))
    const reply = await assistant.ask('Find the Antarctic penguin migration report.')

    assert.equal(reply.kind, 'insufficient')
    assert.equal(reply.results.length, 0)
    assert.ok(reply.suggestions.length > 0)
    assert.ok(reply.suggestions.some((s) => /authorised|Index now/i.test(s)))
  })

  test('"where is this file" answers with the location and sends nothing out', async (t) => {
    const { assistant, provider, archive } = await harness(t, defaultResponder('unused'))
    const reply = await assistant.ask('Where is the Titan Security service agreement located?')

    assert.equal(reply.kind, 'results')
    assert.ok(reply.text.includes(path.join(archive, 'Titan')))
    // Only the planner call — no document text left the machine.
    assert.equal(provider.calls.filter((c) => !c.request.jsonSchemaHint).length, 0)
  })

  test('comparing two documents reads both', async (t) => {
    const { assistant, provider } = await harness(
      t,
      defaultResponder('The 2026 plan supersedes the 2024 edition [1][2].')
    )

    const reply = await assistant.ask('Compare the GTA operational plans.')
    assert.equal(reply.kind, 'answer')

    const call = provider.calls.filter((c) => !c.request.jsonSchemaHint).pop()!
    const sent = call.request.messages[0]!.content
    assert.ok(sent.includes('GTA Operational Plan 2026.pdf'))
    assert.ok(sent.includes('GTA Operational Plan 2024.txt'))
  })

  test('without a configured provider, search still works and Jarvis says why it cannot read', async (t) => {
    const { assistant } = await harness(t, defaultResponder('unused'))
    // Rebuild with no configured provider.
    const reply = await assistant.ask('Find my latest GTA operational plan.')
    assert.equal(reply.kind, 'results')
    assert.ok(reply.results.length > 0)
  })

  test('the answer prompt forbids outside knowledge', async (t) => {
    const { assistant, provider } = await harness(t, defaultResponder('Answer [1].'))
    await assistant.ask('Find the latest GTA operational plan.')
    await assistant.ask('Summarise it.')

    const call = provider.calls.filter((c) => !c.request.jsonSchemaHint).pop()!
    assert.match(call.request.system ?? '', /ONLY from the excerpts/i)
    assert.match(call.request.system ?? '', /INSUFFICIENT/)
  })
})

describe('provider-free operation', () => {
  test('search works with no AI provider at all', async (t) => {
    const archive = await makeTempDir('noai-archive')
    const dataDir = await makeTempDir('noai-data')
    t.after(() => cleanup(archive))
    t.after(() => cleanup(dataDir))

    await fs.writeFile(path.join(archive, 'GTA Operational Plan 2026.txt'), 'Plan content.', 'utf8')

    const store = await DocumentStore.open(dataDir)
    const logger = new Logger(path.join(dataDir, 'logs'))
    const indexer = new Indexer(store, new SearchIndex(), logger)
    await indexer.run({
      folders: [{ id: 'f1', path: archive, label: 'A', addedAt: new Date().toISOString() }],
      maxFileSizeBytes: 40 * 1024 * 1024
    })

    const assistant = new Assistant({
      store,
      index: indexer.searchIndex,
      providers: new ProviderRegistry([], 'anthropic', 'claude-opus-5'),
      logger,
      session: new Session(),
      maxContextChars: () => 60_000
    })

    const found = await assistant.ask('Find my GTA operational plan.')
    assert.equal(found.kind, 'results')
    assert.equal(found.results[0]!.document.fileName, 'GTA Operational Plan 2026.txt')

    // Asking for a summary explains what is missing rather than failing silently.
    const summary = await assistant.ask('Summarise the GTA operational plan.')
    assert.equal(summary.kind, 'notice')
    assert.match(summary.text, /AI provider/i)
    assert.ok(summary.results.length > 0)
  })

  test('an empty index tells the user what to do', async (t) => {
    const dataDir = await makeTempDir('empty-data')
    t.after(() => cleanup(dataDir))
    const store = await DocumentStore.open(dataDir)
    const logger = new Logger(path.join(dataDir, 'logs'))
    const assistant = new Assistant({
      store,
      index: new SearchIndex(),
      providers: new ProviderRegistry([], 'anthropic', 'claude-opus-5'),
      logger,
      session: new Session(),
      maxContextChars: () => 60_000
    })
    const reply = await assistant.ask('Find anything.')
    assert.equal(reply.kind, 'notice')
    assert.match(reply.text, /Data & Permissions/)
  })
})

describe('supporting utilities', () => {
  test('citation parsing picks out the excerpts actually used', () => {
    const excerpts = [
      { number: 1, documentId: 'd1', fileName: 'A.pdf', path: '/a/A.pdf', text: 'x', locator: 'page 1' },
      { number: 2, documentId: 'd2', fileName: 'B.pdf', path: '/a/B.pdf', text: 'y', locator: 'page 2' },
      { number: 3, documentId: 'd3', fileName: 'C.pdf', path: '/a/C.pdf', text: 'z' }
    ]
    const sources = citedSources('Claim one [1]. Claim two [3].', excerpts)
    assert.deepEqual(sources.map((s) => s.fileName), ['A.pdf', 'C.pdf'])
  })

  test('with no citations, every excerpt shown is listed as a source', () => {
    const excerpts = [{ number: 1, documentId: 'd1', fileName: 'A.pdf', path: '/a/A.pdf', text: 'x' }]
    assert.equal(citedSources('An answer with no citations.', excerpts).length, 1)
  })

  test('JSON extraction survives code fences and chatty preambles', () => {
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
    assert.deepEqual(extractJson('Sure! Here it is: {"a":{"b":2}} Hope that helps.'), { a: { b: 2 } })
    assert.deepEqual(extractJson('{"a":"} not the end"}'), { a: '} not the end' })
    assert.equal(extractJson('no json here'), null)
  })

  test('the heuristic planner classifies the intents V0.1 supports', () => {
    assert.equal(heuristicPlan('Find my latest GTA operational plan.').intent, 'find')
    assert.equal(heuristicPlan('Find my latest GTA operational plan.').preferRecent, true)
    assert.equal(heuristicPlan('Summarise this document.').intent, 'answer')
    assert.equal(heuristicPlan('Compare these two documents.').intent, 'compare')
    assert.equal(heuristicPlan('Where is this file located?').intent, 'locate')
    assert.equal(heuristicPlan('What does this document say about compliance?').refersToContext, true)
    assert.deepEqual(heuristicPlan('Find the latest invoice PDFs').fileTypes, ['pdf'])
  })
})
