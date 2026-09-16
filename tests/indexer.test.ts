import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DocumentStore } from '../src/core/storage/document-store'
import { SearchIndex } from '../src/core/index/search-index'
import { Indexer } from '../src/core/index/indexer'
import { Logger } from '../src/core/logging/logger'
import { SettingsStore } from '../src/core/settings/settings-store'
import type { AuthorisedFolder } from '../src/shared/types'
import { makeTempDir, cleanup, makePdfBuffer, writeDocx, writeXlsx } from './helpers'

async function buildArchive(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'GTA'), { recursive: true })
  await fs.mkdir(path.join(root, 'Titan'), { recursive: true })
  await fs.mkdir(path.join(root, '.hidden'), { recursive: true })
  await fs.mkdir(path.join(root, 'node_modules'), { recursive: true })

  await fs.writeFile(
    path.join(root, 'GTA', 'GTA Operational Plan 2026.pdf'),
    makePdfBuffer([
      'GTA Operational Plan 2026',
      'Staffing model finalised for all sites.',
      'Outstanding: annual compliance audit not yet scheduled.',
      'Outstanding: public liability insurance renewal due in June.'
    ])
  )
  await fs.writeFile(
    path.join(root, 'GTA', 'GTA Operational Plan 2024.txt'),
    'GTA Operational Plan 2024. Superseded by the 2026 edition.',
    'utf8'
  )
  await writeDocx(path.join(root, 'Titan', 'Titan Security Service Agreement.docx'), [
    'Titan Security Service Agreement',
    'Titan Security will provide licensed guards to the client site.',
    'Compliance with the Security Providers Act is a condition of this agreement.'
  ])
  await writeXlsx(path.join(root, 'Titan', 'Titan Invoices.xlsx'), 'Invoices', [
    ['Invoice No', 'Supplier', 'Amount'],
    [1042, 'Titan Security', 4800],
    [1043, 'LRD Consulting', 220]
  ])
  await fs.writeFile(path.join(root, 'LRD notes.md'), '# LRD\n\nLRD steering meeting notes.', 'utf8')

  // These must never be indexed.
  await fs.writeFile(path.join(root, '.hidden', 'secret.txt'), 'hidden', 'utf8')
  await fs.writeFile(path.join(root, 'node_modules', 'pkg.txt'), 'dependency', 'utf8')
  await fs.writeFile(path.join(root, 'photo.jpg'), 'not a document', 'utf8')
  await fs.writeFile(path.join(root, '~$draft.docx'), 'lock file', 'utf8')
}

async function setup(t: { after: (fn: () => unknown) => void }): Promise<{
  archive: string
  dataDir: string
  store: DocumentStore
  indexer: Indexer
  folders: AuthorisedFolder[]
}> {
  const archive = await makeTempDir('archive')
  const dataDir = await makeTempDir('data')
  t.after(() => cleanup(archive))
  t.after(() => cleanup(dataDir))

  await buildArchive(archive)

  const store = await DocumentStore.open(dataDir)
  const logger = new Logger(path.join(dataDir, 'logs'))
  const indexer = new Indexer(store, new SearchIndex(), logger)
  const settings = await SettingsStore.open(dataDir, 'Danial')
  const folder = await settings.addFolder(archive, 'Business')

  return { archive, dataDir, store, indexer, folders: [folder] }
}

