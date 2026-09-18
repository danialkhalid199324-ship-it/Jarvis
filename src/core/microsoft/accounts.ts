import path from 'node:path'
import { readJson, writeJsonAtomic } from '../storage/json-file'
import { stableId } from '../util/ids'
import { GraphError } from './graph-client'
import { NeedsReauthError, MicrosoftNotConfiguredError } from './auth'
import type {
  AccountFailure,
  ConnectedAccount,
  MultiAccountResult
} from '../../shared/communication'

interface AccountsFile {
  version: number
  accounts: StoredAccount[]
}

/**
 * What Jarvis persists about an account. Note what is absent: no tokens, no
 * codes, no secrets. Those live only in the encrypted MSAL cache.
 */
interface StoredAccount {
  id: string
  homeAccountId: string
  username: string
  displayName: string
  tenantId: string
  label: string
  connectedAt: string
  lastSyncAt: number | null
}

const VERSION = 1

/**
 * The set of connected Microsoft accounts.
 *
 * Accounts are independent by construction: each carries its own
 * `homeAccountId`, every token is fetched for that id alone, and every mail or
 * calendar item is tagged with the account it came from. There is no shared
 * "current account" that an operation could accidentally read from.
 */
export class AccountRegistry {
  private readonly file: string
  private accounts: StoredAccount[]
  /** Transient per-account status, e.g. an account that needs reconnecting. */
  private readonly status = new Map<string, { status: ConnectedAccount['status']; detail?: string }>()

  private constructor(file: string, accounts: StoredAccount[]) {
    this.file = file
    this.accounts = accounts
  }

  static async open(dataDir: string): Promise<AccountRegistry> {
    const file = path.join(dataDir, 'microsoft-accounts.json')
    const data = await readJson<AccountsFile>(file, { version: VERSION, accounts: [] })
    const accounts = data.version === VERSION && Array.isArray(data.accounts) ? data.accounts : []
    return new AccountRegistry(file, accounts)
  }

  private async save(): Promise<void> {
    await writeJsonAtomic(this.file, { version: VERSION, accounts: this.accounts })
  }

  /** Public view of every connected account. Never includes credentials. */
  list(): ConnectedAccount[] {
    return this.accounts.map((a) => {
      const state = this.status.get(a.id)
      const account: ConnectedAccount = {
        id: a.id,
        username: a.username,
        displayName: a.displayName,
        tenantId: a.tenantId,
        label: a.label,
        connectedAt: a.connectedAt,
        lastSyncAt: a.lastSyncAt,
        status: state?.status ?? 'connected'
      }
      if (state?.detail) account.statusDetail = state.detail
      return account
    })
  }

  get(accountId: string): ConnectedAccount | undefined {
    return this.list().find((a) => a.id === accountId)
  }

  /** The MSAL identifier for an account. Main-process use only. */
  homeAccountId(accountId: string): string | undefined {
    return this.accounts.find((a) => a.id === accountId)?.homeAccountId
  }

  /**
   * Record a newly connected account, or refresh an existing one.
   * Re-connecting an account Jarvis already knows updates it in place rather
   * than creating a duplicate.
   */
  async upsert(outcome: {
    homeAccountId: string
    username: string
    displayName: string
    tenantId: string
  }): Promise<ConnectedAccount> {
    const id = stableId(`microsoft:${outcome.homeAccountId}`)
    const existing = this.accounts.find((a) => a.id === id)

    if (existing) {
      existing.username = outcome.username
      existing.displayName = outcome.displayName
      existing.tenantId = outcome.tenantId
      existing.homeAccountId = outcome.homeAccountId
    } else {
      this.accounts.push({
        id,
        homeAccountId: outcome.homeAccountId,
        username: outcome.username,
        displayName: outcome.displayName,
        tenantId: outcome.tenantId,
        // Default the label to the display name; the user can rename it.
        label: outcome.displayName || outcome.username,
        connectedAt: new Date().toISOString(),
        lastSyncAt: null
      })
    }

    this.status.delete(id)
    await this.save()
    return this.get(id)!
  }

  async setLabel(accountId: string, label: string): Promise<ConnectedAccount | null> {
    const account = this.accounts.find((a) => a.id === accountId)
    if (!account) return null
    account.label = label.trim() || account.displayName || account.username
    await this.save()
    return this.get(accountId)!
  }

