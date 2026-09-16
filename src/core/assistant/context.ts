import type { DocumentChunk, SearchHit, SourceReference } from '../../shared/types'
import type { DocumentStore } from '../storage/document-store'

export interface Excerpt {
  /** 1-based number the model cites with, e.g. "[2]". */
  number: number
  documentId: string
  fileName: string
  path: string
  locator?: string
  text: string
}

export interface ExcerptBundle {
  excerpts: Excerpt[]
  charsSent: number
  fileNames: string[]
}

/**
 * Assemble the document text that will be sent to the AI provider.
 *
 * This function is the single place where Jarvis decides what leaves the
 * machine. It selects *passages*, never whole files and never whole folders,
 * and it stops at a hard character budget. The counts it returns are what the
 * UI discloses to the user.
 */
export async function buildExcerpts(
  hits: readonly SearchHit[],
  store: DocumentStore,
  options: {
    maxChars: number
    maxDocuments: number
    /** True for "summarise this" — read the document from the top rather than
     *  cherry-picking the passages that matched the query. */
    preferDocumentStart: boolean
  }
): Promise<ExcerptBundle> {
  const selected = hits.slice(0, options.maxDocuments)
  if (selected.length === 0) return { excerpts: [], charsSent: 0, fileNames: [] }

  const perDocBudget = Math.floor(options.maxChars / selected.length)
  const excerpts: Excerpt[] = []
  let charsSent = 0
  let number = 1

  for (const hit of selected) {
    const chunks = await store.loadChunks(hit.document.id)
    if (chunks.length === 0) continue

    const chosen = options.preferDocumentStart
      ? selectFromStart(chunks, perDocBudget)
      : selectAroundMatches(chunks, hit, perDocBudget)

    for (const chunk of chosen) {
      if (charsSent + chunk.text.length > options.maxChars) break
      const excerpt: Excerpt = {
        number,
        documentId: hit.document.id,
        fileName: hit.document.fileName,
        path: hit.document.path,
        text: chunk.text
      }
      if (chunk.locator) excerpt.locator = chunk.locator
      excerpts.push(excerpt)
      charsSent += chunk.text.length
      number++
    }
  }

  return {
    excerpts,
    charsSent,
    fileNames: [...new Set(excerpts.map((e) => e.fileName))]
  }
}

/** Read the document from the beginning — the right shape for a summary. */
function selectFromStart(chunks: DocumentChunk[], budget: number): DocumentChunk[] {
  const ordered = [...chunks].sort((a, b) => a.ordinal - b.ordinal)
  const out: DocumentChunk[] = []
  let used = 0
  for (const chunk of ordered) {
    if (used + chunk.text.length > budget) break
    out.push(chunk)
    used += chunk.text.length
  }
  // Always include at least the opening passage, even if it exceeds the budget.
  if (out.length === 0 && ordered[0]) out.push(ordered[0])
  return out
}

/**
 * Take the passages that matched, plus the one immediately after each, so an
 * answer is not cut off mid-thought at a chunk boundary.
 */
function selectAroundMatches(
  chunks: DocumentChunk[],
  hit: SearchHit,
  budget: number
): DocumentChunk[] {
  const byId = new Map(chunks.map((c) => [c.id, c]))
  const byOrdinal = new Map(chunks.map((c) => [c.ordinal, c]))
  const wanted = new Map<number, DocumentChunk>()

  for (const snippet of hit.snippets) {
    const chunk = byId.get(snippet.chunkId)
    if (!chunk) continue
    wanted.set(chunk.ordinal, chunk)
    const next = byOrdinal.get(chunk.ordinal + 1)
    if (next) wanted.set(next.ordinal, next)
  }

  if (wanted.size === 0) return selectFromStart(chunks, budget)

  const ordered = [...wanted.values()].sort((a, b) => a.ordinal - b.ordinal)
  const out: DocumentChunk[] = []
  let used = 0
  for (const chunk of ordered) {
    if (used + chunk.text.length > budget) break
    out.push(chunk)
    used += chunk.text.length
  }
  if (out.length === 0 && ordered[0]) out.push(ordered[0])
  return out
}

/** Render excerpts for the prompt, numbered so the model can cite them. */
export function renderExcerpts(excerpts: readonly Excerpt[]): string {
  return excerpts
    .map((e) => {
      const where = e.locator ? `${e.fileName}, ${e.locator}` : e.fileName
      return `[${e.number}] ${where}\n${e.text}`
    })
    .join('\n\n---\n\n')
}

/**
 * Work out which excerpts the answer actually cited, so the sources list
 * reflects what was used rather than what was offered.
 */
export function citedSources(answer: string, excerpts: readonly Excerpt[]): SourceReference[] {
  const cited = new Set<number>()
  for (const match of answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const part of match[1]!.split(',')) {
      const n = Number.parseInt(part.trim(), 10)
      if (Number.isFinite(n)) cited.add(n)
    }
  }

  // If the model cited nothing, fall back to everything it was shown — the user
  // should always be able to check the answer against the files behind it.
  const relevant = cited.size > 0 ? excerpts.filter((e) => cited.has(e.number)) : excerpts

  const seen = new Set<string>()
  const sources: SourceReference[] = []
  for (const excerpt of relevant) {
    const key = `${excerpt.documentId}:${excerpt.locator ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    const source: SourceReference = {
      documentId: excerpt.documentId,
      fileName: excerpt.fileName,
      path: excerpt.path
    }
    if (excerpt.locator) source.locator = excerpt.locator
    sources.push(source)
  }
  return sources
}
