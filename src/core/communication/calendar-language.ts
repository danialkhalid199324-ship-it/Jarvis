import { addDays, startOfDay } from './time'

/**
 * Reading calendar instructions written the way people actually write them.
 *
 * The hard part is not finding a time or a duration — it is telling apart the
 * one that *identifies* an event from the one that *changes* it. "Move my 7 PM
 * meeting to 8 PM" contains two times; "change my 7 PM meeting that runs for
 * half an hour to 1 hour" contains two durations. Reading the first of each is
 * how you end up proposing a change that changes nothing.
 *
 * Every function here is pure. No Graph, no clock of its own, no state.
 */

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

/** A duration found in a sentence, with enough context to know its role. */
export interface DurationPhrase {
  minutes: number
  /** Character offset of the match. */
  index: number
  /** Preceded by a change verb — "change it to", "make it", "extend to". */
  requested: boolean
  /** Followed by "longer"/"shorter" — a relative adjustment. */
  delta: 0 | 1 | -1
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, an: 1, a: 1
}

/**
 * Marks a duration as the *new* value rather than a description of the current
 * one. "to" is included because "change to 1 hour" is how most people say it.
 */
const CHANGE_MARKER =
  /\b(?:change(?:d|s)?(?:\s+it)?\s+to|make(?:s)?(?:\s+it)?|set(?:\s+it)?\s+to|extend(?:ed)?(?:\s+it)?(?:\s+to)?|shorten(?:ed)?(?:\s+it)?(?:\s+to)?|reduce(?:d)?(?:\s+it)?\s+to|turn(?:\s+it)?\s+into|into|to)\s+(?:a\s+|an\s+)?$/i

/** Follows a duration to make it relative: "30 minutes longer". */
const DELTA_SUFFIX = /^\s*(longer|shorter|more|less|extra)\b/i

/**
 * Every duration in a sentence, in order.
 *
 * Ordered longest-pattern-first so "an hour and a half" is not read as "an
 * hour" followed by a stray "half".
 */
export function parseDurationPhrases(text: string): DurationPhrase[] {
  const patterns: Array<{ re: RegExp; minutes: (m: RegExpExecArray) => number }> = [
    // "1 hour 30 minutes", "2 hours and 15 mins"
    {
      re: /\b(\d+)\s*(?:hours?|hrs?)\s*(?:and\s+)?(\d+)\s*(?:minutes?|mins?)\b/gi,
      minutes: (m) => Number(m[1]) * 60 + Number(m[2])
    },
    // "an hour and a half", "one and a half hours"
    {
      re: /\b(?:an?|one)\s+(?:hour\s+and\s+a\s+half|and\s+a\s+half\s+hours?)\b/gi,
      minutes: () => 90
    },
    { re: /\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/gi, minutes: (m) => Math.round(Number(m[1]) * 60) },
    { re: /\bhalf\s+(?:an?\s+)?hour\b/gi, minutes: () => 30 },
    {
      re: /\b(one|two|three|four|five|six|seven|eight|nine|ten|an?)\s+(?:hours?|hrs?)\b/gi,
      minutes: (m) => (WORD_NUMBERS[m[1]!.toLowerCase()] ?? 1) * 60
    },
    { re: /\b(\d+)\s*(?:minutes?|mins?|m)\b/gi, minutes: (m) => Number(m[1]) },
    {
      re: /\b(one|two|three|four|five|ten|fifteen|twenty|thirty|forty|forty-five|fifty|sixty)\s+(?:minutes?|mins?)\b/gi,
      minutes: (m) => {
        const words: Record<string, number> = {
          one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15,
          twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, fifty: 50, sixty: 60
        }
        return words[m[1]!.toLowerCase()] ?? 0
      }
    }
  ]

  const found: DurationPhrase[] = []
  const claimed: Array<[number, number]> = []

  for (const { re, minutes } of patterns) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const start = m.index
      const end = start + m[0].length
      // A longer pattern already covered this span.
      if (claimed.some(([s, e]) => start < e && end > s)) continue
      claimed.push([start, end])

      const value = minutes(m)
      if (value <= 0) continue

      const before = text.slice(0, start)
      const after = text.slice(end)
      const deltaMatch = DELTA_SUFFIX.exec(after)
      const direction = deltaMatch
        ? /shorter|less/i.test(deltaMatch[1]!)
          ? -1
          : 1
        : 0

      found.push({
        minutes: value,
        index: start,
        requested: CHANGE_MARKER.test(before),
        delta: direction as 0 | 1 | -1
      })
    }
  }

  return found.sort((a, b) => a.index - b.index)
}

