import type { SupportedFileType } from '../../shared/types'

/**
 * A contiguous run of text from a document, tagged with where it came from so
 * Jarvis can cite it ("page 4", "sheet: Invoices", "row 12").
 */
export interface TextSegment {
  text: string
  locator?: string
}

export interface ParsedDocument {
  segments: TextSegment[]
  /** Total characters extracted. */
  charCount: number
  /**
   * Set when the file was readable but yielded no usable text — e.g. a scanned
   * PDF with no text layer. Surfaced to the user rather than silently dropped.
   */
  warning?: string
}

export interface DocumentParser {
  readonly fileType: SupportedFileType
  parse(filePath: string): Promise<ParsedDocument>
}

/** All file types Jarvis can read in V0.1, keyed by lowercase extension. */
export const EXTENSION_TO_TYPE: Record<string, SupportedFileType> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.txt': 'txt',
  '.text': 'txt',
  '.md': 'md',
  '.markdown': 'md',
  '.csv': 'csv',
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsx'
}

export function typeForExtension(ext: string): SupportedFileType | null {
  return EXTENSION_TO_TYPE[ext.toLowerCase()] ?? null
}
