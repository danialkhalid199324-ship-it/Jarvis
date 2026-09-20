import type {
  AttentionAssessment,
  MailMessage,
  ScoredMailMessage
} from '../../shared/communication'

/**
 * Deciding what needs attention — without calling an AI model.
 *
 * Every signal here is a fact Microsoft already told us, or a pattern in text
 * Jarvis can check itself: free, instant, and explainable, so the user can see
 * why a message was raised rather than being asked to trust a model.
 *
 * The scoring separates two things that used to be added together, which is
 * what let a shop's "how did we do?" email outrank a compliance deadline:
 *
 *   ENGAGEMENT   unread, addressed to you, asks a question. Cheap to satisfy —
 *                marketing is *designed* to satisfy all of them.
 *   SIGNIFICANCE money, deadlines, compliance, decisions, a person asking you
 *                for something. Hard to fake, and what actually makes a message
 *                an executive's problem.
 *
 * Engagement alone can raise a message, but weakly and only when nothing marks
 * it as a mailing. Significance is what carries a message to the top, and it is
 * also what protects a genuine automated email — an overdue invoice from a
 * billing system — from being suppressed alongside the marketing.
 *
 * No business, sender or domain is hardcoded: the signals are generic, so a
 * brand-new client is treated exactly like an established one.
 */

/**
 * The kind of business matter a message is about.
 *
 * Deliberately broad. This is not a taxonomy of the user's work — it exists so
 * that an executive shortlist can spread across genuinely different kinds of
 * problem instead of being filled by five variations of the same one. It is
 * derived from the significance patterns below, so it cannot drift away from
 * the reasons the user is actually shown.
 */
export type MatterCategory =
  | 'financial'
  | 'compliance'
  | 'deadline'
  | 'decision'
  | 'request'
  | 'operational'
  | 'security'
  | 'agreement'
  | 'other'

/** A message at or above this score is surfaced as needing attention. */
export const ATTENTION_THRESHOLD = 3

/** Bulk evidence at or above this means a mailing rather than correspondence. */
const BULK_THRESHOLD = 2

/** Significance at or above this overrides bulk and automated-sender suppression. */
const SIGNIFICANCE_OVERRIDE = 4

/**
 * The least significance a message needs before it can be raised at all.
 *
 * Set at the weakest single significance signal, so one genuine business
 * marker is enough and no amount of engagement substitutes for it.
 */
const SIGNIFICANCE_FLOOR = 2

/** Signals that a message is genuinely someone's business problem. */
const SIGNIFICANCE_PATTERNS: Array<{
  pattern: RegExp
  points: number
  reason: string
  category: MatterCategory
}> = [
  {
    pattern: /\b(overdue|past due|final notice|arrears|unpaid)\b/i,
    points: 5,
    reason: 'overdue',
    category: 'financial'
  },
  {
    pattern: /\b(invoice|remittance|payment|amount due|outstanding balance|statement of account)\b/i,
    points: 4,
    reason: 'concerns payment',
    category: 'financial'
  },
  {
    pattern: /\b(audit|compliance|regulator\w*|breach|incident|non[- ]?conformance|corrective action|show cause)\b/i,
    points: 4,
    reason: 'concerns compliance',
    category: 'compliance'
  },
  {
    pattern: /\b(deadline|due (?:today|tomorrow|by|on)|expires?|closing date|cut[- ]?off|close of business|\bcob\b)/i,
    points: 4,
    reason: 'has a deadline',
    category: 'deadline'
  },
  {
    pattern: /\b(please (?:approve|sign|authorise|authorize)|approval required|sign[- ]?off|your decision|awaiting your)\b/i,
    points: 4,
    reason: 'waiting on your decision',
    category: 'decision'
  },
  {
    pattern: /\b(urgent|asap|immediately|critical|escalat\w+)\b/i,
    points: 4,
    reason: 'says it is urgent',
    // Urgency is a volume control, not a kind of problem: an urgent invoice is
    // still a financial matter. It deliberately carries no category of its own.
    category: 'other'
  },
  {
    pattern: /\b(security alert|suspicious (?:sign[- ]?in|activity|login|transaction)|unauthoris\w+ access|unrecognis\w+ device|password (?:reset|expir\w+|change)|multi[- ]?factor|\bmfa\b|two[- ]factor|verify your identity|account (?:locked|suspended|compromised|recovery))\b/i,
    points: 4,
    reason: 'security or account alert',
    category: 'security'
  },
  {
    pattern: /\b(complaint|dispute|cancellation|termination|outage|failure)\b/i,
    points: 3,
    reason: 'operational or relationship issue',
    category: 'operational'
  },
  {
    pattern: /\b(please (?:advise|review|respond|reply|provide|send|confirm)|could you please|can you please|i need|we need)\b/i,
    points: 3,
    reason: 'someone is asking you for something',
    category: 'request'
  },
  {
    pattern: /\b(contract|agreement|proposal|quote|tender|submission|renewal)\b/i,
    points: 2,
    reason: 'concerns an agreement',
    category: 'agreement'
  }
]

