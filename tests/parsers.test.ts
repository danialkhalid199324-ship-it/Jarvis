import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseCsv } from '../src/core/parsers/csv'
import { parseDocument, detectFileType } from '../src/core/parsers'
import { makeTempDir, cleanup, makePdfBuffer } from './helpers'

describe('file type detection', () => {
  test('maps the supported extensions and rejects the rest', () => {
    assert.equal(detectFileType('/x/Plan.PDF'), 'pdf')
    assert.equal(detectFileType('/x/report.docx'), 'docx')
    assert.equal(detectFileType('/x/notes.md'), 'md')
    assert.equal(detectFileType('/x/data.xlsx'), 'xlsx')
    assert.equal(detectFileType('/x/list.csv'), 'csv')
    assert.equal(detectFileType('/x/photo.jpg'), null)
    assert.equal(detectFileType('/x/old.doc'), null)
  })
})

describe('CSV reader', () => {
  test('handles quotes, embedded commas, escaped quotes and newlines', () => {
    const rows = parseCsv('a,b\n"x,1","he said ""hi"""\n"multi\nline",2')
    assert.deepEqual(rows, [
      ['a', 'b'],
      ['x,1', 'he said "hi"'],
      ['multi\nline', '2']
    ])
  })

  test('drops blank rows', () => {
    assert.deepEqual(parseCsv('a,b\n\n,\nc,d'), [
      ['a', 'b'],
      ['c', 'd']
    ])
  })
})

describe('parsers', () => {
  test('plain text', async (t) => {
    const dir = await makeTempDir('txt')
    t.after(() => cleanup(dir))
    const file = path.join(dir, 'note.txt')
    await fs.writeFile(file, 'Titan Security roster for March.', 'utf8')
    const parsed = await parseDocument(file, 'txt')
    assert.equal(parsed.segments.length, 1)
    assert.match(parsed.segments[0]!.text, /Titan Security/)
  })

  test('CSV keeps values labelled by their header and cites the row range', async (t) => {
    const dir = await makeTempDir('csv')
    t.after(() => cleanup(dir))
    const file = path.join(dir, 'invoices.csv')
    await fs.writeFile(file, 'Invoice No,Supplier,Amount\n1042,Titan Security,4800\n1043,LRD,220', 'utf8')
    const parsed = await parseDocument(file, 'csv')
    const text = parsed.segments.map((s) => s.text).join('\n')
    assert.match(text, /Invoice No: 1042/)
    assert.match(text, /Supplier: Titan Security/)
    assert.match(parsed.segments[0]!.locator ?? '', /rows? 2/)
  })

  test('PDF extracts text with a per-page locator', async (t) => {
    const dir = await makeTempDir('pdf')
    t.after(() => cleanup(dir))
    const file = path.join(dir, 'plan.pdf')
    await fs.writeFile(file, makePdfBuffer(['GTA Operational Plan 2026', 'Compliance review outstanding.']))
    const parsed = await parseDocument(file, 'pdf')
    assert.equal(parsed.segments[0]!.locator, 'page 1')
    assert.match(parsed.segments[0]!.text, /GTA Operational Plan 2026/)
    assert.match(parsed.segments[0]!.text, /Compliance review outstanding/)
  })

  test('an empty text file is reported, not silently indexed', async (t) => {
    const dir = await makeTempDir('empty')
    t.after(() => cleanup(dir))
    const file = path.join(dir, 'blank.txt')
    await fs.writeFile(file, '   \n  ', 'utf8')
    const parsed = await parseDocument(file, 'txt')
    assert.equal(parsed.segments.length, 0)
    assert.ok(parsed.warning)
  })

  test('parsers never modify the file they read', async (t) => {
    const dir = await makeTempDir('readonly')
    t.after(() => cleanup(dir))
    const file = path.join(dir, 'plan.pdf')
    await fs.writeFile(file, makePdfBuffer(['Do not touch this file.']))
    const before = await fs.stat(file)
    const hashBefore = await fs.readFile(file)
    await parseDocument(file, 'pdf')
    const after = await fs.stat(file)
    assert.equal(after.size, before.size)
    assert.deepEqual(await fs.readFile(file), hashBefore)
  })
})
