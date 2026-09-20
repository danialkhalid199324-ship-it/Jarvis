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

/**
 * Combine a day and a minutes-since-midnight into an absolute time.
 *
 * Set on a Date rather than added as milliseconds. A day is not always 24
 * hours: on the morning clocks go forward, `dayStart + 19h` lands at 8 PM, not
 * 7 PM. Australian daylight saving makes that a real, twice-yearly wrong
 * answer for a calendar, so the wall-clock time is set directly and the
 * runtime resolves the offset.
 */
export function atTimeOnDay(dayStart: number, minutesSinceMidnight: number): number {
  const d = new Date(dayStart)
  d.setHours(0, 0, 0, 0)
  d.setMinutes(minutesSinceMidnight)
  return d.getTime()
}

/** Minutes since local midnight for an absolute time. */
export function minutesOfDay(at: number): number {
  const d = new Date(at)
  return d.getHours() * 60 + d.getMinutes()
}

/** The length of an event in whole minutes. */
export function durationMinutes(start: number, end: number): number {
  return Math.round((end - start) / 60_000)
}

/** Move a time onto another day, keeping its wall-clock time. */
export function withDay(dayStart: number, at: number): number {
  return atTimeOnDay(dayStart, minutesOfDay(at))
}

/** Render a duration the way a person says it. */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const hourLabel = hours === 1 ? '1 hour' : `${hours} hours`
  return rest === 0 ? hourLabel : `${hourLabel} ${rest} minutes`
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
