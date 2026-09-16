import type { TextSegment } from '../parsers/types'
import type { DocumentChunk } from '../../shared/types'
import { stableId } from '../util/ids'

/** Target passage size. Large enough to answer a question, small enough to cite. */
export const TARGET_CHUNK_CHARS = 1400
/** Overlap so a sentence spanning a boundary is still retrievable from one side. */
export const CHUNK_OVERLAP_CHARS = 180
/** Anything shorter than this is folded into the neighbouring chunk. */
const MIN_CHUNK_CHARS = 120

/** Split on sentence and paragraph boundaries, keeping the delimiter. */
function splitIntoSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?:;])\s+|\n{2,}/)
  return parts.map((p) => p.trim()).filter(Boolean)
}

/**
 * Turn a parser's segments into retrievable chunks.
 *
 * Segment boundaries (a PDF page, a spreadsheet row range) are never crossed,
 * so every chunk keeps an accurate locator to cite. Within a segment, text is
 * split on sentence boundaries rather than mid-word.
 */
export function chunkSegments(documentId: string, segments: readonly TextSegment[]): DocumentChunk[] {
  const chunks: DocumentChunk[] = []
  let ordinal = 0

  const push = (text: string, locator?: string): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    const chunk: DocumentChunk = {
      id: stableId(`${documentId}:${ordinal}`),
      documentId,
      ordinal,
      text: trimmed
    }
    if (locator) chunk.locator = locator
    chunks.push(chunk)
    ordinal++
  }

  for (const segment of segments) {
    const text = segment.text.trim()
    if (!text) continue

    if (text.length <= TARGET_CHUNK_CHARS) {
      push(text, segment.locator)
      continue
    }

    const sentences = splitIntoSentences(text)
    let buffer = ''

    for (const sentence of sentences) {
      // A single sentence longer than the target (common in extracted PDF
      // tables) is hard-split rather than allowed to grow unbounded.
      if (sentence.length > TARGET_CHUNK_CHARS) {
        if (buffer) {
          push(buffer, segment.locator)
          buffer = ''
        }
        for (let i = 0; i < sentence.length; i += TARGET_CHUNK_CHARS) {
          push(sentence.slice(i, i + TARGET_CHUNK_CHARS), segment.locator)
        }
        continue
      }

      if (buffer.length + sentence.length + 1 > TARGET_CHUNK_CHARS) {
        push(buffer, segment.locator)
        const tail = buffer.slice(-CHUNK_OVERLAP_CHARS)
        // Start the next chunk at a word boundary within the overlap.
        const cut = tail.indexOf(' ')
        buffer = (cut >= 0 ? tail.slice(cut + 1) : '') + (buffer ? ' ' : '') + sentence
      } else {
        buffer = buffer ? `${buffer} ${sentence}` : sentence
      }
    }

    if (buffer) {
      const last = chunks[chunks.length - 1]
      if (buffer.length < MIN_CHUNK_CHARS && last && last.locator === segment.locator) {
        last.text = `${last.text} ${buffer.trim()}`.trim()
      } else {
        push(buffer, segment.locator)
      }
    }
  }

  return chunks
}
