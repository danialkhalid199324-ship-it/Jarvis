import type { MailExcerpt } from '../../communication/mail-context'
import { EVIDENCE_RULES } from '../../communication/evidence'
import type { ScoredMailMessage } from '../../../shared/communication'
import {
  categoriseReasons,
  rankByAttention,
  type MatterCategory
} from '../../communication/mail-intelligence'

/**
 * The analytical half of the mail capability.
 *
 * Retrieval answers "which messages"; this module answers "what do they mean".
 * It exists as its own file because the two halves have different costs and
 * different risks: listing mail is free, deterministic and sends nothing, while
 * analysis spends tokens and puts message text in front of a model. Keeping the
 * selection rules here — pure, synchronous and testable — means the bound on
 * what leaves the machine is a function with tests, not a constant buried in an
 * orchestration method.
 *
 * The unit of analysis is a **matter**, not a message. Two notices about the
 * same invoice are one thing the user has to deal with, and counting them as
 * two silently turns "the five most important" into four. Messages are grouped
 * first, the shortlist is chosen across distinct kinds of business problem, and
 * only then is anything sent anywhere.
 *
 * Nothing here calls a provider.
 */

/** How many matters to analyse when the user did not say. */
export const DEFAULT_ANALYSIS_COUNT = 5

/**
 * The ceiling on an analysis, whatever the user asks for.
 *
 * Lower than the routing ceiling on purpose: every item here costs tokens and
 * puts real email text in front of a model, so "summarise everything" has to
 * mean something bounded.
 */
export const MAX_ANALYSIS_COUNT = 10

/**
 * How many extra messages one matter may contribute.
 *
 * A matter needs enough of its messages for the model to see that they exist
 * and how they differ; it does not need the whole thread. The most pressing few
 * carry that, and the rest would only spend budget the other matters need.
 */
export const MAX_RELATED_PER_MATTER = 2

/** Hard ceiling on messages sent for one analysis, across every matter. */
export const MAX_ANALYSIS_MESSAGES = 15

/** Overall character budget for an analysis, regardless of provider settings. */
export const ANALYSIS_CONTEXT_CHARS = 16_000

/**
 * How the analysis must be written.
 *
 * The rules that matter most are the negative ones, and they come in two kinds.
 * One is about invention: an executive triage answer is only worth reading if
 * every deadline and amount in it is real, so filler rows ("Deadline: not
 * specified") are forbidden outright rather than left to the model's judgement.
 *
 * The other is about the limits of what Jarvis can know. Jarvis reads mail. It
 * cannot see a bank account, an accounting system or a filing cabinet, so an
 * email saying an invoice is due is evidence that the email says so — not
 * evidence that the money is still owed. Telling someone to "pay the
 * outstanding amount" asserts a fact about their books that Jarvis has no way
 * to check, and is exactly the kind of confident wrongness that makes an
 * assistant unusable for real money and real compliance.
 */
export const MAIL_ANALYSIS_SYSTEM = `You are Jarvis, a private executive assistant triaging the user's own email.

${EVIDENCE_RULES}

The emails below are grouped under MATTER headings. Jarvis decided that grouping; it is not yours to revisit.

1. Write exactly one block per MATTER heading, in the order the headings appear. A matter containing three excerpts is ONE block, not three. Never split a matter, never merge two, never add or drop one.
2. Work ONLY from the excerpts. Never use outside knowledge about companies, people or events. Never invent a date, a figure, a name, a request or a degree of urgency that is not in the text.
3. Write each block in this form, one item per line:

**<the subject, or the issue in a few words>** [excerpt numbers in this matter]
From: <sender name, or the address if no name is given>
What the emails say: <the key issue, one or two sentences, attributed>
What they are asking for: <what the sender wants from the user>
Next step: <what the user should do, inside the evidence boundary above>
Date stated: <only if an email states a date, day or timeframe — say which email states it>
Amount stated: <only if an email states a figure — say which email states it>
Why it matters: <one sentence, grounded in what the emails say>

4. Omit the "Date stated" line entirely when no date is stated, and the "Amount stated" line entirely when no figure is stated. Never write "not specified", "unknown", "N/A" or similar — a missing line is correct, a placeholder is not.
5. Where a matter holds more than one excerpt, say so in the block and spell out any way they disagree — different figures, different dates, a later notice contradicting an earlier one. That disagreement is usually the most useful thing you can tell the user.
6. If an email asks for nothing, write "What they are asking for: Nothing — for information only."
7. Only name something to look at first when the excerpts contain a defensible reason such as explicit urgency, a deadline, a blocking dependency, security/compliance risk, or a required response. Monetary size alone is not a reason to put a matter first. If no matter has stronger evidence than the others, omit the recommendation.
8. No greeting, no sign-off, no preamble, no restating of these instructions.
9. If none of the excerpts needs anything from the user, say so plainly in one sentence instead of manufacturing urgency.`

