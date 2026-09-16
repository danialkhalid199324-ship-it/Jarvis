import path from 'node:path'
import fs from 'node:fs/promises'

/**
 * Path containment guard.
 *
 * Every filesystem read in Jarvis goes through this module. The rule it
 * enforces is the whole security model of V0.1: Jarvis may only touch files
 * inside folders the user explicitly authorised, and it may only read them.
 *
 * Two traps this avoids:
 *  - Naive `startsWith` containment, where `/Users/me/Docs-private` looks like
 *    it lives inside `/Users/me/Docs`. We compare path segments, not prefixes.
 *  - Symlink escape, where an authorised folder contains a link pointing
 *    somewhere else. We resolve real paths before comparing.
 */

/** macOS and Windows filesystems are case-insensitive by default. */
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32'

export class PathNotAuthorisedError extends Error {
  readonly attemptedPath: string
  constructor(attemptedPath: string) {
    super(`Jarvis is not authorised to access this location: ${attemptedPath}`)
    this.name = 'PathNotAuthorisedError'
    this.attemptedPath = attemptedPath
  }
}

function normaliseForCompare(p: string): string {
  const resolved = path.resolve(p)
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved
}

/**
 * True when `candidate` is `root` itself or sits underneath it.
 * Purely lexical — call {@link assertReadable} for the symlink-safe check.
 */
export function isWithin(root: string, candidate: string): boolean {
  const normRoot = normaliseForCompare(root)
  const normCandidate = normaliseForCompare(candidate)
  if (normRoot === normCandidate) return true
  const rel = path.relative(normRoot, normCandidate)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** The first authorised root containing `candidate`, or null. */
export function findContainingRoot(roots: readonly string[], candidate: string): string | null {
  for (const root of roots) {
    if (isWithin(root, candidate)) return root
  }
  return null
}

/**
 * Resolve a path to its real location on disk, following symlinks.
 * Falls back to the lexically resolved path when the target does not exist,
 * so that callers can still make authorisation decisions about new paths.
 */
export async function realPathOrResolved(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * Verify that Jarvis may read `candidate`, resolving symlinks on both sides so
 * a link inside an authorised folder cannot be used to reach outside it.
 *
 * @throws PathNotAuthorisedError when the path is outside every authorised root.
 * @returns the real, resolved path that callers should read from.
 */
export async function assertReadable(
  roots: readonly string[],
  candidate: string
): Promise<string> {
  const realCandidate = await realPathOrResolved(candidate)
  const realRoots = await Promise.all(roots.map((r) => realPathOrResolved(r)))
  if (findContainingRoot(realRoots, realCandidate) === null) {
    throw new PathNotAuthorisedError(candidate)
  }
  return realCandidate
}

/**
 * Reject nested authorisations so the same file is not indexed twice and the
 * permissions list stays comprehensible.
 *
 * @returns a reason string when `candidate` should not be added, else null.
 */
export function describeOverlap(
  existing: readonly string[],
  candidate: string
): string | null {
  for (const root of existing) {
    if (isWithin(root, candidate)) {
      return candidate === root
        ? 'That folder is already authorised.'
        : `That folder is already covered by an authorised folder: ${root}`
    }
    if (isWithin(candidate, root)) {
      return `That folder contains an already authorised folder: ${root}. Remove the narrower one first.`
    }
  }
  return null
}
