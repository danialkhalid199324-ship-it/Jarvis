import type { SupportedFileType } from '../../shared/types'
import { extractJson, type AIProvider } from '../ai/provider'
import { tokenize, tokenizeDetailed } from '../index/tokenize'

/**
 * What Jarvis is being asked to do. Kept deliberately small — these are the
 * things V0.1 can actually carry out.
 */
export type QueryIntent =
  /** "Find documents about X" — return a list of files. */
  | 'find'
  /** "Summarise it" / "what does it say about X" — read documents and answer. */
  | 'answer'
  /** "Compare these two documents." */
  | 'compare'
  /** "Where is this file?" — location only, no content needed. */
  | 'locate'

export interface QueryPlan {
  intent: QueryIntent
  /** Terms to search the index with, already expanded with likely synonyms. */
  terms: string[]
  /** Literal phrase to boost when it appears verbatim in a file name or text. */
  phrases: string[]
  /** Restrict results to these file types when the user asked for them. */
  fileTypes: SupportedFileType[]
  /** True when the user asked for the most recent match ("latest", "newest"). */
  preferRecent: boolean
  /**
   * True when the question refers back to documents already in the
   * conversation ("summarise it", "what about compliance in those?").
   */
  refersToContext: boolean
  /**
   * Maps each search term back to the word the user actually typed, so result
   * explanations read naturally.
   */
  termDisplay: Record<string, string>
  /** How the plan was produced, for transparency and testing. */
  source: 'model' | 'heuristic'
}

function buildTermDisplay(question: string): Record<string, string> {
  const display: Record<string, string> = {}
  for (const { term, original } of tokenizeDetailed(question)) {
    if (!(term in display)) display[term] = original
  }
  return display
}

const FILE_TYPE_WORDS: Array<[RegExp, SupportedFileType]> = [
  [/\bpdfs?\b/i, 'pdf'],
  [/\b(word|docx?)\b/i, 'docx'],
  [/\b(spreadsheets?|excel|xlsx?|workbooks?)\b/i, 'xlsx'],
  [/\bcsvs?\b/i, 'csv'],
  [/\b(markdown|md)\b/i, 'md']
]

const RECENCY_WORDS =
  /\b(latest|newest|most recent|recent|last|current|up to date|up-to-date)\b/i

const CONTEXT_WORDS =
  /\b(it|its|this|that|these|those|them|the document|the file|the same|above)\b/i

const ANSWER_WORDS =
  /\b(summar(y|ise|ize)|explain|what does|what do|tell me about|outstanding|priorit(y|ies)|key points|extract|according to|says? about|status|overview|action items?)\b/i

const COMPARE_WORDS = /\b(compare|difference|differences|versus|vs\.?|contrast|changed between)\b/i

const LOCATE_WORDS = /\b(where is|where are|which folder|what folder|location of|path (to|of))\b/i

/**
 * Rule-based plan. Used when no AI provider is configured, and as the fallback
 * whenever the model is unavailable or returns something unusable — so search
 * keeps working without any API key at all.
 */
export function heuristicPlan(question: string): QueryPlan {
  const fileTypes: SupportedFileType[] = []
  for (const [pattern, type] of FILE_TYPE_WORDS) {
    if (pattern.test(question) && !fileTypes.includes(type)) fileTypes.push(type)
  }

  let intent: QueryIntent = 'find'
  if (LOCATE_WORDS.test(question)) intent = 'locate'
  else if (COMPARE_WORDS.test(question)) intent = 'compare'
  else if (ANSWER_WORDS.test(question)) intent = 'answer'

  // Quoted spans are treated as literal phrases the user wants matched.
  const phrases = [...question.matchAll(/["“']([^"”']{3,})["”']/g)]
    .map((m) => m[1]!.trim())
    .filter(Boolean)

  return {
    intent,
    terms: tokenize(question),
    phrases,
    fileTypes,
    preferRecent: RECENCY_WORDS.test(question),
    refersToContext: CONTEXT_WORDS.test(question),
    termDisplay: buildTermDisplay(question),
    source: 'heuristic'
  }
}

