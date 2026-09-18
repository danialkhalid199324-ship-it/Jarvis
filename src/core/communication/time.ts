/**
 * Small date helpers for calendar questions.
 *
 * All of these work in the machine's local time zone, because "today" and
 * "3 PM" mean what the user's Mac says they mean, not UTC.
 */

export function startOfDay(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function endOfDay(at: number): number {
  return startOfDay(at) + 86_400_000
}

export function addDays(at: number, days: number): number {
  const d = new Date(at)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

export interface DayWindow {
  from: number
  to: number
  label: string
}

/** The window a calendar question is asking about. */
export function windowFor(
  intent: 'today' | 'tomorrow' | 'week' | 'free' | 'answer',
  now: number
): DayWindow {
  switch (intent) {
    case 'tomorrow': {
      const start = startOfDay(addDays(now, 1))
      return { from: start, to: start + 86_400_000, label: 'tomorrow' }
    }
    case 'week':
      return { from: startOfDay(now), to: startOfDay(addDays(now, 7)), label: 'the next seven days' }
    case 'free':
    case 'answer':
    case 'today':
    default:
      return { from: startOfDay(now), to: endOfDay(now), label: 'today' }
  }
}

/**
 * Parse a time of day out of a phrase like "3 PM", "3:30pm" or "15:00".
 * @returns minutes since midnight, or null when no time is present.
 */
export function parseTimeOfDay(text: string): number | null {
  const meridiem = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text)
  if (meridiem) {
    let hour = Number.parseInt(meridiem[1]!, 10)
    const minute = meridiem[2] ? Number.parseInt(meridiem[2], 10) : 0
    const isPm = meridiem[3]!.toLowerCase() === 'pm'
    if (hour === 12) hour = 0
    if (isPm) hour += 12
    if (hour > 23 || minute > 59) return null
    return hour * 60 + minute
  }

  const twentyFour = /\b(\d{1,2}):(\d{2})\b/.exec(text)
  if (twentyFour) {
    const hour = Number.parseInt(twentyFour[1]!, 10)
    const minute = Number.parseInt(twentyFour[2]!, 10)
    if (hour > 23 || minute > 59) return null
    return hour * 60 + minute
  }

  return null
}

/** Which day a phrase refers to, relative to `now`. Defaults to today. */
export function parseDayReference(text: string, now: number): number {
  if (/\btomorrow\b/i.test(text)) return startOfDay(addDays(now, 1))
  if (/\byesterday\b/i.test(text)) return startOfDay(addDays(now, -1))

  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const match = new RegExp(`\\b(${weekdays.join('|')})\\b`, 'i').exec(text)
  if (match) {
    const target = weekdays.indexOf(match[1]!.toLowerCase())
    const today = new Date(now).getDay()
    // Always the next occurrence, including a week out if it is today.
    const delta = (target - today + 7) % 7 || 7
    return startOfDay(addDays(now, delta))
  }

  return startOfDay(now)
}

/** Combine a day and a minutes-since-midnight into an absolute time. */
export function atTimeOnDay(dayStart: number, minutesSinceMidnight: number): number {
  return dayStart + minutesSinceMidnight * 60_000
}

export function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

export function formatRange(start: number, end: number): string {
  return `${formatTime(start)} – ${formatTime(end)}`
}

export function formatDay(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  })
}