  async markSynced(accountId: string): Promise<void> {
    const account = this.accounts.find((a) => a.id === accountId)
    if (!account) return
    account.lastSyncAt = Date.now()
    this.status.delete(accountId)
    await this.save()
  }

  /** Flag an account as needing attention, for the Settings cards. */
  markProblem(accountId: string, status: 'needs_reauth' | 'error', detail: string): void {
    this.status.set(accountId, { status, detail })
  }

  async remove(accountId: string): Promise<ConnectedAccount | null> {
    const found = this.get(accountId)
    if (!found) return null
    this.accounts = this.accounts.filter((a) => a.id !== accountId)
    this.status.delete(accountId)
    await this.save()
    return found
  }

  /** Forget every account. Used when the user disconnects Microsoft entirely. */
  async removeAll(): Promise<void> {
    this.accounts = []
    this.status.clear()
    await this.save()
  }
}

/**
 * Turn any thrown error into a user-facing failure record.
 *
 * Deliberately lossy about internals: a failure the user sees says what to do
 * about it, and never leaks a token, an id or a stack.
 */
export function describeFailure(account: ConnectedAccount, error: unknown): AccountFailure {
  if (error instanceof NeedsReauthError) {
    return {
      accountId: account.id,
      accountLabel: account.label,
      kind: 'auth',
      reason: `${account.label} needs its Microsoft session renewed. Reconnect it in Settings → Connected Accounts.`
    }
  }
  if (error instanceof MicrosoftNotConfiguredError) {
    return {
      accountId: account.id,
      accountLabel: account.label,
      kind: 'consent',
      reason: error.message
    }
  }
  if (error instanceof GraphError) {
    return {
      accountId: account.id,
      accountLabel: account.label,
      kind: error.kind,
      reason: `${account.label}: ${error.message}`
    }
  }
  return {
    accountId: account.id,
    accountLabel: account.label,
    kind: 'unknown',
    reason: `${account.label} could not be reached.`
  }
}

/**
 * Run an operation against several accounts, keeping successes and failures
 * apart.
 *
 * Accounts are queried in parallel but never share state, and one account
 * failing never removes another's results — nor does it let Jarvis present the
 * remainder as if everything had been checked.
 */
export async function forEachAccount<T>(
  accounts: readonly ConnectedAccount[],
  operation: (account: ConnectedAccount) => Promise<T[]>,
  hooks?: {
    onSuccess?: (account: ConnectedAccount) => void | Promise<void>
    onFailure?: (account: ConnectedAccount, failure: AccountFailure) => void | Promise<void>
  }
): Promise<MultiAccountResult<T>> {
  const settled = await Promise.allSettled(
    accounts.map(async (account) => ({ account, items: await operation(account) }))
  )

  const items: T[] = []
  const checkedAccounts: string[] = []
  const failures: AccountFailure[] = []
  // Hooks may persist account status. They are awaited rather than fired and
  // forgotten, so a status write cannot outlive the operation that caused it.
  const sideEffects: Array<Promise<void>> = []

  settled.forEach((outcome, index) => {
    const account = accounts[index]!
    if (outcome.status === 'fulfilled') {
      items.push(...outcome.value.items)
      checkedAccounts.push(account.label)
      const pending = hooks?.onSuccess?.(account)
      if (pending) sideEffects.push(pending)
    } else {
      const failure = describeFailure(account, outcome.reason)
      failures.push(failure)
      const pending = hooks?.onFailure?.(account, failure)
      if (pending) sideEffects.push(pending)
    }
  })

  await Promise.allSettled(sideEffects)
  return { items, checkedAccounts, failures }
}

/**
 * One sentence describing coverage, used whenever Jarvis reports on several
 * accounts. Returns null when everything was reachable — no need to say so.
 */
export function describeCoverage(result: MultiAccountResult<unknown>, total: number): string | null {
  if (result.failures.length === 0) return null
  const checked = result.checkedAccounts.length
  const reasons = result.failures.map((f) => f.reason).join(' ')
  return `I checked ${checked} of your ${total} connected ${total === 1 ? 'account' : 'accounts'}. ${reasons}`
}
