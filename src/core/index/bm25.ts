import { tokenize } from './tokenize'

/**
 * A BM25 inverted index over a single named field.
 *
 * Written in plain TypeScript on purpose. Jarvis has no native dependencies, so
 * `npm install` cannot fail with a compiler error on the user's Mac — the most
 * common reason a desktop app refuses to start. At personal-archive scale
 * (tens of thousands of passages) this is comfortably fast, and it sits behind
 * {@link SearchIndex} so it can be replaced with SQLite FTS5 or a vector store
 * in a later version without touching anything above it.
 */

const K1 = 1.4
const B = 0.72

export interface ScoredId {
  id: string
  score: number
  /** Which query terms actually matched, for explaining the result. */
  matchedTerms: string[]
}

interface SerializedField {
  postings: Array<[string, Array<[string, number]>]>
  lengths: Array<[string, number]>
}

export class FieldIndex {
  /** term -> (docId -> term frequency) */
  private postings = new Map<string, Map<string, number>>()
  /** docId -> token count */
  private lengths = new Map<string, number>()
  private totalLength = 0

  get size(): number {
    return this.lengths.size
  }

  add(id: string, text: string): void {
    this.remove(id)
    const terms = tokenize(text)
    if (terms.length === 0) {
      // Still record the document so corpus statistics stay correct.
      this.lengths.set(id, 0)
      return
    }
    const counts = new Map<string, number>()
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1)
    for (const [term, tf] of counts) {
      let bucket = this.postings.get(term)
      if (!bucket) {
        bucket = new Map()
        this.postings.set(term, bucket)
      }
      bucket.set(id, tf)
    }
    this.lengths.set(id, terms.length)
    this.totalLength += terms.length
  }

  remove(id: string): void {
    const len = this.lengths.get(id)
    if (len === undefined) return
    this.totalLength -= len
    this.lengths.delete(id)
    // Walking every posting list is O(vocabulary), but removals only happen
    // when a file is deleted or re-indexed, not on the search path.
    for (const [term, bucket] of this.postings) {
      if (bucket.delete(id) && bucket.size === 0) this.postings.delete(term)
    }
  }

  has(id: string): boolean {
    return this.lengths.has(id)
  }

  private idf(term: string): number {
    const df = this.postings.get(term)?.size ?? 0
    if (df === 0) return 0
    const n = this.lengths.size
    return Math.log(1 + (n - df + 0.5) / (df + 0.5))
  }

  /** BM25 scores for `terms`, keyed by document id. Only matches are returned. */
  score(terms: readonly string[]): Map<string, { score: number; matched: Set<string> }> {
    const results = new Map<string, { score: number; matched: Set<string> }>()
    const avgLen = this.lengths.size > 0 ? this.totalLength / this.lengths.size : 0
    if (avgLen === 0) return results

    for (const term of terms) {
      const bucket = this.postings.get(term)
      if (!bucket) continue
      const idf = this.idf(term)
      if (idf <= 0) continue
      for (const [id, tf] of bucket) {
        const len = this.lengths.get(id) ?? 0
        const denom = tf + K1 * (1 - B + (B * len) / avgLen)
        const contribution = (idf * (tf * (K1 + 1))) / (denom || 1)
        const entry = results.get(id)
        if (entry) {
          entry.score += contribution
          entry.matched.add(term)
        } else {
          results.set(id, { score: contribution, matched: new Set([term]) })
        }
      }
    }
    return results
  }

  toJSON(): SerializedField {
    return {
      postings: [...this.postings].map(([term, bucket]) => [term, [...bucket]]),
      lengths: [...this.lengths]
    }
  }

  static fromJSON(data: SerializedField): FieldIndex {
    const index = new FieldIndex()
    for (const [term, bucket] of data.postings) {
      index.postings.set(term, new Map(bucket))
    }
    for (const [id, len] of data.lengths) {
      index.lengths.set(id, len)
      index.totalLength += len
    }
    return index
  }
}
