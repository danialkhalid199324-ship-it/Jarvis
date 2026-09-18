import type {
  AttentionAssessment,
  MailMessage,
  ScoredMailMessage
} from '../../shared/communication'

/**
 * Deciding what needs attention — without calling an AI model.
 *
 * Every signal here is a fact Microsoft already told us, or a pattern in text
 * Jarvis can check itself. That matters for three reasons: it is free, it is
 * instant, and it is explainable — the user can see exactly why a message was
 * raised rather than being asked to trust a model's judgement.
 *
 * AI is used afterwards, on the short list this produces, to summarise and
 * prioritise. It is never used to do the filtering.
 */

/** A message at or above this score is surfaced as needing attention. */
export const ATTENTION_THRESHOLD = 3

const URGENCY_PATTERNS: Array<{ pattern: RegExp; points: number; reason: string }> = [
  { pattern: /\b(urgent|asap|immediately)\b/i, points: 3, reason: 'says it is urgent' },
  { pattern: /\b(deadline|due (today|tomorrow|by)|overdue)\b/i, points: 3, reason: 'mentions a deadline' },
  { pattern: /\b(please (confirm|advise|review|approve|respond|reply))\b/i, points: 2, reason: 'asks you to respond' },
  { pattern: /\b(can you|could you|are you able|would you)\b/i, points: 1, reason: 'contains a request' },
  { pattern: /\b(invoice|payment|remittance|overdue account)\b/i, points: 1, reason: 'concerns payment' },
  { pattern: /\b(audit|compliance|breach|incident|notice)\b/i, points: 1, reason: 'concerns compliance' },
  { pattern: /\?\s*$|\?\s/, points: 1, reason: 'asks a question' }
]

/** Senders whose mail is almost never actionable. */
const LOW_VALUE_SENDER = /\b(no-?reply|do-?not-?reply|notifications?|mailer|newsletter|marketing|automated)\b/i
const BULK_SUBJECT = /\b(unsubscribe|newsletter|webinar|special offer|% off|sale ends)\b/i

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
  let score = 0

  const own = context.ownAddresses.map((a) => a.toLowerCase())
  const isOwn = (address: string): boolean => own.includes(address.toLowerCase())

  // -- what Microsoft told us -------------------------------------------
  if (!message.isRead) {
    score += 2
    reasons.push('unread')
  }
  if (message.importance === 'high') {
    score += 3
    reasons.push('marked high importance')
  }
  if (message.isFlagged) {
    score += 3
    reasons.push('flagged by you')
  }

  // -- who it was sent to ------------------------------------------------
  const addressedDirectly = message.to.some((r) => isOwn(r.address))
  const ccOnly = !addressedDirectly && message.cc.some((r) => isOwn(r.address))
  if (addressedDirectly) {
    score += 2
    reasons.push('addressed to you directly')
    // A message to you alone is more pointed than one to a distribution list.
    if (message.to.length === 1) {
      score += 1
      reasons.push('you are the only recipient')
    }
  } else if (ccOnly) {
    score -= 1
    reasons.push('you were only copied in')
  }

  // -- what it says ------------------------------------------------------
  const text = `${message.subject} ${message.preview}`
  for (const { pattern, points, reason } of URGENCY_PATTERNS) {
    if (pattern.test(text)) {
      score += points
      reasons.push(reason)
    }
  }

  // -- what it plainly is not -------------------------------------------
  const fromAddress = message.from?.address ?? ''
  if (LOW_VALUE_SENDER.test(fromAddress) || LOW_VALUE_SENDER.test(message.from?.name ?? '')) {
    score -= 4
    reasons.push('automated sender')
  }
  if (BULK_SUBJECT.test(text)) {
    score -= 3
    reasons.push('looks like a bulk mailing')
  }
  // Mail you sent is never waiting on your reply, whatever else it contains.
  const sentByUser = Boolean(fromAddress) && isOwn(fromAddress)
  if (sentByUser) {
    score -= 3
    reasons.push('sent by you')
  }

  // -- how long it has been waiting -------------------------------------
  const now = context.now ?? Date.now()
  const ageDays = (now - message.receivedAt) / 86_400_000
  if (!message.isRead && ageDays >= 2 && ageDays < 30) {
    score += 1
    reasons.push(`unread for ${Math.floor(ageDays)} days`)
  }

  return {
    // A message from the user themselves is a note, not a request, so it is
    // never raised no matter how urgent its wording.
    needsAttention: !sentByUser && score >= ATTENTION_THRESHOLD,
    score,
    reasons
  }
}

/** Score a batch and return it sorted with the most pressing first. */
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