/**
 * One thing the user has to deal with, and every message about it.
 *
 * `primary` is the most pressing message; `related` is everything else Jarvis
 * grouped with it. The distinction only affects presentation — the model sees
 * them together and is told they are one matter.
 */
export interface MailMatter {
  /** The key the grouping was made on. Diagnostic; never shown to the user. */
  key: string
  primary: ScoredMailMessage
  /** Other messages about the same matter, most pressing first. */
  related: ScoredMailMessage[]
  /** Every message in the matter, most pressing first. */
  messages: ScoredMailMessage[]
  /** The matter's score: that of its most pressing message. */
  score: number
  /** The kinds of business problem this matter is, most significant first. */
  categories: MatterCategory[]
}

export interface AnalysisSelection {
  /** The matters to analyse, most pressing first. Never more than the limit. */
  matters: MailMatter[]
  /** Every message across those matters, in matter order. */
  candidates: ScoredMailMessage[]
  /** How many messages cleared the attention bar. */
  attentionCount: number
  /** How many distinct matters were eligible before the limit was applied. */
  poolSize: number
  /** The limit actually applied. */
  limit: number
  /** True when the user asked specifically about what needs attention. */
  attentionOnly: boolean
}

// ---------------------------------------------------------------------------
// Grouping: one matter, however many emails it arrived in
// ---------------------------------------------------------------------------

/**
 * A reference code, wherever it appears.
 *
 * Generic by construction: letters followed by a run of digits, or a digit run
 * explicitly introduced as a number or reference. That covers invoice numbers,
 * ticket ids, case numbers, purchase orders and claim references without this
 * module knowing what any of them are. A bare year or a plain figure does not
 * match, which keeps "due 30 September 2026" from becoming a key.
 */