/**
 * Which kinds of business matter a set of scoring reasons points at.
 *
 * Reads straight off the pattern table above rather than re-matching text, so
 * the categories and the reasons the user is shown are the same judgement. A
 * reason that carries no category — "unread", "flagged by you" — contributes
 * nothing here, which is correct: those say how the message arrived, not what
 * it is about.
 */
export function categoriseReasons(reasons: readonly string[]): MatterCategory[] {
  const found: MatterCategory[] = []
  for (const { reason, category } of SIGNIFICANCE_PATTERNS) {
    if (category !== 'other' && reasons.includes(reason) && !found.includes(category)) {
      found.push(category)
    }
  }
  return found
}

/** Weak human-engagement signals. Useful for ordering, never for priority. */
const ENGAGEMENT_PATTERNS: Array<{ pattern: RegExp; points: number; reason: string }> = [
  { pattern: /\b(can you|could you|are you able|would you)\b/i, points: 1, reason: 'contains a request' },
  { pattern: /\?\s*$|\?\s/, points: 1, reason: 'asks a question' }
]

/**
 * Evidence that a message is a mailing rather than correspondence.
 *
 * Content is weighted above the sender address on purpose: plenty of things
 * worth reading arrive from `no-reply`, invoices and system alerts included.
 */
const BULK_PATTERNS: Array<{ pattern: RegExp; points: number }> = [
  {
    pattern: /\b(unsubscribe|manage (?:your )?preferences|view (?:this )?(?:email )?in (?:your )?browser|email preferences|opt out)\b/i,
    points: 3
  },
  {
    pattern: /\b(how did we do|rate your|review your (?:recent )?(?:purchase|order|experience|stay)|leave a review|tell us what you think|your feedback|take (?:our|the|a) (?:quick )?survey|share your (?:experience|thoughts))\b/i,
    points: 3
  },
  {
    pattern: /\b(\d+% off|sale (?:ends|now)|special offer|limited time|deal of the|discount code|free shipping|shop now|buy now)\b/i,
    points: 3
  },
  {
    // Product launches and retail announcements, which carry none of the
    // classic mailing vocabulary: "<product name> | OUT NOW" has no
    // unsubscribe line, no discount and no survey.
    pattern: /\b(out now|now available|new arrival|just landed|just dropped|pre[- ]?order|in stock|back in stock|launch(?:ing)? (?:today|now)|introducing (?:the|our)|meet the new|coming soon|new season|latest range)\b/i,
    points: 3
  },
  {
    pattern: /\b(newsletter|webinar|round[- ]?up|digest|bulletin)\b/i,
    points: 2
  },
  {
    pattern: /\b(deal|offer|promo\w*|clearance|bundle|gift card|rewards?|loyalty|exclusive (?:offer|access|preview)|members? (?:get|save|only)|save \$?\d+|from \$\d+|\$\d+ off)\b/i,
    points: 2
  },
  {
    pattern: /\b(you have \d+ new|new (?:connection|follower|notification)s?|someone (?:viewed|liked|commented)|don'?t miss|spare (?:a few|\d+) minutes?)\b/i,
    points: 2
  }
]

/**
 * Subjects written like an advertisement rather than a message.
 *
 * Two signals, both about form rather than words, so they hold for a product,
 * a service or a campaign in any industry: shouting, and the pipe-and-bullet
 * styling that marketing tools put between a product and its slogan. Neither
 * is conclusive alone, which is why each is worth less than the threshold.
 */
function campaignStyling(subject: string): number {
  let points = 0
  const shouted = subject.match(/\b[A-Z][A-Z0-9]{2,}\b/g) ?? []
  // Two or more shouted words, and not merely an acronym in a normal sentence.
  if (shouted.length >= 2 && shouted.join('').length >= 6) points += 2
  if (/[|•·★☆➤»]|\p{Extended_Pictographic}/u.test(subject)) points += 1
  return points
}

const BULK_SENDER =
  /(\bno-?reply|\bdo-?not-?reply|\bnoreply|\bnotifications?\b|\bnewsletters?\b|\bmarketing\b|\bmailer\b|\bcampaign\b|\bupdates?@|\bnews@|\bpromo|\binfo@)/i

export interface AttentionContext {
  /** The signed-in user's own addresses, to tell "to me" from "cc'd".  */
  ownAddresses: readonly string[]
  /** Now, injected so scoring is deterministic in tests. */
  now?: number
}

/**
 * Score one message. Pure and synchronous: no network, no model, no cost.
 */
export function assessAttention(
  message: MailMessage,
  context: AttentionContext
): AttentionAssessment {
  const reasons: string[] = []
  let engagement = 0
  let significance = 0
  let bulk = 0

  const own = context.ownAddresses.map((a) => a.toLowerCase())
  const isOwn = (address: string): boolean => own.includes(address.toLowerCase())
  const text = `${message.subject} ${message.preview}`
  const fromAddress = message.from?.address ?? ''
  const fromName = message.from?.name ?? ''

  // -- is this a mailing? ------------------------------------------------
  for (const { pattern, points } of BULK_PATTERNS) {
    if (pattern.test(text)) bulk += points
  }
  bulk += campaignStyling(message.subject)
  const looksAutomated = BULK_SENDER.test(fromAddress) || BULK_SENDER.test(fromName)
  if (looksAutomated) bulk += 1

  // -- does it actually matter? -----------------------------------------
  for (const { pattern, points, reason } of SIGNIFICANCE_PATTERNS) {
    if (pattern.test(text)) {
      significance += points
      reasons.push(reason)
    }
  }
  // Flagging is a deliberate act by the user, so it is a fact about the
  // business rather than something a sender can claim.
  if (message.isFlagged) {
    significance += 4
    reasons.push('flagged by you')
  }

  // A named human asking a direct question is a business matter even when it
  // uses none of the vocabulary above: "Can we move Thursday?" is work. It is
  // deliberately narrow — a person, not a system, and an actual question — so
  // that a campaign cannot reach it by putting a question mark in a subject.
  const fromPerson = !BULK_SENDER.test(fromAddress) && !BULK_SENDER.test(fromName) && /\s/.test(fromName.trim())
  if (fromPerson && /\?/.test(text) && bulk === 0) {
    significance += 2
    reasons.push('a person asked you something directly')
  }

  // -- engagement --------------------------------------------------------
  // Importance is set by the sender, so a mailing can assert it. It counts,
  // but only as engagement.
  if (message.importance === 'high') {
    engagement += 3
    reasons.push('marked high importance')
  }
  if (!message.isRead) {
    engagement += 2
    reasons.push('unread')
  }

  const addressedDirectly = message.to.some((r) => isOwn(r.address))
  const ccOnly = !addressedDirectly && message.cc.some((r) => isOwn(r.address))
  if (addressedDirectly) {
    engagement += 2
    reasons.push('addressed to you directly')
    if (message.to.length === 1) {
      engagement += 1
      reasons.push('you are the only recipient')
    }
  } else if (ccOnly) {
    engagement -= 1
    reasons.push('you were only copied in')
  }

  for (const { pattern, points, reason } of ENGAGEMENT_PATTERNS) {
    if (pattern.test(text)) {
      engagement += points
      reasons.push(reason)
    }
  }

  // A person writing to you personally outranks a system doing the same.
  if (!looksAutomated && /\s/.test(fromName.trim())) {
    engagement += 1
    reasons.push('from a named person')
  }

  const now = context.now ?? Date.now()
  const ageDays = (now - message.receivedAt) / 86_400_000
  if (!message.isRead && ageDays >= 2 && ageDays < 30) {
    engagement += 1
    reasons.push(`unread for ${Math.floor(ageDays)} days`)
  }

  // -- suppression -------------------------------------------------------
  const sentByUser = Boolean(fromAddress) && isOwn(fromAddress)
  if (sentByUser) reasons.push('sent by you')

  const isBulk = bulk >= BULK_THRESHOLD && significance < SIGNIFICANCE_OVERRIDE
  const unimportantAutomation = looksAutomated && significance < SIGNIFICANCE_OVERRIDE
  if (isBulk) reasons.push('looks like a marketing or notification mailing')
  else if (unimportantAutomation) reasons.push('automated sender')

  // Significance is doubled so that a real business matter outranks anything
  // that is merely unread and addressed to you.
  let score = significance * 2 + engagement
  if (unimportantAutomation) score -= 3
  if (isBulk) score -= 10

  // The rule that decides what "needs attention" means.
  //
  // Engagement alone used to be enough: unread (2) plus addressed to you (2)
  // plus sole recipient (1) is 5, comfortably over the bar, so every unread
  // message addressed to the user qualified — forty messages in, thirty-three
  // "needed attention", and a product launch sat among the compliance
  // deadlines. Those three facts describe how a message was *sent*, and a
  // marketing tool satisfies all of them by design.
  //
  // So attention now requires a reason the message is the user's problem:
  // either something significant in what it says, or the user's own flag,
  // which is the one signal a sender cannot manufacture. Engagement still
  // orders the list; it no longer admits anything to it.
  const significant = significance >= SIGNIFICANCE_FLOOR || message.isFlagged

  return {
    // Four things are never raised however they score: mail the user sent,
    // mail suppressed as a mailing, anything with no significant content, and
    // anything below the bar.
    needsAttention: !sentByUser && !isBulk && significant && score >= ATTENTION_THRESHOLD,
    score,
    reasons
  }
}

/**
 * Order a shortlist by how pressing each message is.
 *
 * Used by the analytical path to decide which candidates are worth spending
 * tokens on, before any model is involved.
 */
export function rankByAttention(messages: readonly ScoredMailMessage[]): ScoredMailMessage[] {
  return [...messages].sort((a, b) => {
    if (b.attention.score !== a.attention.score) return b.attention.score - a.attention.score
    return b.receivedAt - a.receivedAt
  })
}

/**
 * Order messages newest first, on a copy.
 *
 * Separate from scoring on purpose. "What needs my attention?" wants the most
 * pressing message at the top; a plain inbox, an unread list or a set of search
 * results want the most recent, because that is what a mail list means to
 * everyone who has ever used one. Both orderings are useful, so ranking and
 * chronology are kept as independent steps rather than one baked-in sort.
 *
 * The input is never mutated: callers routinely hold the array they pass in.
 * `Array.prototype.sort` is stable, so messages sharing a timestamp keep the
 * order they arrived in — which, for an already-scored list, means the more
 * pressing of the two stays on top.
 */
export function sortByNewest<T extends { receivedAt: number }>(messages: readonly T[]): T[] {
  return [...messages].sort((a, b) => b.receivedAt - a.receivedAt)
}

/**
 * Score a batch and return it ranked with the most pressing first.
 *
 * This is the attention ordering. For a chronological view, pass the result
 * through {@link sortByNewest} — the scores and reasons are preserved either
 * way, so badges and explanations are unaffected by which order is displayed.
 */
export function scoreMessages(
  messages: readonly MailMessage[],
  context: AttentionContext
): ScoredMailMessage[] {
  return messages
    .map((message) => ({ ...message, attention: assessAttention(message, context) }))
    .sort((a, b) => {
      if (b.attention.score !== a.attention.score) return b.attention.score - a.attention.score
      return b.receivedAt - a.receivedAt
    })
}

/** Only the messages that cleared the threshold. */
export function needingAttention(
  messages: readonly MailMessage[],
  context: AttentionContext
): ScoredMailMessage[] {
  return scoreMessages(messages, context).filter((m) => m.attention.needsAttention)
}

/**
 * Messages where the last word was someone else's.
 *
 * Approximate by design: Graph conversation state is not a reliable record of
 * whether the user replied, so this looks at who sent the most recent message
 * in each thread and says so honestly rather than claiming certainty.
 */
export function awaitingReply(
  messages: readonly MailMessage[],
  context: AttentionContext
): ScoredMailMessage[] {
  const own = context.ownAddresses.map((a) => a.toLowerCase())
  const latestPerThread = new Map<string, MailMessage>()

  for (const message of messages) {
    const key = message.conversationId || message.id
    const current = latestPerThread.get(key)
    if (!current || message.receivedAt > current.receivedAt) latestPerThread.set(key, message)
  }

  const inbound = [...latestPerThread.values()].filter((message) => {
    const from = message.from?.address?.toLowerCase()
    return from !== undefined && !own.includes(from)
  })

  return scoreMessages(inbound, context)
}
