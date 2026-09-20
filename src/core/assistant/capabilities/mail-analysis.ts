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

You will be given numbered excerpts from emails that Jarvis has already retrieved, grouped and ranked. Follow these rules exactly.

1. Work ONLY from the excerpts. Never use outside knowledge about companies, people or events. Never invent a deadline, an amount, a name, a request or a degree of urgency that is not in the text.
2. You will be told which excerpts belong to the same matter. Write ONE block per matter, in the order given — never one block per excerpt. Where a matter has several excerpts, analyse them together, and say plainly that more than one message exists about it, including any way they differ from each other.
3. Write each block in this form, one item per line:

**<the subject, or the issue in a few words>** [excerpt numbers]
From: <sender name, or the address if no name is given>
What they want: <the key issue, one or two sentences>
Action required: <what the user has to do, concretely>
Deadline: <only if an email states a date, day or timeframe>
Amount: <only if an email states a figure>
Why it matters: <one sentence, grounded in what the emails say>

4. Omit the Deadline line entirely when no deadline is stated, and the Amount line entirely when no figure is stated. Never write "not specified", "unknown", "N/A" or similar — a missing line is correct, a placeholder is not.
5. Report what the emails SAY, never a state of the world you cannot see. You can read the user's mail. You cannot see their bank, their accounting system, their records, their filing, or anyone else's inbox. So you must never assert that money is still owed, that a bill is unpaid, that a task was not done, that a deadline was missed, or that anything remains outstanding — the email is evidence of what was sent, not of what is true now.
6. Therefore, for anything financial, the action is to review the invoice, confirm its payment status against the user's own records, reconcile it, and arrange payment only if it turns out to still be outstanding. Write "the invoice states an amount due of X — confirm whether it has already been paid" rather than "pay the outstanding amount". Apply the same care to deadlines and compliance: "confirm this was submitted", not "you have not submitted this".
7. If an email asks for nothing, write "Action required: None — for information only."
8. Finish with one short line saying what to deal with first and why.
9. No greeting, no sign-off, no preamble, no restating of these instructions.
10. If none of the excerpts actually needs action, say so plainly in one sentence instead of manufacturing urgency.`

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
 * A reference code in a subject line.
 *
 * Generic by construction: letters followed by a run of digits, or a digit run
 * explicitly introduced as a number or reference. That covers invoice numbers,
 * ticket ids, case numbers, purchase orders and claim references without this
 * module knowing what any of them are. A bare year or a plain figure does not
 * match, which is what keeps "due 30 September 2026" from becoming a key.
 */
const REFERENCE =
  /\b([A-Z]{2,6}[-_/ ]?\d{3,}(?:[-_/]\d+)?)\b|(?:#|\bno\.?\s*|\bref(?:erence)?\.?\s*[:.]?\s*)(\d{4,})\b/i

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
 * What makes two messages the same matter.
 *
 * In order of confidence:
 *
 *   1. A reference code shared between subjects. Two notices about the same
 *      numbered thing are the same thing, even when they arrive as separate
 *      threads from different addresses — which is exactly the case where
 *      counting them separately does the most damage, because conflicting
 *      notices about one reference are a problem the user needs told about.
 *   2. The same distinctive subject, stripped of chasing prefixes. Three or
 *      more words of agreement is a strong signal, and it deliberately ignores
 *      the sender: the original and the chaser often come from different
 *      addresses at the same organisation, or from different people entirely.
 *   3. The conversation Microsoft itself threaded them into.
 *   4. A short subject, qualified by the sender's domain — "Update" from two
 *      people is two matters, not one.
 *
 * Subject beats conversation, not the other way round: Graph gives every
 * message a conversation id, so checking that first would make every other
 * rule below it unreachable and leave a re-sent notice counted twice.
 *
 * A message matching none of these is its own matter. Nothing here knows what
 * an invoice, a business or a sender is.
 */
export function matterKey(message: ScoredMailMessage): string {
  const match = REFERENCE.exec(message.subject)
  const reference = (match?.[1] ?? match?.[2])?.replace(/[-_/\s]/g, '').toUpperCase()
  if (reference) return `ref:${reference}`

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
 * Input order is preserved as rank order: the caller ranks first, so the first
 * message seen for a key becomes that matter's primary, and matters come back
 * in the order their most pressing message did.
 */
export function groupIntoMatters(messages: readonly ScoredMailMessage[]): MailMatter[] {
  const byKey = new Map<string, MailMatter>()

  for (const message of rankByAttention(messages)) {
    const key = matterKey(message)
    const existing = byKey.get(key)
    if (existing) {
      existing.related.push(message)
      existing.messages.push(message)
      for (const category of categoriseReasons(message.attention.reasons)) {
        if (!existing.categories.includes(category)) existing.categories.push(category)
      }
      continue
    }
    byKey.set(key, {
      key,
      primary: message,
      related: [],
      messages: [message],
      score: message.attention.score,
      categories: categoriseReasons(message.attention.reasons)
    })
  }

  return [...byKey.values()]
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
  const candidates: ScoredMailMessage[] = []
  for (const matter of selected) {
    for (const message of matter.messages.slice(0, 1 + MAX_RELATED_PER_MATTER)) {
      if (candidates.length >= MAX_ANALYSIS_MESSAGES) break
      candidates.push(message)
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
 * The instruction sent alongside the excerpts.
 *
 * The user's own words are included so a specific request ("tell me who it is
 * from and what action I need to take") is honoured, but the grouping and the
 * count are restated from the deterministic selection rather than inferred from
 * the question — the model is told what Jarvis decided, not asked to decide it.
 */
export function analysisInstruction(question: string, groups: readonly (readonly number[])[]): string {
  const lines = groups.map(
    (numbers, i) =>
      `- Matter ${i + 1}: ${numbers.length === 1 ? 'excerpt' : 'excerpts'} ${numbers
        .map((n) => `[${n}]`)
        .join(', ')}`
  )
  const multiple = groups.filter((g) => g.length > 1).length

  return [
    `The user asked: ${question}`,
    `Jarvis grouped the emails below into ${groups.length} ${
      groups.length === 1 ? 'matter' : 'distinct matters'
    }, already in priority order. Write one block per matter, in this order:`,
    lines.join('\n'),
    multiple > 0
      ? `${multiple === 1 ? 'One matter has' : `${multiple} matters have`} more than one message. Analyse each such matter as a single item, and say plainly that several messages exist about it and how they differ.`
      : 'Each matter has one message.',
    'Use only what the excerpts contain.'
  ].join('\n\n')
}