const REFERENCE =
  /\b([A-Z]{2,6})[-_/ ]?(\d{3,}(?:[-_/]\d+)?)\b|(?:#|\bno\.?\s*|\bref(?:erence)?\.?\s*[:.]?\s*)(\d{4,})\b/gi

/** How much of a message body to scan for references. */
const REFERENCE_SCAN_CHARS = 400

/** Most references one message may contribute, so a figure-heavy body cannot merge the inbox. */
const MAX_REFERENCES = 4

/**
 * Every reference a message mentions, normalised.
 *
 * Two things make this wider than it first appears, and both are deliberate:
 *
 *   - It reads the preview as well as the subject. A chasing notice often
 *     carries a generic subject ("Your account statement") with the number
 *     only in the body, and grouping on subjects alone silently misses it.
 *   - A qualified code yields its bare digits too, so "INV-0258" and
 *     "invoice #0258" meet. The cost is that two unrelated things numbered
 *     0258 would merge; the benefit is that the same thing written two ways
 *     stops occupying two of the user's five slots. The merge is always
 *     visible — a grouped matter says how many messages it holds — so a wrong
 *     merge is obvious, where a missed one is not.
 */
export function referenceTokens(message: ScoredMailMessage): Set<string> {
  return referenceEvidence(message).tokens
}

interface ReferenceEvidence {
  tokens: Set<string>
  /** Prefix + digits identifiers. Distinct values are hard matter boundaries. */
  qualified: Set<string>
}

function referenceEvidence(message: ScoredMailMessage): ReferenceEvidence {
  const haystack = `${message.subject}\n${(message.body ?? message.preview ?? '').slice(0, REFERENCE_SCAN_CHARS)}`
  const tokens = new Set<string>()
  const qualified = new Set<string>()
  let references = 0

  for (const match of haystack.matchAll(REFERENCE)) {
    if (references >= MAX_REFERENCES) break
    const digits = (match[2] ?? match[3] ?? '').replace(/[-_/\s]/g, '')
    if (!digits) continue
    const prefix = match[1]?.toUpperCase()
    if (prefix) {
      const identifier = `${prefix}${digits}`
      tokens.add(identifier)
      qualified.add(identifier)
    }
    if (digits.length >= 4) tokens.add(digits)
    references += 1
  }

  return { tokens, qualified }
}

/** Prefixes people put in front of a subject when chasing the same thing. */
const SUBJECT_PREFIX =
  /^\s*(?:(re|fw|fwd|reminder|reminded|final notice|second notice|urgent|important|action required|follow[- ]?up|update|correction|revised|amended|copy)\s*[:\-–—]\s*)+/i

function normaliseSubject(subject: string): string {
  let text = subject
  // Stacked prefixes — "Re: Fwd: Reminder: …" — are stripped one layer at a
  // time, because a single pass leaves the inner ones behind.
  for (let i = 0; i < 5; i++) {
    const stripped = text.replace(SUBJECT_PREFIX, '')
    if (stripped === text) break
    text = stripped
  }
  return text
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function domainOf(address: string | undefined): string {
  const at = address?.lastIndexOf('@') ?? -1
  return at >= 0 ? address!.slice(at + 1).toLowerCase() : ''
}

/**
 * The key for a message that mentions no reference code.
 *
 *   1. The same distinctive subject, stripped of chasing prefixes. Three or
 *      more words of agreement is a strong signal, and it deliberately ignores
 *      the sender: the original and the chaser often come from different
 *      addresses at the same organisation.
 *   2. The conversation Microsoft itself threaded them into.
 *   3. A short subject, qualified by the sender's domain — "Update" from two
 *      people is two matters, not one.
 *
 * Subject beats conversation, not the other way round: Graph gives every
 * message a conversation id, so checking that first would make every rule
 * below it unreachable and leave a re-sent notice counted twice.
 */
export function matterKey(message: ScoredMailMessage): string {
  const subject = normaliseSubject(message.subject)
  const words = subject ? subject.split(' ').length : 0
  if (words >= 3 && subject.length >= 12) return `subj:${subject}`
  if (message.conversationId) return `conv:${message.accountId}:${message.conversationId}`
  if (words >= 2) return `subj:${subject}|${domainOf(message.from?.address)}`
  return `msg:${message.accountId}:${message.id}`
}

/**
 * Collapse messages into the matters they are about.
 *
 * Grouping is transitive, which a single key per message cannot express: a
 * notice carrying "INV-0258", a statement carrying "#0258", and a reply in the
 * first one's thread are all one matter, but no single key joins all three. So
 * messages are merged pairwise on any shared evidence — a reference in common,
 * or the same fallback key — and the connected sets become the matters.
 *
 * A message that mentions a reference is joined on references and its thread
 * only, never on its subject: two invoices from one supplier may well share the
 * words "Monthly invoice", and merging those would be worse than not grouping
 * at all.
 *
 * Input order is rank order — the caller ranks first — so the first message
 * seen in a set becomes its primary, and matters come back in the order their
 * most pressing message did.
 */
export function groupIntoMatters(messages: readonly ScoredMailMessage[]): MailMatter[] {
  const ranked = rankByAttention(messages)
  const parent = ranked.map((_, i) => i)
  const references = ranked.map(referenceEvidence)
  const qualifiedByRoot = references.map((evidence) => new Set(evidence.qualified))

  const find = (i: number): number => {
    let root = i
    while (parent[root] !== root) root = parent[root]!
    // Path compression keeps this linear over a long inbox.
    let walk = i
    while (parent[walk] !== root) {
      const next = parent[walk]!
      parent[walk] = root
      walk = next
    }
    return root
  }
  const union = (a: number, b: number): void => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA === rootB) return

    // A component may represent at most one qualified identifier. This makes
    // the boundary transitive: a shared thread, bare-number message or other
    // bridge cannot connect INV-1001 to INV-1002 indirectly.
    const combined = new Set([...qualifiedByRoot[rootA]!, ...qualifiedByRoot[rootB]!])
    if (combined.size > 1) return

    // The lower index wins, so the most pressing message stays the primary.
    const winner = Math.min(rootA, rootB)
    const loser = Math.max(rootA, rootB)
    parent[loser] = winner
    qualifiedByRoot[winner] = combined
  }

  const firstByToken = new Map<string, number>()
  const firstByKey = new Map<string, number>()

  ranked.forEach((message, index) => {
    const tokens = references[index]!.tokens
    for (const token of tokens) {
      const seen = firstByToken.get(`ref:${token}`)
      if (seen === undefined) firstByToken.set(`ref:${token}`, index)
      else union(seen, index)
    }

    // With a reference in hand, only the thread may add to it. Without one,
    // the subject and conversation rules apply.
    const key =
      tokens.size > 0
        ? message.conversationId
          ? `conv:${message.accountId}:${message.conversationId}`
          : `msg:${message.accountId}:${message.id}`
        : matterKey(message)

    const seen = firstByKey.get(key)
    if (seen === undefined) firstByKey.set(key, index)
    else union(seen, index)
  })

  const byRoot = new Map<number, MailMatter>()
  ranked.forEach((message, index) => {
    const root = find(index)
    const existing = byRoot.get(root)
    if (existing) {
      existing.related.push(message)
      existing.messages.push(message)
      for (const category of categoriseReasons(message.attention.reasons)) {
        if (!existing.categories.includes(category)) existing.categories.push(category)
      }
      return
    }
    byRoot.set(root, {
      key: `matter:${root}`,
      primary: message,
      related: [],
      messages: [message],
      score: message.attention.score,
      categories: categoriseReasons(message.attention.reasons)
    })
  })

  return [...byRoot.values()]
}

