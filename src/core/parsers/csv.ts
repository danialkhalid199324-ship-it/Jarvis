import fs from 'node:fs/promises'
import type { DocumentParser, ParsedDocument, TextSegment } from './types'
import type { SupportedFileType } from '../../shared/types'

/** Rows per text segment. Keeps segments searchable without losing row context. */
const ROWS_PER_SEGMENT = 40

/**
 * RFC 4180 CSV reader: handles quoted fields, embedded commas, escaped quotes
 * ("") and embedded newlines. Written by hand so Jarvis has no parser
 * dependency for what is a genuinely simple format.
 */
export function parseCsv(input: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  const text = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  while (i < text.length) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"' && field === '') {
      inQuotes = true
      i++
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
      continue
    }
    field += ch
    i++
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

/** Pick the delimiter that yields the most consistent column count. */
function detectDelimiter(sample: string): string {
  const candidates = [',', ';', '\t', '|']
  let best = ','
  let bestScore = -1
  for (const d of candidates) {
    const rows = parseCsv(sample, d).slice(0, 10)
    if (rows.length < 2) continue
    const widths = rows.map((r) => r.length)
    const max = Math.max(...widths)
    if (max < 2) continue
    const consistent = widths.filter((w) => w === max).length
    const score = max * consistent
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return best
}

export class CsvParser implements DocumentParser {
  readonly fileType: SupportedFileType = 'csv'

  async parse(filePath: string): Promise<ParsedDocument> {
    const raw = await fs.readFile(filePath, 'utf8')
    const delimiter = detectDelimiter(raw.slice(0, 8192))
    const rows = parseCsv(raw, delimiter)
    if (rows.length === 0) return { segments: [], charCount: 0, warning: 'The file is empty.' }

    const header = rows[0]!.map((h) => h.trim())
    const bodyRows = rows.slice(1)
    const segments: TextSegment[] = []

    // With no data rows the header alone is still worth indexing — it tells
    // Jarvis what the file is about.
    if (bodyRows.length === 0) {
      const text = header.join(' | ')
      return { segments: [{ text, locator: 'header row' }], charCount: text.length }
    }

    for (let start = 0; start < bodyRows.length; start += ROWS_PER_SEGMENT) {
      const slice = bodyRows.slice(start, start + ROWS_PER_SEGMENT)
      const lines = slice.map((cells) =>
        cells
          .map((cell, idx) => {
            const label = header[idx]?.trim()
            const value = cell.trim()
            if (!value) return ''
            return label ? `${label}: ${value}` : value
          })
          .filter(Boolean)
          .join(' | ')
      )
      const text = lines.filter(Boolean).join('\n')
      if (!text) continue
      const firstRow = start + 2 // 1-based, accounting for the header row
      const lastRow = start + slice.length + 1
      segments.push({
        text,
        locator: firstRow === lastRow ? `row ${firstRow}` : `rows ${firstRow}–${lastRow}`
      })
    }

    return {
      segments,
      charCount: segments.reduce((n, s) => n + s.text.length, 0)
    }
  }
}