/** The single duration in a sentence, when there is one. */
export function parseDuration(text: string): number | null {
  const phrases = parseDurationPhrases(text)
  return phrases.length > 0 ? phrases[0]!.minutes : null
}

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

export interface TimePhrase {
  /** Minutes since midnight. */
  minutes: number
  index: number
  /** Preceded by "to"/"until" — where the event should move *to*. */
  target: boolean
}

/** "…to 8 PM" and "…until 8pm" mark a destination rather than a reference. */
const TARGET_MARKER = /\b(?:to|til|till|until|→)\s*(?:around\s+|about\s+)?$/i

/**
 * Every clock time in a sentence, in order.
 *
 * Deliberately separate from duration parsing: "for 30 minutes" is not 30
 * past the hour, and "1 hour" is not 1 o'clock.
 */
export function parseTimePhrases(text: string): TimePhrase[] {
  const found: TimePhrase[] = []
  const claimed: Array<[number, number]> = []

  const push = (minutes: number, index: number, length: number): void => {
    if (minutes < 0 || minutes > 23 * 60 + 59) return
    if (claimed.some(([s, e]) => index < e && index + length > s)) return
    claimed.push([index, index + length])
    found.push({ minutes, index, target: TARGET_MARKER.test(text.slice(0, index)) })
  }

  // "7pm", "7:30 pm", "7 p.m."
  const meridiem = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\.?\b/gi
  let m: RegExpExecArray | null
  while ((m = meridiem.exec(text)) !== null) {
    let hour = Number(m[1])
    const minute = m[2] ? Number(m[2]) : 0
    if (hour > 12 || minute > 59) continue
    const isPm = m[3]!.toLowerCase() === 'p'
    if (hour === 12) hour = 0
    if (isPm) hour += 12
    push(hour * 60 + minute, m.index, m[0].length)
  }

  // "15:00" — a colon makes it unambiguous.
  const twentyFour = /\b(\d{1,2}):(\d{2})\b/g
  while ((m = twentyFour.exec(text)) !== null) {
    push(Number(m[1]) * 60 + Number(m[2]), m.index, m[0].length)
  }

  // "at 3" / "to 3" — a bare hour only counts when a preposition introduces it,
  // so "30 minutes" and "1 hour" are never read as times.
  const bare = /\b(?:at|to|til|till|until|from)\s+(\d{1,2})\b(?!\s*(?::|\d|%|minutes?|mins?|hours?|hrs?|h\b|m\b))/gi
  while ((m = bare.exec(text)) !== null) {
    const hour = Number(m[1])
    if (hour < 1 || hour > 23) continue
    // Business hours read naturally: "at 3" means the afternoon.
    const normalised = hour >= 1 && hour <= 7 ? hour + 12 : hour
    const index = m.index + m[0].length - m[1]!.length
    push(normalised * 60, index, m[1]!.length)
  }

  return found.sort((a, b) => a.index - b.index)
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export interface DayPhrase {
  /** Local midnight of the day referred to. */
  dayStart: number
  index: number
  target: boolean
}

/** Every day reference in a sentence, in order. */
export function parseDayPhrases(text: string, now: number): DayPhrase[] {
  const found: DayPhrase[] = []

  const push = (dayStart: number, index: number): void => {
    found.push({ dayStart, index, target: TARGET_MARKER.test(text.slice(0, index)) })
  }

  for (const m of text.matchAll(/\b(today|tonight|tomorrow|yesterday)\b/gi)) {
    const word = m[1]!.toLowerCase()
    const offset = word === 'tomorrow' ? 1 : word === 'yesterday' ? -1 : 0
    push(startOfDay(addDays(now, offset)), m.index)
  }

  for (const m of text.matchAll(new RegExp(`\\b(${WEEKDAYS.join('|')})\\b`, 'gi'))) {
    const target = WEEKDAYS.indexOf(m[1]!.toLowerCase())
    const today = new Date(now).getDay()
    // The next occurrence; naming today's weekday means a week from now.
    const delta = (target - today + 7) % 7 || 7
    push(startOfDay(addDays(now, delta)), m.index)
  }

  return found.sort((a, b) => a.index - b.index)
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

/** Words that end a title because what follows is when, not what. */
const WHEN_BOUNDARY =
  /\s+\b(?:tomorrow|today|tonight|yesterday|on|at|for|from|starting|start(?:s|ing)?|next|this|coming|monday|tuesday|wednesday|thursday|friday|saturday|sunday|in|with|to)\b/i

/** A "title" that is really just the word for a meeting carries no information. */
const GENERIC_TITLE =
  /^(?:a|an|the|my|new)?\s*(?:new\s+)?(?:meeting|call|appointment|catch[- ]?up|event|entry|reminder|session)s?$/i

function cleanTitle(raw: string): string | null {
  let title = raw.trim().replace(/^["'“”']+|["'“”'.,!?]+$/g, '').trim()
  const boundary = WHEN_BOUNDARY.exec(title)
  if (boundary) title = title.slice(0, boundary.index).trim()
  title = title.replace(/[.,!?]+$/, '').trim()
  if (!title || GENERIC_TITLE.test(title)) return null
  // A lone lowercase word is almost certainly a fragment, not a title.
  if (title.length < 2) return null
  return title
}

/**
 * The title the user gave a new meeting, or null when they gave none.
 *
 * Returning null matters: a fabricated title is worse than an obvious
 * placeholder the user can see and correct in the approval card.
 */
export function parseEventTitle(text: string): string | null {
  // Quoted text is taken literally — the user was explicit.
  const quoted = /["“']([^"”']{2,})["”']/.exec(text)
  if (quoted) {
    const title = cleanTitle(quoted[1]!)
    if (title) return title
  }

  // "…called X", "…titled X", "…named X" — the clearest signal, so it wins.
  // "for" is deliberately absent: it introduces a day or a length far more
  // often than a title, and reading "for Tuesday at 3 PM" as a title is worse
  // than having no title at all.
  const called = /\b(?:called|titled|named|entitled)\s+["“']?([^"”']+)$/i.exec(text)
  if (called) {
    const title = cleanTitle(called[1]!)
    if (title) return title
  }

  // "Add X to my calendar", "Put X in my diary"
  const added = /\b(?:add|put)\s+(.+?)\s+(?:to|in|on)\s+(?:my\s+)?(?:calendar|diary|schedule)\b/i.exec(text)
  if (added) {
    const title = cleanTitle(added[1]!)
    if (title) return title
  }

  // "Schedule X for Tuesday", "Book X at 3pm", "Create X tomorrow"
  const scheduled =
    /\b(?:schedule|book|create|arrange|organis[ez]e|set\s+up)\s+(?:a\s+|an\s+|the\s+)?(.+)$/i.exec(text)
  if (scheduled) {
    const title = cleanTitle(scheduled[1]!)
    if (title) return title
  }

  // "meeting with Sarah Chen" — a person's name is a reasonable title.
  const withWhom =
    /\b(?:meeting|call|catch[- ]?up)\s+with\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)/.exec(text)
  if (withWhom?.[1]) return `Meeting with ${withWhom[1].trim()}`

  return null
}

/**
 * The words that identify an *existing* event, with the command vocabulary
 * stripped out. "Move my 7 PM meeting to 8 PM" leaves nothing distinctive;
 * "Delete Meeting for resources tomorrow" leaves "resources".
 */
const COMMAND_WORDS = new Set([
  'move', 'reschedule', 'rescheduled', 'shift', 'change', 'changed', 'push', 'postpone',
  'cancel', 'cancelled', 'delete', 'remove', 'drop', 'call', 'off',
  'book', 'schedule', 'create', 'arrange', 'add', 'put', 'set', 'make', 'makes',
  'my', 'the', 'a', 'an', 'to', 'at', 'on', 'for', 'from', 'of', 'in', 'into',
  'can', 'we', 'you', 'please', 'could', 'would', 'and', 'that', 'this', 'it',
  'today', 'tomorrow', 'tonight', 'yesterday', 'next', 'this', 'week',
  'meeting', 'meetings', 'appointment', 'event', 'calendar', 'diary',
  'hour', 'hours', 'minute', 'minutes', 'min', 'mins', 'half', 'one', 'longer', 'shorter',
  'am', 'pm', 'starts', 'start', 'starting', 'runs', 'long',
  ...WEEKDAYS
])

export function parseEventReferenceWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\b\d+(?::\d+)?\s*(?:am|pm)?\b/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !COMMAND_WORDS.has(w))
}