describe('indexer', () => {
  test('indexes every supported type and skips what it should', async (t) => {
    const { indexer, store, folders } = await setup(t)
    const result = await indexer.run({ folders, maxFileSizeBytes: 40 * 1024 * 1024 })

    assert.equal(result.failed, 0)
    const names = store.allDocuments().map((d) => d.fileName).sort()
    assert.deepEqual(names, [
      'GTA Operational Plan 2024.txt',
      'GTA Operational Plan 2026.pdf',
      'LRD notes.md',
      'Titan Invoices.xlsx',
      'Titan Security Service Agreement.docx'
    ])
    // Hidden folders, node_modules, unsupported types and Office lock files.
    assert.ok(!names.some((n) => n.includes('secret') || n.includes('pkg') || n.includes('photo') || n.startsWith('~$')))
  })

  test('extracts real text from every format', async (t) => {
    const { indexer, store, folders } = await setup(t)
    await indexer.run({ folders, maxFileSizeBytes: 40 * 1024 * 1024 })

    for (const doc of store.allDocuments()) {
      assert.ok(doc.chunkCount > 0, `${doc.fileName} produced no chunks`)
      assert.equal(doc.extractionError, undefined, `${doc.fileName}: ${doc.extractionError}`)
    }

    const xlsx = store.allDocuments().find((d) => d.fileType === 'xlsx')!
    const chunks = await store.loadChunks(xlsx.id)
    assert.match(chunks.map((c) => c.text).join('\n'), /Supplier: Titan Security/)
  })

  test('re-indexing skips unchanged files and picks up new ones', async (t) => {
    const { archive, indexer, folders } = await setup(t)
    const first = await indexer.run({ folders, maxFileSizeBytes: 40 * 1024 * 1024 })
    assert.equal(first.processed, 5)
    assert.equal(first.skipped, 0)

    const second = await indexer.run({ folders, maxFileSizeBytes: 40 * 1024 * 1024 })
    assert.equal(second.processed, 0)
    assert.equal(second.skipped, 5)

    await fs.writeFile(path.join(archive, 'New plan.txt'), 'A brand new plan.', 'utf8')
    const third = await indexer.run({ folders, maxFileSizeBytes: 40 * 1024 * 1024 })
    assert.equal(third.processed, 1)
    assert.equal(third.skipped, 5)
  })

  test('a deleted file is dropped from the index', async (t) => {
    const { archive, indexer, store, folders } = await setup(t)
    await indexer.run({ folders, maxFileSizeBytes: 40 * 1024 * 1024 })
    await fs.rm(path.join(archive, 'LRD notes.md'))

    const result = await indexer.run({ folders, maxFileSizeBytes: 40 * 1024 * 1024 })
    assert.equal(result.removed, 1)
    assert.ok(!store.allDocuments().some((d) => d.fileName === 'LRD notes.md'))
    // "LRD" still matches the invoices spreadsheet; what must be gone is the
    // deleted document itself.
    const hitIds = indexer.searchIndex.searchText('LRD steering meeting').map((h) => h.id)
    assert.ok(!hitIds.some((id) => store.getDocument(id) === undefined))
    assert.equal(
      indexer.searchIndex.searchText('LRD steering meeting').filter((h) => {
        const doc = store.getDocument(h.id)
        return doc?.fileName === 'LRD notes.md'
      }).length,
      0
    )
  })

  test('indexing never modifies the source files', async (t) => {
    const { archive, indexer, folders } = await setup(t)
    const snapshot = async (): Promise<string[]> => {
      const out: string[] = []
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) await walk(full)
          else {
            const stat = await fs.stat(full)
            out.push(`${full}:${stat.size}:${stat.mtimeMs}`)
          }
        }
      }
      await walk(archive)
      return out.sort()
    }

    const before = await snapshot()
    await indexer.run({ folders, maxFileSizeBytes: 40 * 1024 * 1024 })
    assert.deepEqual(await snapshot(), before)
  })

  test('clearing the index leaves the original files alone', async (t) => {
    const { archive, indexer, store, folders } = await setup(t)
    await indexer.run({ folders, maxFileSizeBytes: 40 * 1024 * 1024 })
    assert.ok((await store.stats()).documentCount > 0)

    await indexer.clear()
    assert.equal((await store.stats()).documentCount, 0)
    assert.equal(indexer.searchIndex.searchText('GTA operational plan').length, 0)

    // The archive is untouched.
    const files = await fs.readdir(path.join(archive, 'GTA'))
    assert.ok(files.includes('GTA Operational Plan 2026.pdf'))
  })

  test('the index can be rebuilt from the chunk store alone', async (t) => {
    const { indexer, store, folders } = await setup(t)
    await indexer.run({ folders, maxFileSizeBytes: 40 * 1024 * 1024 })

    const rebuilt = await Indexer.rebuildIndex(store)
    assert.equal(rebuilt.documentCount, 5)
    assert.equal(
      rebuilt.searchText('GTA operational plan')[0]!.id,
      indexer.searchIndex.searchText('GTA operational plan')[0]!.id
    )
  })

  test('reports progress while running', async (t) => {
    const { indexer, folders } = await setup(t)
    const phases: string[] = []
    await indexer.run({
      folders,
      maxFileSizeBytes: 40 * 1024 * 1024,
      onStatus: (status) => {
        if (phases[phases.length - 1] !== status.phase) phases.push(status.phase)
      }
    })
    assert.ok(phases.includes('scanning'))
    assert.ok(phases.includes('extracting'))
    assert.ok(phases.includes('writing'))
    assert.equal(phases[phases.length - 1], 'idle')
  })
})
