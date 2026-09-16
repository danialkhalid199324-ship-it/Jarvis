import type { DocumentParser, ParsedDocument, TextSegment } from './types'
import type { SupportedFileType } from '../../shared/types'

const ROWS_PER_SEGMENT = 40

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    // ExcelJS models formulas, hyperlinks and rich text as objects.
    if (typeof obj.result === 'string' || typeof obj.result === 'number') return String(obj.result)
    if (typeof obj.text === 'string') return obj.text
    if (Array.isArray(obj.richText)) {
      return (obj.richText as Array<{ text?: string }>).map((r) => r.text ?? '').join('')
    }
    if (typeof obj.hyperlink === 'string') return obj.hyperlink
    return ''
  }
  return String(value)
}

/**
 * Spreadsheets. Each sheet is read row by row, with the first non-empty row
 * treated as headers so values stay labelled ("Invoice No: 1042"), which is
 * what makes a spreadsheet searchable in natural language.
 */
export class XlsxParser implements DocumentParser {
  readonly fileType: SupportedFileType = 'xlsx'

  async parse(filePath: string): Promise<ParsedDocument> {
    const ExcelJS = (await import('exceljs')).default
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)

    const segments: TextSegment[] = []
    let charCount = 0

    workbook.eachSheet((sheet) => {
      const rows: string[][] = []
      sheet.eachRow({ includeEmpty: false }, (row) => {
        const values = Array.isArray(row.values) ? row.values.slice(1) : []
        const cells = values.map(cellToText)
        if (cells.some((c) => c.trim() !== '')) rows.push(cells)
      })
      if (rows.length === 0) return

      const header = rows[0]!.map((h) => h.trim())
      const body = rows.slice(1)
      const sheetName = sheet.name || `Sheet ${sheet.id}`

      if (body.length === 0) {
        const text = `${sheetName}\n${header.join(' | ')}`
        segments.push({ text, locator: `sheet: ${sheetName}` })
        charCount += text.length
        return
      }

      for (let start = 0; start < body.length; start += ROWS_PER_SEGMENT) {
        const slice = body.slice(start, start + ROWS_PER_SEGMENT)
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
        const text = [sheetName, ...lines.filter(Boolean)].join('\n')
        if (lines.every((l) => !l)) continue
        const firstRow = start + 2
        const lastRow = start + slice.length + 1
        segments.push({
          text,
          locator:
            firstRow === lastRow
              ? `sheet: ${sheetName}, row ${firstRow}`
              : `sheet: ${sheetName}, rows ${firstRow}–${lastRow}`
        })
        charCount += text.length
      }
    })

    if (segments.length === 0) {
      return { segments: [], charCount: 0, warning: 'The workbook contains no readable cells.' }
    }
    return { segments, charCount }
  }
}
