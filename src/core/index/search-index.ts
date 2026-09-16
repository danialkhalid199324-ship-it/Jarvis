import fs from 'node:fs/promises'
import path from 'node:path'
import { FieldIndex, type ScoredId } from './bm25'
import { tokenize } from './tokenize'

const INDEX_VERSION = 1

/**
 * Field weights. A document whose *name* matches the query is almost always
 * what the user meant ("find my latest GTA operational plan"), so the name
 * field is weighted hardest; folder names are a weaker but real signal.
 */
export const FIELD_WEIGHTS = {
  name: 6,
  folder: 2,
  body: 1
} as const

export interface ChunkRef {
  chunkId: string
  documentId: string
}

interface Serialized {
  version: number
  name: ReturnType<FieldIndex['toJSON']>
  folder: ReturnType<FieldIndex['toJSON']>
  body: ReturnType<FieldIndex['toJSON']>
  chunkOwners: Array<[string, string]>
}

export interface DocumentScore extends ScoredId {
  /** Best-scoring chunks for this document, highest first. */
  chunks: ScoredId[]
  /** Which fields contributed, for explaining relevance in plain language. */
  matchedFields: Array<'name' | 'folder' | 'body'>
}

/**
 * The searchable view of everything Jarvis has indexed.
 *
 * Documents are indexed on their file name and folder path; passages are
 * indexed separately so an answer can cite the exact page or section it came
 * from. Scores from both levels are combined per document.
 */
export class SearchIndex {
  private nameIndex = new FieldIndex()
  private folderIndex = new FieldIndex()
  private bodyIndex = new FieldIndex()
  /** chunkId -> documentId */
  private chunkOwners = new Map<string, string>()

  get documentCount(): number {
    return this.nameIndex.size
  }

  addDocument(documentId: string, fileName: string, folderPath: string): void {
    this.nameIndex.add(documentId, fileName)
    this.folderIndex.add(documentId, folderPath)
  }

  addChunk(chunkId: string, documentId: string, text: string): void {
    this.bodyIndex.add(chunkId, text)
    this.chunkOwners.set(chunkId, documentId)
  }

  removeDocument(documentId: string): void {
    this.nameIndex.remove(documentId)
    this.folderIndex.remove(documentId)
    for (const [chunkId, owner] of this.chunkOwners) {
      if (owner === documentId) {
        this.bodyIndex.remove(chunkId)
        this.chunkOwners.delete(chunkId)
      }
    }
  }

  hasDocument(documentId: string): boolean {
    return this.nameIndex.has(documentId)
  }

  /**
   * Empty the index in place.
   *
   * Done in place rather than by constructing a fresh instance so that every
   * component already holding a reference to this index keeps working after the
   * user deletes their data.
   */
  clear(): void {
    this.nameIndex = new FieldIndex()
    this.folderIndex = new FieldIndex()
    this.bodyIndex = new FieldIndex()
    this.chunkOwners = new Map()
  }

  /**
   * Rank documents for a set of query terms.
   *
   * @param terms already-tokenised query terms (see {@link tokenize})
   * @param limit maximum documents to return
   * @param restrictTo optional document-id allowlist, used for follow-up
   *        questions that should stay within the documents already in context
   */
  search(terms: readonly string[], limit = 20, restrictTo?: ReadonlySet<string>): DocumentScore[] {
    if (terms.length === 0) return []

    const nameScores = this.nameIndex.score(terms)
    const folderScores = this.folderIndex.score(terms)
    const bodyScores = this.bodyIndex.score(terms)

    interface Acc {
      score: number
      matched: Set<string>
      fields: Set<'name' | 'folder' | 'body'>
      chunks: ScoredId[]
    }
    const docs = new Map<string, Acc>()
    const ensure = (id: string): Acc => {
      let acc = docs.get(id)
      if (!acc) {
        acc = { score: 0, matched: new Set(), fields: new Set(), chunks: [] }
        docs.set(id, acc)
      }
      return acc
    }

    for (const [docId, entry] of nameScores) {
      if (restrictTo && !restrictTo.has(docId)) continue
      const acc = ensure(docId)
      acc.score += entry.score * FIELD_WEIGHTS.name
      acc.fields.add('name')
      for (const t of entry.matched) acc.matched.add(t)
    }

    for (const [docId, entry] of folderScores) {
      if (restrictTo && !restrictTo.has(docId)) continue
      const acc = ensure(docId)
      acc.score += entry.score * FIELD_WEIGHTS.folder
      acc.fields.add('folder')
      for (const t of entry.matched) acc.matched.add(t)
    }

    // Group chunk hits under their document. A document's body contribution is
    // its best chunk plus a decayed share of the rest, so a file that mentions
    // the topic throughout outranks one with a single passing mention, without
    // letting long files dominate purely on length.
    const perDoc = new Map<string, ScoredId[]>()
    for (const [chunkId, entry] of bodyScores) {
      const docId = this.chunkOwners.get(chunkId)
      if (!docId) continue
      if (restrictTo && !restrictTo.has(docId)) continue
      const list = perDoc.get(docId) ?? []
      list.push({ id: chunkId, score: entry.score, matchedTerms: [...entry.matched] })
      perDoc.set(docId, list)
    }

    for (const [docId, chunks] of perDoc) {
      chunks.sort((a, b) => b.score - a.score)
      const acc = ensure(docId)
      let body = 0
      chunks.forEach((chunk, i) => {
        body += chunk.score / (1 + i)
        for (const t of chunk.matchedTerms) acc.matched.add(t)
      })
      acc.score += body * FIELD_WEIGHTS.body
      acc.fields.add('body')
      acc.chunks = chunks.slice(0, 8)
    }

    return [...docs]
      .map(([id, acc]) => ({
        id,
        score: acc.score,
        matchedTerms: [...acc.matched],
        matchedFields: [...acc.fields],
        chunks: acc.chunks
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /** Convenience wrapper that tokenises a raw query string. */
  searchText(query: string, limit = 20): DocumentScore[] {
    return this.search(tokenize(query), limit)
  }

  // -- persistence ---------------------------------------------------------

  async save(dir: string): Promise<void> {
    const payload: Serialized = {
      version: INDEX_VERSION,
      name: this.nameIndex.toJSON(),
      folder: this.folderIndex.toJSON(),
      body: this.bodyIndex.toJSON(),
      chunkOwners: [...this.chunkOwners]
    }
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'search-index.json')
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(payload), 'utf8')
    await fs.rename(tmp, file)
  }

  /**
   * @returns the persisted index, or null when it is missing or written by a
   * different version — in which case the caller rebuilds it from the chunk
   * store, which is always the source of truth.
   */
  static async load(dir: string): Promise<SearchIndex | null> {
    try {
      const raw = await fs.readFile(path.join(dir, 'search-index.json'), 'utf8')
      const data = JSON.parse(raw) as Serialized
      if (data.version !== INDEX_VERSION) return null
      const index = new SearchIndex()
      index.nameIndex = FieldIndex.fromJSON(data.name)
      index.folderIndex = FieldIndex.fromJSON(data.folder)
      index.bodyIndex = FieldIndex.fromJSON(data.body)
      index.chunkOwners = new Map(data.chunkOwners)
      return index
    } catch {
      return null
    }
  }
}
