import fs from 'node:fs/promises'
import path from 'node:path'
import { detectFileType } from '../parsers'
import type { SupportedFileType } from '../../shared/types'

/**
 * Directories Jarvis never descends into. These hold application data, caches
 * and version-control internals — never the user's documents — and skipping
 * them keeps indexing fast and the results clean.
 */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '__macosx',
  '.git',
  '.svn',
  '.hg',
  '$recycle.bin',
  'system volume information',
  '.trash',
  '.trashes',
  '.cache',
  '.venv',
  'venv',
  '__pycache__'
])

export interface DiscoveredFile {
  path: string
  fileName: string
  directory: string
  fileType: SupportedFileType
  size: number
  modifiedAt: number | null
}

export interface CrawlOptions {
  maxFileSizeBytes: number
  signal?: AbortSignal
  /** Called as directories are entered, so the UI can show progress. */
  onProgress?: (currentPath: string, found: number) => void
}

function shouldSkipDirectory(name: string): boolean {
  const lower = name.toLowerCase()
  // Hidden directories are skipped wholesale: on macOS they are app state.
  return lower.startsWith('.') || SKIP_DIRECTORIES.has(lower)
}

function shouldSkipFile(name: string): boolean {
  // Word/Excel lock files, and macOS resource forks.
  return name.startsWith('~$') || name.startsWith('._') || name.startsWith('.')
}

/**
 * Walk an authorised folder and list the files Jarvis can read.
 *
 * Symlinked directories are not followed. That prevents both infinite loops and
 * a link inside an authorised folder being used to reach unauthorised parts of
 * the disk.
 */
export async function crawlFolder(root: string, options: CrawlOptions): Promise<DiscoveredFile[]> {
  const found: DiscoveredFile[] = []
  const queue: string[] = [root]

  while (queue.length > 0) {
    if (options.signal?.aborted) break
    const dir = queue.shift()!
    options.onProgress?.(dir, found.length)

    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      // Unreadable directory (permissions, removed mid-crawl) — skip quietly.
      continue
    }

    for (const entry of entries) {
      if (options.signal?.aborted) break
      const full = path.join(dir, entry.name)

      if (entry.isSymbolicLink()) continue

      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name)) queue.push(full)
        continue
      }
      if (!entry.isFile()) continue
      if (shouldSkipFile(entry.name)) continue

      const fileType = detectFileType(full)
      if (!fileType) continue

      const stat = await fs.stat(full).catch(() => null)
      if (!stat) continue
      if (stat.size > options.maxFileSizeBytes) continue
      if (stat.size === 0) continue

      found.push({
        path: full,
        fileName: entry.name,
        directory: dir,
        fileType,
        size: stat.size,
        modifiedAt: Number.isFinite(stat.mtimeMs) ? Math.round(stat.mtimeMs) : null
      })
    }
  }

  return found
}
