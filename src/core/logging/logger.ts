import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { LogEntry, LogLevel } from '../../shared/types'

/**
 * Append-only local audit log.
 *
 * Jarvis records what it did — folders authorised, index runs, searches, and
 * every call to an external AI provider — as one JSON object per line under the
 * app's data directory. Nothing is sent anywhere; this exists so the user can
 * always answer "what has Jarvis been doing?".
 *
 * Document text is never logged. Only counts and file names.
 */
export class Logger {
  private readonly dir: string
  private queue: Promise<void> = Promise.resolve()

  constructor(dir: string) {
    this.dir = dir
  }

  private fileForToday(): string {
    const day = new Date().toISOString().slice(0, 10)
    return path.join(this.dir, `jarvis-${day}.jsonl`)
  }

  private write(level: LogLevel, event: string, detail?: Record<string, unknown>): void {
    const entry: LogEntry = { at: new Date().toISOString(), level, event }
    if (detail) entry.detail = detail
    const line = JSON.stringify(entry) + '\n'
    // Serialise appends so concurrent callers cannot interleave partial lines.
    this.queue = this.queue
      .then(async () => {
        await fsp.mkdir(this.dir, { recursive: true })
        await fsp.appendFile(this.fileForToday(), line, 'utf8')
      })
      .catch(() => {
        // Logging must never take the app down.
      })
  }

  info(event: string, detail?: Record<string, unknown>): void {
    this.write('info', event, detail)
  }

  warn(event: string, detail?: Record<string, unknown>): void {
    this.write('warn', event, detail)
  }

  error(event: string, detail?: Record<string, unknown>): void {
    this.write('error', event, detail)
  }

  /** Wait for pending writes — used on app quit and in tests. */
  async flush(): Promise<void> {
    await this.queue
  }

  /** Most recent entries, newest first, for the Settings screen. */
  async recent(limit = 200): Promise<LogEntry[]> {
    await this.flush()
    let files: string[]
    try {
      files = (await fsp.readdir(this.dir)).filter((f) => f.endsWith('.jsonl')).sort().reverse()
    } catch {
      return []
    }
    const entries: LogEntry[] = []
    for (const file of files) {
      const raw = await fsp.readFile(path.join(this.dir, file), 'utf8').catch(() => '')
      const lines = raw.split('\n').filter(Boolean).reverse()
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as LogEntry)
        } catch {
          // Skip a corrupt line rather than lose the whole log.
        }
        if (entries.length >= limit) return entries
      }
    }
    return entries
  }

  /** Total bytes the log directory occupies. */
  logDirSize(): number {
    try {
      return fs
        .readdirSync(this.dir)
        .reduce((sum, f) => sum + fs.statSync(path.join(this.dir, f)).size, 0)
    } catch {
      return 0
    }
  }
}
