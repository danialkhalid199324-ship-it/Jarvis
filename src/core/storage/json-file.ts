import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/**
 * Small helpers for durable JSON on disk.
 *
 * Writes go to a temporary file in the same directory and are then renamed over
 * the target, so a crash mid-write leaves the previous file intact rather than
 * a truncated one. This matters because Jarvis's settings file holds the user's
 * authorised-folder list.
 */

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  try {
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

/** Recursive directory size in bytes; returns 0 when the directory is absent. */
export async function dirSize(dir: string): Promise<number> {
  let total = 0
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await dirSize(full)
    } else {
      const stat = await fs.stat(full).catch(() => null)
      if (stat) total += stat.size
    }
  }
  return total
}

/** Temp directory helper used by the test suite. */
export function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}`)
}
