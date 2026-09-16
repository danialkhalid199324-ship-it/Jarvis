import type { DocumentMeta, SearchHit } from '../../shared/types'
import type { DocumentStore } from '../storage/document-store'
import type { SearchIndex } from '../index/search-index'
import type { QueryPlan } from './query-plan'

/** How many days old a file can be before the recency boost stops helping it. */
const RECENCY_HORIZON_DAYS = 540

export interface RetrieveOptions {
  limit?: number
  /** Restrict to these document ids (used for follow-up questions). */
  restrictTo?: ReadonlySet<string>
  /** Snippets to attach per result. */
  snippetsPerDocument?: number
}

function daysSince(epochMs: number | null): number | null {
  if (epochMs === null) return null
  return (Date.now() - epochMs) / 86_400_000
}

/**
 * Multiplier applied when the user asked for the "latest" one. Recent files are
 * favoured, but never enough to push a genuinely better textual match below a
 * weak-but-newer file.
 */
function recencyMultiplier(meta: DocumentMeta): number {
  const age = daysSince(meta.modifiedAt)
  if (age === null) return 1
  const normalised = Math.max(0, Math.min(1, 1 - age / RECENCY_HORIZON_DAYS))
  return 1 + 0.45 * normalised
}

function phraseBonus(meta: DocumentMeta, snippetText: string, phrases: readonly string[]): number {
  let bonus = 0
  for (const phrase of phrases) {
    const needle = phrase.toLowerCase()
    if (!needle) continue
    if (meta.fileName.toLowerCase().includes(needle)) bonus += 4
    else if (snippetText.toLowerCase().includes(needle)) bonus += 1.5
  }
  return bonus
}

function formatDate(epochMs: number | null): string {
  if (epochMs === null) return 'an unknown date'
  return new Date(epochMs).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })
}

/**
 * Plain-language explanation of why this file came back. Shown under every
 * result so the user is never left guessing what Jarvis matched on.
 */
function explain(
  meta: DocumentMeta,
  matchedFields: readonly string[],
  matchedTerms: readonly string[],
  plan: QueryPlan
): string {
  // Report matches in the user's own words rather than internal stemmed forms.
  const words = [...new Set(matchedTerms.map((t) => plan.termDisplay[t] ?? t))].slice(0, 4)
  const termList = words.length > 0 ? formatList(words) : 'your search'

  const inName = matchedFields.includes('name')
  const inBody = matchedFields.includes('body')
  const inFolder = matchedFields.includes('folder')

  let core: string
  if (inName && inBody) core = `The file name and its contents both mention ${termList}`
  else if (inName) core = `The file name matches ${termList}`
  else if (inBody) core = `The contents mention ${termList}`
  else if (inFolder) core = `It sits in a folder named for ${termList}`
  else return 'Matched your search terms.'

  if (inFolder && !inName) core += ', and its folder matches too'
  if (plan.preferRecent && meta.modifiedAt !== null) {
    core += `. It was last changed ${formatDate(meta.modifiedAt)}`
  }

  return `${core}.`
}

/** "a", "a and b", "a, b and c" */
function formatList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * Turn a query plan into ranked file results.
 *
 * Searching happens entirely on this machine: the index holds only text from
 * authorised folders, and nothing is sent anywhere to produce this list.
 */
export async function retrieve(
  plan: QueryPlan,
  index: SearchIndex,
  store: DocumentStore,
  options: RetrieveOptions = {}
): Promise<SearchHit[]> {
  const limit = options.limit ?? 10
  const snippetsPerDocument = options.snippetsPerDocument ?? 3

  // Over-fetch so filtering and re-ranking still have enough to work with.
  const raw = index.search(plan.terms, Math.max(limit * 4, 40), options.restrictTo)
  const hits: SearchHit[] = []

  for (const scored of raw) {
    const meta = store.getDocument(scored.id)
    if (!meta) continue
    if (plan.fileTypes.length > 0 && !plan.fileTypes.includes(meta.fileType)) continue

    const chunks = scored.chunks.length > 0 ? await store.loadChunks(meta.id) : []
    const byId = new Map(chunks.map((c) => [c.id, c]))

    const snippets = scored.chunks
      .map((c) => byId.get(c.id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
      .slice(0, snippetsPerDocument)
      .map((c) => {
        const snippet: SearchHit['snippets'][number] = { chunkId: c.id, text: c.text }
        if (c.locator) snippet.locator = c.locator
        return snippet
      })

    const snippetText = snippets.map((s) => s.text).join('\n')
    let score = scored.score + phraseBonus(meta, snippetText, plan.phrases)
    if (plan.preferRecent) score *= recencyMultiplier(meta)

    hits.push({
      document: meta,
      score,
      reason: explain(meta, scored.matchedFields, scored.matchedTerms, plan),
      snippets
    })
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Deterministic tie-break: newer first, then by name.
    const am = a.document.modifiedAt ?? 0
    const bm = b.document.modifiedAt ?? 0
    if (bm !== am) return bm - am
    return a.document.fileName.localeCompare(b.document.fileName)
  })

  return hits.slice(0, limit)
}