// ---------------------------------------------------------------------------
// Selection: a shortlist that is actually a shortlist of different problems
// ---------------------------------------------------------------------------

/**
 * How many matters to analyse.
 *
 * A number the user gave wins, clamped; otherwise a small default. Analysis is
 * the expensive path, so the default is deliberately a shortlist rather than
 * "everything retrieved".
 */
export function analysisLimit(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) {
    return DEFAULT_ANALYSIS_COUNT
  }
  return Math.min(Math.floor(requested), MAX_ANALYSIS_COUNT)
}

/** The category a matter counts as for diversity, or 'other' when it has none. */
function primaryCategory(matter: MailMatter): MatterCategory {
  return matter.categories[0] ?? 'other'
}

/**
 * Pick the shortlist, spreading it across different kinds of problem.
 *
 * Score alone produces a shortlist where one loud category eats every slot —
 * five overdue notices from one supplier, and nothing about the compliance
 * deadline or the client waiting on a decision. That is a worse answer than a
 * slightly lower-scoring spread, because the point of "the five most important"
 * is to survey what is on the user's plate.
 *
 * Each pick takes the highest-scoring matter from the least-used category, and
 * within that prefers a sender not already on the list. So the first pass is
 * one per category, and only once every category is represented does a second
 * item from one category get taken — which is how a category that genuinely
 * dominates still fills the list.
 */
