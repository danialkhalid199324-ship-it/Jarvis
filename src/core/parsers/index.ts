import path from 'node:path'
import { PlainTextParser } from './text'
import { CsvParser } from './csv'
import { PdfParser } from './pdf'
import { DocxParser } from './docx'
import { XlsxParser } from './xlsx'
import { typeForExtension, type DocumentParser, type ParsedDocument } from './types'
import type { SupportedFileType } from '../../shared/types'

export * from './types'
export { parseCsv } from './csv'

const PARSERS: Record<SupportedFileType, DocumentParser> = {
  txt: new PlainTextParser('txt'),
  md: new PlainTextParser('md'),
  csv: new CsvParser(),
  pdf: new PdfParser(),
  docx: new DocxParser(),
  xlsx: new XlsxParser()
}

export function parserFor(fileType: SupportedFileType): DocumentParser {
  return PARSERS[fileType]
}

/** @returns null when Jarvis has no parser for this file's extension. */
export function detectFileType(filePath: string): SupportedFileType | null {
  return typeForExtension(path.extname(filePath))
}

/**
 * Extract text from a supported file. Read-only: no parser in Jarvis opens a
 * file for writing, and none of them modify, move or rename anything.
 */
export async function parseDocument(
  filePath: string,
  fileType: SupportedFileType
): Promise<ParsedDocument> {
  return parserFor(fileType).parse(filePath)
}
