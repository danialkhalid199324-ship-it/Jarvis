/**
 * Tokenisation for Jarvis's search index.
 *
 * Deliberately simple and predictable: lowercase, split on non-alphanumerics,
 * keep digits (invoice numbers, years, ABNs), drop a small stop-word list, and
 * emit a light stem so "plans" matches "plan".
 *
 * Acronyms matter for this user's documents ("GTA", "LRD", "NDIS"), so short
 * tokens are preserved rather than filtered out by a minimum length.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'he', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to',
  'was', 'were', 'will', 'with', 'i', 'you', 'we', 'they', 'my', 'me', 'our',
  'do', 'does', 'did', 'can', 'could', 'would', 'should', 'there', 'their',
  'what', 'which', 'who', 'when', 'where', 'how', 'any', 'all', 'about'
])

/** Split raw text into normalised terms. */
export function tokenize(text: string): string[] {
  const out: string[] = []
  // Unicode-aware split so accented characters survive.
  const raw = text.toLowerCase().split(/[^\p{L}\p{N}]+/u)
  for (const token of raw) {
    if (!token) continue
    if (token.length > 40) continue // hashes, base64 blobs — not useful terms
    if (STOP_WORDS.has(token)) continue
    out.push(stem(token))
  }
  return out
}

/**
 * Minimal suffix stripper. Full Porter stemming is more aggressive than this
 * corpus needs and makes results harder to explain to the user.
 */
export function stem(token: string): string {
  if (token.length <= 3) return token
  if (token.endsWith('ies') && token.length > 4) return token.slice(0, -3) + 'y'
  if (token.endsWith('sses')) return token.slice(0, -2)
  if (token.endsWith('ing') && token.length > 5) return token.slice(0, -3)
  if (token.endsWith('ed') && token.length > 4) return token.slice(0, -2)
  if (token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) {
    return token.slice(0, -1)
  }
  return token
}

/**
 * Tokenise while remembering the word each term came from, so Jarvis can
 * explain a match in the user's own words rather than in stemmed forms
 * ("ndis" rather than "ndi").
 */
export function tokenizeDetailed(text: string): Array<{ term: string; original: string }> {
  const out: Array<{ term: string; original: string }> = []
  const raw = text.toLowerCase().split(/[^\p{L}\p{N}]+/u)
  for (const token of raw) {
    if (!token) continue
    if (token.length > 40) continue
    if (STOP_WORDS.has(token)) continue
    out.push({ term: stem(token), original: token })
  }
  return out
}

/**
 * Terms taken from a file's name and folder path. Path components are strong
 * relevance signals — a plan named "GTA Operational Plan 2026.pdf" should win
 * on filename alone.
 */
export function tokenizePath(filePath: string): string[] {
  return tokenize(filePath.replace(/[\\/]/g, ' '))
}