export function diversify(matters: readonly MailMatter[], limit: number): MailMatter[] {
  const remaining = [...matters].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return b.primary.receivedAt - a.primary.receivedAt
  })

  const picked: MailMatter[] = []
  const categoryUse = new Map<MatterCategory, number>()
  const senderUse = new Map<string, number>()

  while (picked.length < limit && remaining.length > 0) {
    let bestIndex = 0
    let bestRank: [number, number] = [Infinity, Infinity]

    for (let i = 0; i < remaining.length; i++) {
      const matter = remaining[i]!
      const rank: [number, number] = [
        categoryUse.get(primaryCategory(matter)) ?? 0,
        senderUse.get(domainOf(matter.primary.from?.address)) ?? 0
      ]
      // `remaining` is already score-ordered, so a strict comparison keeps the
      // higher-scoring matter whenever two are equally fresh on both counts.
      if (rank[0] < bestRank[0] || (rank[0] === bestRank[0] && rank[1] < bestRank[1])) {
        bestRank = rank
        bestIndex = i
      }
      if (rank[0] === 0 && rank[1] === 0) break
    }

    const chosen = remaining.splice(bestIndex, 1)[0]!
    picked.push(chosen)
    const category = primaryCategory(chosen)
    const sender = domainOf(chosen.primary.from?.address)
    categoryUse.set(category, (categoryUse.get(category) ?? 0) + 1)
    senderUse.set(sender, (senderUse.get(sender) ?? 0) + 1)
  }

  return picked
}

/**
 * Choose what the model will see — deterministically, before any call.
 *
 * Rank, group into matters, then spread the shortlist across kinds of problem.
 * When the user asked what needs attention, messages that did not clear the bar
 * are excluded entirely rather than padded in to reach the requested count:
 * five is what they asked for, not a promise that five things matter.
 */
export function selectForAnalysis(
  messages: readonly ScoredMailMessage[],
  options: { requested?: number; attentionOnly: boolean }
): AnalysisSelection {
  const ranked = rankByAttention(messages)
  const attention = ranked.filter((m) => m.attention.needsAttention)
  const eligible = options.attentionOnly ? attention : ranked
  const matters = groupIntoMatters(eligible)
  const limit = analysisLimit(options.requested)
  const selected = diversify(matters, limit)

  // Each matter contributes its primary plus a little of its context, under a
  // ceiling that holds however many matters there are.
  // Give every selected matter one slot before adding related context. Filling
  // matter-by-matter allowed early threads to exhaust the global cap, after
  // which later selected matters had no excerpt and disappeared at synthesis.
  const candidates: ScoredMailMessage[] = selected
    .map((matter) => matter.primary)
    .slice(0, MAX_ANALYSIS_MESSAGES)
  for (let relatedIndex = 0; relatedIndex < MAX_RELATED_PER_MATTER; relatedIndex++) {
    for (const matter of selected) {
      if (candidates.length >= MAX_ANALYSIS_MESSAGES) break
      const related = matter.related[relatedIndex]
      if (related) candidates.push(related)
    }
  }

  return {
    matters: selected,
    candidates,
    attentionCount: attention.length,
    poolSize: matters.length,
    limit,
    attentionOnly: options.attentionOnly
  }
}

// ---------------------------------------------------------------------------
// Saying what Jarvis cannot know
// ---------------------------------------------------------------------------

/**
 * Things the analysed mail asserts that Jarvis has no way to check.
 *
 * Driven by the scoring reasons rather than by re-reading the text, so it stays
 * generic and stays in step with what the user was told about each message. The
 * prompt already forbids the model from claiming these; this states the limit
 * as a fact of the product, in Jarvis's own voice, whatever the model wrote.
 */
const UNVERIFIABLE: Array<{ category: MatterCategory; note: string }> = [
  { category: 'financial', note: 'whether these amounts have already been paid' },
  { category: 'compliance', note: 'where these compliance items currently stand' },
  { category: 'deadline', note: 'whether these deadlines have already been met' }
]

