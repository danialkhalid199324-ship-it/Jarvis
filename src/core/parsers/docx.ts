import type { DocumentParser, ParsedDocument, TextSegment } from './types'
import type { SupportedFileType } from '../../shared/types'

/**
 * Word documents. `mammoth` converts the document body to plain text; we then
 * split on blank lines so each paragraph block can be cited independently.
 */
export class DocxParser implements DocumentParser {
  readonly fileType: SupportedFileType = 'docx'

  async parse(filePath: string): Promise<ParsedDocument> {
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ path: filePath })
    const text = result.value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

    if (!text) {
      return {
        segments: [],
        charCount: 0,
        warning: 'The document contains no extractable text.'
      }
    }

    // Word has no pages until it is laid out, so sections are numbered instead.
    const blocks = text.split(/\n{2,}/).filter((b) => b.trim().length > 0)
    const segments: TextSegment[] = blocks.map((block, i) => ({
      text: block.trim(),
      locator: `section ${i + 1}`
    }))

    return { segments, charCount: text.length }
  }
}
