/**
 * Deciding which capability answers a question.
 *
 * Deterministic on purpose. Routing is not a judgement call that deserves a
 * model call on every message: it is a cheap, instant, testable classification,
 * and keeping it free means the AI budget goes to summarising and drafting —
 * the things a model is actually good at.
 *
 * The rule that protects V0.1: **documents is the default**. A question only
 * leaves the document assistant if it clearly asks about mail or calendar, so
 * every phrasing that worked before still reaches exactly the same code.
 */

export type Capability = 'documents' | 'mail' | 'calendar' | 'brief'

export type MailIntent =
  /** "Check my emails" — list recent. */
  | 'list'
  /** "Summarise my unread emails". */
  | 'unread'
  /** "What needs my attention?" / "What needs a reply?" */
  | 'attention'
  /** "Any emails from Sarah?" / "Find the email about X". */
  | 'search'
  /** "What happened with the Bluebird invoice?" — read and answer. */
  | 'answer'
  /** "Draft a reply to ..." */
  | 'draft'

export type CalendarIntent =
  | 'today'
  | 'tomorrow'
  | 'week'
  | 'free'
  /** "Do I have anything at 2pm?" — read and answer. */
  | 'answer'
  | 'prepare_create'
  | 'prepare_update'
  | 'prepare_cancel'

export interface Route {
  capability: Capability
  mailIntent?: MailIntent
  calendarIntent?: CalendarIntent
  /** An account named in the question, e.g. "GTA" from "check my GTA emails". */
  accountHint?: string
  /** True when the user asked for every account explicitly. */
  allAccounts?: boolean
  /** The subject to search for, with the routing words stripped out. */
  searchTerms?: string
  /** Why this route was chosen. Surfaced in logs and tests, not to the user. */
  reason: string
}

export interface RoutingContext {
  /** Labels of connected Microsoft accounts, for "check my GTA emails". */
  accountLabels: readonly string[]
  /** True when a mail item is the current conversational subject. */
  hasMailContext?: boolean
  /** True when a calendar item is the current conversational subject. */
  hasCalendarContext?: boolean
}

// --- signal vocabularies ---------------------------------------------------