export function knowledgeCaveat(matters: readonly MailMatter[]): string | null {
  const present = new Set(matters.flatMap((m) => m.categories))
  const notes = UNVERIFIABLE.filter((u) => present.has(u.category)).map((u) => u.note)
  if (notes.length === 0) return null

  const list =
    notes.length === 1
      ? notes[0]!
      : `${notes.slice(0, -1).join(', ')} and ${notes[notes.length - 1]!}`
  return `This is what the emails say. I can only see your mail, not your accounts or records, so check ${list} before acting.`
}

// ---------------------------------------------------------------------------
// The instruction that goes with the excerpts
// ---------------------------------------------------------------------------

/**
 * Render the excerpts as matters rather than as a flat list.
 *
 * This is the whole point. The first version sent a flat numbered list and a
 * sentence asking the model to treat two of them as one; live, it wrote one
 * block per excerpt and the user's "five most important" came back as four
 * matters padded to five entries. A deterministic decision expressed only as a
 * request to a model is not a decision.
 *
 * So the grouping is in the shape of the payload. The model never sees a flat
 * list it could split along, and "one block per MATTER heading" is something it
 * can follow mechanically.
 */
export function renderMatters(
  matters: readonly { excerpts: readonly MailExcerpt[] }[]
): string {
  return matters
    .map((matter, i) => {
      const count = matter.excerpts.length
      const header =
        `=== MATTER ${i + 1} OF ${matters.length} — ${count} ${count === 1 ? 'message' : 'messages'}` +
        `${count > 1 ? ', analyse as ONE item' : ''} ===`
      const body = matter.excerpts.map((e) => `[${e.number}]\n${e.text}`).join('\n\n')
      return `${header}\n\n${body}`
    })
    .join('\n\n')
}

/**
 * The instruction sent alongside the matters.
 *
 * Short on purpose: the structure below it carries the grouping, so this only
 * has to say how many blocks to write and pass on what the user actually asked.
 */
export function analysisInstruction(question: string, matterCount: number): string {
  return [
    `The user asked: ${question}`,
    `Below are ${matterCount} ${matterCount === 1 ? 'matter' : 'distinct matters'}, in priority order, each under its own MATTER heading. Write exactly ${matterCount} ${matterCount === 1 ? 'block' : 'blocks'} — one per heading, in this order.`,
    'Use only what the excerpts contain, and stay inside the evidence boundary.'
  ].join('\n\n')
}

/**
 * The answer Jarvis writes itself when the model will not stay inside the
 * evidence boundary.
 *
 * Deliberately plain. It states who wrote, what the subject was, and that the
 * user should check the current position themselves — every word of which
 * Jarvis can stand behind without a model. Shown only after a correction round
 * has already failed, so it is rare, but it means a wrong claim is never the
 * thing the user reads.
 */
export function deterministicAnalysis(
  matters: readonly { matter: MailMatter; excerpts: readonly MailExcerpt[] }[]
): string {
  const blocks = matters.map(({ matter, excerpts }) => {
    const numbers = excerpts.map((e) => `[${e.number}]`).join(', ')
    const from =
      matter.primary.from?.name ?? matter.primary.from?.address ?? 'an unnamed sender'
    const extra =
      matter.messages.length > 1
        ? `\n${matter.messages.length} messages here refer to the same thing, and they may not agree — read them together.`
        : ''
    return (
      `**${matter.primary.subject || '(no subject)'}** ${numbers}\n` +
      `From: ${from}\n` +
      `Raised because: ${matter.primary.attention.reasons.join(', ') || 'it scored above the bar'}.` +
      `${extra}\n` +
      'Next step: read the messages below and confirm the current position against your own records.'
    )
  })

  return [
    'I could not write a summary I am able to stand behind, so here is what I can state plainly instead.',
    ...blocks
  ].join('\n\n')
}
