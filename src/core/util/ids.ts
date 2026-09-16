import crypto from 'node:crypto'

/** Short, stable, filesystem-safe id derived from a string. */
export function stableId(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 24)
}

/** Random id for things that have no natural key (conversation turns, runs). */
export function randomId(): string {
  return crypto.randomBytes(9).toString('hex')
}