// ---------------------------------------------------------------------------
// Whole instructions
// ---------------------------------------------------------------------------

export interface CreateInstruction {
  title: string | null
  dayStart: number
  startMinutes: number | null
  durationMinutes: number | null
}

/** Read "book a meeting tomorrow at 2 PM called X for 30 minutes". */
export function parseCreateInstruction(text: string, now: number): CreateInstruction {
  const days = parseDayPhrases(text, now)
  const times = parseTimePhrases(text)
  const durations = parseDurationPhrases(text)

  return {
    title: parseEventTitle(text),
    dayStart: days[0]?.dayStart ?? startOfDay(now),
    startMinutes: times[0]?.minutes ?? null,
    // For a new meeting every duration is a request — there is no existing
    // length for one of them to be describing.
    durationMinutes: durations[0]?.minutes ?? null
  }
}

export interface UpdateInstruction {
  /** Words that identify which event is meant. */
  referenceWords: string[]
  /** An explicit title from "called X", when present. */
  referenceTitle: string | null
  /** The day to search for the event. */
  searchDay: number
  /** The event's current start time, when the user named it. */
  referenceStartMinutes: number | null
  /** Where the event should move to, when asked. */
  targetDay: number | null
  targetStartMinutes: number | null
  /** An absolute new length, e.g. "make it 1 hour". */
  newDurationMinutes: number | null
  /** A relative change, e.g. "30 minutes longer" (negative for shorter). */
  durationDeltaMinutes: number | null
}