interface ModelPlan {
  intent?: string
  search_terms?: unknown
  phrases?: unknown
  file_types?: unknown
  prefer_recent?: unknown
  refers_to_previous?: unknown
}

const PLAN_SCHEMA = `{
  "intent": "find" | "answer" | "compare" | "locate",
  "search_terms": string[],   // keywords and likely alternatives, e.g. an acronym plus its expansion
  "phrases": string[],        // exact phrases worth matching verbatim, may be empty
  "file_types": string[],     // any of: pdf, docx, txt, md, csv, xlsx. Empty means no restriction
  "prefer_recent": boolean,   // true if the user asked for the latest/newest one
  "refers_to_previous": boolean // true if the question is about documents already discussed
}`

const PLANNER_SYSTEM = `You turn a question about someone's personal document archive into a search plan.

Rules:
- Expand abbreviations and acronyms into BOTH the acronym and plausible expansions, because the archive may use either. Keep the original spelling too.
- Include singular and plural forms where they differ meaningfully.
- Do not invent company names, project names or topics that are not implied by the question.
- "intent" is "find" when the user wants a list of files, "answer" when they want information read out of documents, "compare" when they want two or more documents contrasted, "locate" when they only want to know where a file lives.
- "refers_to_previous" is true when the question uses words like "it", "that one", "those documents" instead of naming a subject.`

/**
 * Ask the model to expand a natural-language question into search terms.
 *
 * This is the only place Jarvis sends the *question* (never document text) to a
 * provider before searching. If anything goes wrong the heuristic plan is used
 * instead, so a provider outage degrades quality rather than breaking search.
 */
export async function planQuery(
  question: string,
  provider: AIProvider | null,
  model: string,
  options: { recentContext?: string[]; signal?: AbortSignal } = {}
): Promise<QueryPlan> {
  const fallback = heuristicPlan(question)
  if (!provider) return fallback

  const contextNote = options.recentContext?.length
    ? `\n\nDocuments already discussed in this conversation:\n${options.recentContext.map((c) => `- ${c}`).join('\n')}`
    : ''

  try {
    const response = await provider.complete(
      {
        system: PLANNER_SYSTEM,
        jsonSchemaHint: PLAN_SCHEMA,
        maxTokens: 700,
        messages: [{ role: 'user', content: `Question: ${question}${contextNote}` }],
        ...(options.signal ? { signal: options.signal } : {})
      },
      model
    )

    const parsed = extractJson<ModelPlan>(response.text)
    if (!parsed) return fallback

    const asStringArray = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : []

    const intent = ['find', 'answer', 'compare', 'locate'].includes(String(parsed.intent))
      ? (parsed.intent as QueryIntent)
      : fallback.intent

    const modelTerms = asStringArray(parsed.search_terms).flatMap((t) => tokenize(t))
    const validTypes: SupportedFileType[] = ['pdf', 'docx', 'txt', 'md', 'csv', 'xlsx']
    const fileTypes = asStringArray(parsed.file_types)
      .map((t) => t.toLowerCase())
      .filter((t): t is SupportedFileType => validTypes.includes(t as SupportedFileType))

    return {
      intent,
      // Union with the literal question terms: the model expands, it never
      // narrows away something the user actually typed.
      terms: [...new Set([...fallback.terms, ...modelTerms])],
      phrases: [...new Set([...fallback.phrases, ...asStringArray(parsed.phrases)])],
      fileTypes: fileTypes.length > 0 ? fileTypes : fallback.fileTypes,
      preferRecent:
        typeof parsed.prefer_recent === 'boolean' ? parsed.prefer_recent : fallback.preferRecent,
      refersToContext:
        typeof parsed.refers_to_previous === 'boolean'
          ? parsed.refers_to_previous
          : fallback.refersToContext,
      // Terms the model added keep their own spelling as the display form.
      termDisplay: {
        ...buildTermDisplay(asStringArray(parsed.search_terms).join(' ')),
        ...fallback.termDisplay
      },
      source: 'model'
    }
  } catch {
    return fallback
  }
}