const MAIL_STRONG =
  /\b(e-?mails?|inbox|mailbox|mailboxes|unread|reply|replies|replied|sender|cc'?d|forwarded|correspondence)\b/i
const MAIL_WEAK = /\b(mail|messages?|wrote|sent me|heard (back )?from)\b/i

const CALENDAR_STRONG =
  /\b(calendars?|meetings?|appointments?|diary|agenda|schedule[sd]?|reschedul\w*|availabilit\w+|invite[sd]?)\b/i
const CALENDAR_WEAK = /\b(free|busy|booked|catch[- ]?up|stand[- ]?up|call)\b/i

/** Phrases that mean the calendar even without a calendar noun. */
const CALENDAR_PHRASES =
  /\b(what'?s on (today|tomorrow|this week|my)|what am i doing|when am i free|am i free|do i have anything|(what|how) (does|is) my (day|week)|what'?s my (day|week)|my (day|week) look)/i

/**
 * Asking to change the diary. On its own "move" or "cancel" is ambiguous, so
 * it only counts as a calendar signal alongside something meeting-shaped — a
 * meeting noun, a day, or a time of day.
 */
const CALENDAR_ACTION_VERB = /\b(book|schedule|reschedul\w*|move|shift|postpone|bring forward|push|cancel|call off|set up|arrange|organis[ez]e)\b/i
const MEETING_CONTEXT =
  /\b(meetings?|calls?|appointments?|catch[- ]?ups?|stand[- ]?ups?|invites?|events?|today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week)\b|\b\d{1,2}\s*(:\d{2})?\s*(am|pm)\b/i

const DOCUMENT_STRONG =
  /\b(files?|documents?|folders?|pdfs?|docx?|spreadsheets?|on my (mac|computer|disk|drive)|locally)\b/i

const BRIEF = /\b(daily brief|morning brief|evening brief|brief me|my brief|what'?s my day|brief for today)\b/i

// --- mail sub-intents ------------------------------------------------------

const DRAFT_INTENT = /\b(draft|write|compose|reply to|respond to|answer)\b.*\b(e-?mail|reply|message|back)\b|\b(draft|compose)\b/i
const ATTENTION_INTENT =
  /\b(need(s|ing)? (my )?(attention|a reply|replying|response)|important|urgent|follow[- ]?up|outstanding|waiting on)/i
const UNREAD_INTENT = /\bunread\b/i
const SEARCH_INTENT = /\b(find|search|look for|any (e-?mails?|messages?)|from [A-Z]|about)\b/i
const ANSWER_INTENT =
  /\b(what happened|summaris\w*|summariz\w*|what did|what does|explain|status of|where (are|is) (we|things)|catch me up)/i

// --- calendar sub-intents --------------------------------------------------

const TOMORROW = /\btomorrow'?s?\b/i
const TODAY = /\b(today'?s?|this morning|this afternoon|this evening|tonight)\b/i
const WEEK = /\b(this week|next week|the week|my week|coming (week|days)|rest of the week)\b/i
const FREE = /\b(free|available|availability|gap|open slot|spare time)\b/i
const CREATE = /\b(book|schedule|set up|create|arrange|organis[ez]e|put in)\b.*\b(meeting|call|appointment|time|catch[- ]?up)\b/i
const UPDATE = /\b(move|reschedul\w*|shift|change|push|bring forward|postpone)\b/i
const CANCEL = /\b(cancel|call off|drop|delete)\b.*\b(meeting|call|appointment|event|invite)\b|\bcancel (the|my|tomorrow'?s)\b/i

const ALL_ACCOUNTS = /\b(all (my )?accounts?|every account|across (all|my) accounts?|all mailboxes)\b/i

/** Words stripped when turning a question into a search term. */
const SEARCH_NOISE =
  /\b(find|search( for)?|look for|show me|get me|any|the|an?|my|me|about|regarding|re|please|can you|could you|e-?mails?|emails?|messages?|mail|inbox|from|in|on|for)\b/gi

function extractSearchTerms(question: string): string | undefined {
  // Quoted text is taken literally — the user was explicit.
  const quoted = /["“']([^"”']{3,})["”']/.exec(question)
  if (quoted) return quoted[1]!.trim()

  const afterAbout = /\b(?:about|regarding|concerning|re:?)\s+(.{3,})/i.exec(question)
  const candidate = afterAbout ? afterAbout[1]! : question

  const cleaned = candidate
    .replace(/[?.!]+$/g, '')
    .replace(SEARCH_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned.length >= 2 ? cleaned : undefined
}

const TIME_WORDS =
  /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|yesterday|tomorrow|last|this|next)$/i

/**
 * The person a question is about.
 *
 * Covers both directions a request can be phrased: "any emails **from** Sarah"
 * and "draft a reply **to** Sarah". Capitalisation is the signal, so a day or a
 * filler word at the start of a sentence is filtered out explicitly.
 */
export function extractSenderName(question: string): string | undefined {
  const match =
    /\b(?:from|reply to|respond to|write to|replying to|answer)\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)?)/.exec(
      question
    )
  const name = match?.[1]?.trim()
  // "from Monday" and similar are time words, not people.
  if (!name || TIME_WORDS.test(name)) return undefined
  return name
}

function findAccountHint(question: string, labels: readonly string[]): string | undefined {
  const lower = question.toLowerCase()
  // Longest label first, so "GTA Security" wins over "GTA".
  const sorted = [...labels].sort((a, b) => b.length - a.length)
  for (const label of sorted) {
    const token = label.trim().toLowerCase()
    if (!token) continue
    const pattern = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (pattern.test(lower)) return label
  }
  return undefined
}

function mailIntentFor(question: string): MailIntent {
  if (DRAFT_INTENT.test(question)) return 'draft'
  if (ATTENTION_INTENT.test(question)) return 'attention'
  if (ANSWER_INTENT.test(question)) return 'answer'
  if (UNREAD_INTENT.test(question)) return 'unread'
  if (SEARCH_INTENT.test(question)) return 'search'
  return 'list'
}

function calendarIntentFor(question: string): CalendarIntent {
  if (CANCEL.test(question)) return 'prepare_cancel'
  if (UPDATE.test(question)) return 'prepare_update'
  if (CREATE.test(question)) return 'prepare_create'
  if (FREE.test(question)) return 'free'
  if (WEEK.test(question)) return 'week'
  if (TOMORROW.test(question)) return 'tomorrow'
  if (TODAY.test(question)) return 'today'
  // "Do I have anything at 2pm?" and similar need a real lookup and an answer.
  if (/\bat\s+\d|\b\d{1,2}\s*(am|pm)\b/i.test(question)) return 'answer'
  return 'today'
}

/**
 * Classify a question.
 *
 * Scores each capability from its vocabulary and takes the clear winner.
 * Anything that is not clearly mail or calendar stays with documents, which is
 * what keeps every V0.1 question behaving exactly as it did.
 */
export function routeQuestion(question: string, context: RoutingContext): Route {
  const text = question.trim()

  if (BRIEF.test(text)) {
    return { capability: 'brief', reason: 'asked for the daily brief' }
  }

  let mail = 0
  let calendar = 0
  let documents = 0

  if (MAIL_STRONG.test(text)) mail += 3
  if (MAIL_WEAK.test(text)) mail += 1
  if (CALENDAR_STRONG.test(text)) calendar += 3
  if (CALENDAR_PHRASES.test(text)) calendar += 3
  if (CALENDAR_WEAK.test(text)) calendar += 1
  if (CALENDAR_ACTION_VERB.test(text) && MEETING_CONTEXT.test(text)) calendar += 3
  if (DOCUMENT_STRONG.test(text)) documents += 3

  // A follow-up with no subject of its own stays where the conversation is.
  const isFollowUp = /\b(it|that|this|those|them|they)\b/i.test(text) && text.split(/\s+/).length <= 8
  if (isFollowUp && context.hasMailContext) mail += 3
  if (isFollowUp && context.hasCalendarContext) calendar += 3

  const accountHint = findAccountHint(text, context.accountLabels)
  // Naming a connected account is a communication signal, but a weak one: a
  // folder may well be named after the same business.
  if (accountHint) {
    mail += 1
    calendar += 1
  }

  const allAccounts = ALL_ACCOUNTS.test(text)
  if (allAccounts) mail += 2

  // Documents wins ties and wins by default. This is deliberate: V0.1 must
  // never lose a question to a capability that was not clearly asked for.
  if (mail >= 3 && mail >= calendar && mail > documents) {
    const intent = mailIntentFor(text)
    const route: Route = {
      capability: 'mail',
      mailIntent: intent,
      reason: `mail vocabulary (score ${mail})`
    }
    if (accountHint) route.accountHint = accountHint
    if (allAccounts) route.allAccounts = true
    if (intent === 'search' || intent === 'answer') {
      const terms = extractSearchTerms(text)
      if (terms) route.searchTerms = terms
    }
    return route
  }

  if (calendar >= 3 && calendar > documents) {
    const route: Route = {
      capability: 'calendar',
      calendarIntent: calendarIntentFor(text),
      reason: `calendar vocabulary (score ${calendar})`
    }
    if (accountHint) route.accountHint = accountHint
    return route
  }

  return {
    capability: 'documents',
    reason:
      documents > 0
        ? 'explicit document vocabulary'
        : 'no clear mail or calendar signal — local documents is the default'
  }
}