/**
 * Read a change instruction, separating what identifies the event from what
 * should change about it.
 *
 * The rules, in the order they matter:
 *  - A time introduced by "to"/"until" is the destination; any other time
 *    describes the event being referred to.
 *  - A duration introduced by a change verb ("change to", "make it") is the
 *    requested length; a duration merely stated alongside the event ("that
 *    runs for half an hour") describes what it is now.
 *  - When only one duration appears and nothing marks it as descriptive, the
 *    user is asking for it — nobody states a length for no reason.
 */
export function parseUpdateInstruction(text: string, now: number): UpdateInstruction {
  const days = parseDayPhrases(text, now)
  const times = parseTimePhrases(text)
  const durations = parseDurationPhrases(text)

  const targetTime = times.find((t) => t.target) ?? null
  const referenceTime = times.find((t) => t !== targetTime) ?? null

  const targetDayPhrase = days.find((d) => d.target) ?? null
  const searchDayPhrase = days.find((d) => d !== targetDayPhrase) ?? days[0] ?? null

  const deltaPhrase = durations.find((d) => d.delta !== 0) ?? null
  const requestedPhrase =
    durations.find((d) => d.requested && d.delta === 0) ??
    // A single unmarked duration is the request: "make my 7 PM meeting 1 hour".
    (durations.filter((d) => d.delta === 0).length === 1
      ? durations.find((d) => d.delta === 0) ?? null
      : null)

  return {
    referenceWords: parseEventReferenceWords(text),
    referenceTitle: parseEventTitle(text),
    searchDay: searchDayPhrase?.dayStart ?? startOfDay(now),
    referenceStartMinutes: referenceTime?.minutes ?? null,
    targetDay: targetDayPhrase?.dayStart ?? null,
    targetStartMinutes: targetTime?.minutes ?? null,
    newDurationMinutes: requestedPhrase?.minutes ?? null,
    durationDeltaMinutes: deltaPhrase ? deltaPhrase.minutes * deltaPhrase.delta : null
  }
}
