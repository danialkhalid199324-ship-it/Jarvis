import type { ScoredMailMessage } from '../../../shared/communication'
import { rankByAttention } from '../../communication/mail-intelligence'

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
 * Nothing here calls a provider. It decides *what* is worth analysing and
 * *how the answer must be written*; the capability does the rest.
 */

/** How many messages to analyse when the user did not say. */
export const DEFAULT_ANALYSIS_COUNT = 5

/**
 * The ceiling on an analysis, whatever the user asks for.
 *
 * Lower than the routing ceiling on purpose: every item here costs tokens and
 * puts real email text in front of a model, so "summarise everything" has to
 * mean something bounded.
 */
export const MAX_ANALYSIS_COUNT = 10

/** Overall character budget for an analysis, regardless of provider settings. */
export const ANALYSIS_CONTEXT_CHARS = 16_000

/**
 * How the analysis must be written.
 *
 * The rules that matter most are the negative ones. An executive triage answer
 * is only worth reading if every deadline and amount in it is real, so the
 * prompt forbids filler rows ("Deadline: not specified") rather than trusting
 * the model to leave them out — an invented due date is far more damaging than
 * a missing line.
 */
export const MAIL_ANALYSIS_SYSTEM = `You are Jarvis, a private executive assistant triaging the user's own email.

You will be given numbered excerpts from emails that Jarvis has already retrieved and ranked. Follow these rules exactly.

1. Work ONLY from the excerpts. Never use outside knowledge about companies, people or events. Never invent a deadline, an amount, a name, a request or a degree of urgency that is not in the text.
2. Cover every excerpt you are given, in the order given, as its own short block. Do not merge them, drop them, or add any.
3. Write each block in this form, one item per line:

**<the subject, or the issue in a few words>** [excerpt number]
From: <sender name, or the address if no name is given>
What they want: <the key issue, one or two sentences>
Action required: <what the user has to do, concretely>
Deadline: <only if the email states a date, day or timeframe>
Amount: <only if the email states a figure>
Why it matters: <one sentence, grounded in what the email says>

4. Omit the Deadline line entirely when no deadline is stated, and the Amount line entirely when no figure is stated. Never write "not specified", "unknown", "N/A" or similar — a missing line is correct, a placeholder is not.
5. If an email asks for nothing, write "Action required: None — for information only."
6. Finish with one short line saying what to deal with first and why.
7. No greeting, no sign-off, no preamble, no restating of these instructions.
8. If none of the excerpts actually needs action, say so plainly in one sentence instead of manufacturing urgency.`

export interface AnalysisSelection {
  /** The messages to analyse, most pressing first. Never longer than the limit. */
  candidates: ScoredMailMessage[]
  /** How many of the retrieved messages cleared the attention bar. */
  attentionCount: number
  /** How many messages were eligible before the limit was applied. */
  poolSize: number
  /** The limit actually applied. */
  limit: number
  /** True when the user asked specifically about what needs attention. */
  attentionOnly: boolean
}

/**
 * How many items to analyse.
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

/**
 * Choose what the model will see — deterministically, before any call.
 *
 * Two separate jobs: rank by Jarvis's own attention scoring, then cut to a
 * bounded shortlist. When the user asked what needs attention, messages that
 * did not clear the bar are excluded entirely rather than padded in to reach
 * the requested count: five items is what they asked for, not a promise that
 * five things matter.
 */
export function selectForAnalysis(
  messages: readonly ScoredMailMessage[],
  options: { requested?: number; attentionOnly: boolean }
): AnalysisSelection {
  const ranked = rankByAttention(messages)
  const attention = ranked.filter((m) => m.attention.needsAttention)
  const pool = options.attentionOnly ? attention : ranked
  const limit = analysisLimit(options.requested)

  return {
    candidates: pool.slice(0, limit),
    attentionCount: attention.length,
    poolSize: pool.length,
    limit,
    attentionOnly: options.attentionOnly
  }
}

/**
 * The instruction sent alongside the excerpts.
 *
 * The user's own words are included so a specific request ("tell me who it is
 * from and what action I need to take") is honoured, but the count and the
 * grounding rule are restated from the deterministic selection rather than
 * inferred from the question.
 */
export function analysisInstruction(question: string, count: number): string {
  return (
    `The user asked: ${question}\n\n` +
    `Analyse the ${count} ${count === 1 ? 'email' : 'emails'} below, which Jarvis selected and ranked. ` +
    'They are already in priority order. Use only what they contain.'
  )
}
