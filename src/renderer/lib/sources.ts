import type { SourceReference } from '../../shared/types'

/**
 * Presentation-only grouping of citations.
 *
 * The assistant emits one `SourceReference` per cited passage, which is what
 * makes page-level grounding possible and is deliberately left untouched. This
 * only changes how that same data reads: a document cited on pages 1, 2 and 3
 * should appear once with its pages gathered, not three times.
 */
export interface GroupedSource {
  documentId: string
  fileName: string
  path: string
  /** Every locator cited for this document, in the order first cited. */
  locators: string[]
  /** How many individual citations were collapsed into this row. */
  citationCount: number
}

/** Group references by document, preserving first-cited order. */
export function groupSources(sources: readonly SourceReference[]): GroupedSource[] {
  const groups = new Map<string, GroupedSource>()

  for (const source of sources) {
    let group = groups.get(source.documentId)
    if (!group) {
      group = {
        documentId: source.documentId,
        fileName: source.fileName,
        path: source.path,
        locators: [],
        citationCount: 0
      }
      groups.set(source.documentId, group)
    }
    group.citationCount++
    if (source.locator && !group.locators.includes(source.locator)) {
      group.locators.push(source.locator)
    }
  }

  return [...groups.values()]
}

/**
 * Render a document's locators compactly.
 *
 * Page numbers are the common case and compress into ranges — "pages 1–3, 7"
 * rather than "page 1, page 2, page 3, page 7". Anything else (spreadsheet
 * sheets, Word sections, row ranges) is listed as-is, because those labels
 * carry meaning that a range would lose.
 */
export function formatLocators(locators: readonly string[]): string {
  if (locators.length === 0) return ''
  if (locators.length === 1) return locators[0]!

  const pageNumbers: number[] = []
  const allPages = locators.every((locator) => {
    const match = /^page (\d+)$/.exec(locator)
    if (!match) return false
    pageNumbers.push(Number.parseInt(match[1]!, 10))
    return true
  })

  if (!allPages) return locators.join(', ')

  const sorted = [...new Set(pageNumbers)].sort((a, b) => a - b)
  const runs: string[] = []
  let start = sorted[0]!
  let previous = start

  for (let i = 1; i <= sorted.length; i++) {
    const current = sorted[i]
    if (current !== undefined && current === previous + 1) {
      previous = current
      continue
    }
    runs.push(start === previous ? `${start}` : `${start}–${previous}`)
    if (current === undefined) break
    start = current
    previous = current
  }

  return `${sorted.length === 1 ? 'page' : 'pages'} ${runs.join(', ')}`
}
