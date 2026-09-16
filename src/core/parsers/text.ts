import fs from 'node:fs/promises'
import type { DocumentParser, ParsedDocument } from './types'
import type { SupportedFileType } from '../../shared/types'

/** Plain text and Markdown. Markdown is indexed as-is; the syntax is harmless. */
export class PlainTextParser implements DocumentParser {
  readonly fileType: SupportedFileType

  constructor(fileType: 'txt' | 'md' = 'txt') {
    this.fileType = fileType
  }

  async parse(filePath: string): Promise<ParsedDocument> {
    const raw = await fs.readFile(filePath, 'utf8')
    const text = raw.replace(/\r\n/g, '\n').trim()
    if (!text) return { segments: [], charCount: 0, warning: 'The file is empty.' }
    return { segments: [{ text }], charCount: text.length }
  }
}
