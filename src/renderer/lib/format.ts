/** Small presentation helpers shared across screens. */

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 KB'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

export function formatDate(epochMs: number | null): string {
  if (epochMs === null) return 'Date unknown'
  return new Date(epochMs).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })
}

export function formatDateTime(epochMs: number | null): string {
  if (epochMs === null) return 'Never'
  return new Date(epochMs).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

export function greetingFor(date: Date): string {
  const hour = date.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export function formatToday(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })
}

export function formatClock(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** Shorten a long path for display while keeping both ends readable. */
export function shortenPath(fullPath: string, maxLength = 68): string {
  if (fullPath.length <= maxLength) return fullPath
  const parts = fullPath.split('/')
  if (parts.length <= 3) return fullPath
  return `${parts.slice(0, 2).join('/')}/…/${parts.slice(-2).join('/')}`
}
