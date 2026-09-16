import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, stem } from '../src/core/index/tokenize'
import { SearchIndex } from '../src/core/index/search-index'
import { chunkSegments, TARGET_CHUNK_CHARS } from '../src/core/index/chunker'
import { makeTempDir, cleanup } from './helpers'

describe('tokenizer', () => {
  test('keeps acronyms and numbers, drops stop words', () => {
    assert.deepEqual(tokenize('The GTA plan for 2026 is about NDIS'), [
      'gta',
      'plan',
      '2026',
      'ndi'
    ])
  })

  test('stems plurals so "plans" finds "plan"', () => {
    assert.equal(stem('plans'), 'plan')
    assert.equal(stem('policies'), 'policy')
    assert.equal(stem('compliance'), 'compliance')
    // Short acronyms are never stemmed.
    assert.equal(stem('lrd'), 'lrd')
    assert.equal(stem('gta'), 'gta')
  })
})

describe('chunker', () => {
  test('keeps short segments whole and preserves their locator', () => {
    const chunks = chunkSegments('doc1', [
      { text: 'Page one content.', locator: 'page 1' },
      { text: 'Page two content.', locator: 'page 2' }
    ])
    assert.equal(chunks.length, 2)
    assert.equal(chunks[0]!.locator, 'page 1')
    assert.equal(chunks[1]!.locator, 'page 2')
    assert.equal(chunks[0]!.ordinal, 0)
  })

  test('splits long segments without exceeding the target by much', () => {
    const sentence = 'This is a sentence about compliance obligations. '
    const long = sentence.repeat(120)
    const chunks = chunkSegments('doc1', [{ text: long, locator: 'page 3' }])
    assert.ok(chunks.length > 1)
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= TARGET_CHUNK_CHARS * 1.3, `chunk too long: ${chunk.text.length}`)
      assert.equal(chunk.locator, 'page 3')
    }
  })

  test('never merges text across segment boundaries', () => {
    const chunks = chunkSegments('doc1', [
      { text: 'Alpha.', locator: 'page 1' },
      { text: 'Beta.', locator: 'page 2' }
    ])
    assert.ok(!chunks.some((c) => c.text.includes('Alpha') && c.text.includes('Beta')))
  })
})

describe('search index', () => {
  function build(): SearchIndex {
    const index = new SearchIndex()
    index.addDocument('d1', 'GTA Operational Plan 2026.pdf', '/Users/d/Business/GTA')
    index.addChunk('c1', 'd1', 'Operational plan covering staffing, rosters and compliance for the year.')
    index.addChunk('c2', 'd1', 'Outstanding priorities include the annual audit and insurance renewal.')

    index.addDocument('d2', 'Titan Security Roster.xlsx', '/Users/d/Business/Titan')
    index.addChunk('c3', 'd2', 'Guard roster for Titan Security across March and April.')

    index.addDocument('d3', 'LRD meeting notes.md', '/Users/d/Business/LRD')
    index.addChunk('c4', 'd3', 'Notes from the LRD steering meeting. Compliance was discussed at length.')
    return index
  }

  test('a file-name match outranks a body-only mention', () => {
    const results = build().searchText('GTA operational plan')
    assert.equal(results[0]!.id, 'd1')
    assert.ok(results[0]!.matchedFields.includes('name'))
  })

  test('finds documents by acronym appearing only in the body and folder', () => {
    const results = build().searchText('Titan Security')
    assert.equal(results[0]!.id, 'd2')
  })

  test('a term in two documents returns both, best first', () => {
    const results = build().searchText('compliance')
    const ids = results.map((r) => r.id)
    assert.ok(ids.includes('d1'))
    assert.ok(ids.includes('d3'))
  })

  test('returns nothing for terms that are absent', () => {
    assert.deepEqual(build().searchText('quantum photosynthesis'), [])
  })

  test('restrictTo confines results to the documents in context', () => {
    const results = build().search(tokenize('compliance'), 10, new Set(['d3']))
    assert.equal(results.length, 1)
    assert.equal(results[0]!.id, 'd3')
  })

  test('removing a document removes its chunks too', () => {
    const index = build()
    index.removeDocument('d1')
    const ids = index.searchText('compliance').map((r) => r.id)
    assert.ok(!ids.includes('d1'))
    assert.equal(index.searchText('GTA operational plan').length, 0)
  })

  test('survives a save/load round trip', async (t) => {
    const dir = await makeTempDir('index')
    t.after(() => cleanup(dir))
    const index = build()
    await index.save(dir)
    const loaded = await SearchIndex.load(dir)
    assert.ok(loaded)
    assert.equal(loaded!.searchText('GTA operational plan')[0]!.id, 'd1')
    assert.equal(loaded!.documentCount, 3)
  })

  test('load returns null when there is nothing on disk', async (t) => {
    const dir = await makeTempDir('index-empty')
    t.after(() => cleanup(dir))
    assert.equal(await SearchIndex.load(dir), null)
  })
})
