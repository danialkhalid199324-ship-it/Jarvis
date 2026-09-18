import { GraphClient, type FetchLike } from './graph-client'
import { MailService, DEFAULT_MAIL_LIMIT } from './mail'
import { CalendarService } from './calendar'
import { AccountRegistry, forEachAccount } from './accounts'
import { MicrosoftAuthenticator, NeedsReauthError } from './auth'
import type { Logger } from '../logging/logger'
import type {
  CalendarEvent,
  CalendarQuery,
  ConnectedAccount,
  MailMessage,
  MailQuery,
  MultiAccountResult
} from '../../shared/communication'

export interface WorkspaceDeps {
  auth: MicrosoftAuthenticator
  registry: AccountRegistry
  logger: Logger
  /** Injected in tests so Graph can be mocked without touching the network. */
  fetchImpl?: FetchLike
}

/**
 * The single place the rest of Jarvis talks to Microsoft 365.
 *
 * It owns per-account service construction and every multi-account read, so
 * account isolation and partial-failure reporting are enforced in one place
 * rather than re-implemented by each caller.
 */
export class MicrosoftWorkspace {
  private readonly deps: WorkspaceDeps

  constructor(deps: WorkspaceDeps) {
    this.deps = deps
  }

  isConfigured(): boolean {
    return this.deps.auth.isConfigured()
  }

  accounts(): ConnectedAccount[] {
    return this.deps.registry.list()
  }

  hasAccounts(): boolean {
    return this.accounts().length > 0
  }

  /**
   * Resolve which accounts an operation covers.
   * An unknown id yields an empty list rather than silently widening to all —
   * answering about the wrong mailbox is worse than answering about none.
   */
  resolveAccounts(accountId?: string): ConnectedAccount[] {
    const all = this.accounts()
    if (!accountId) return all
    return all.filter((a) => a.id === accountId)
  }

  /**
   * Match an account by user-facing name, for "check my GTA emails".
   * Matching is deliberately conservative: an ambiguous term matches nothing
   * and the caller falls back to searching everything.
   */
  findAccountByName(term: string): ConnectedAccount | null {
    const needle = term.trim().toLowerCase()
    if (!needle) return null
    const candidates = this.accounts().filter(
      (a) =>
        a.label.toLowerCase() === needle ||
        a.displayName.toLowerCase() === needle ||
        a.username.toLowerCase() === needle ||
        a.username.toLowerCase().split('@')[0] === needle
    )
    if (candidates.length === 1) return candidates[0]!
    // Fall back to a prefix match, still requiring it to be unambiguous.
    const loose = this.accounts().filter((a) => a.label.toLowerCase().startsWith(needle))
    return loose.length === 1 ? loose[0]! : null
  }

  private graphFor(account: ConnectedAccount): GraphClient {
    const homeAccountId = this.deps.registry.homeAccountId(account.id)
    if (!homeAccountId) throw new NeedsReauthError(account.id)
    // The token is fetched per request, so it is never held on a long-lived
    // object and a silent refresh happens exactly when it is needed.
    return new GraphClient(
      () => this.deps.auth.getAccessToken(homeAccountId),
      this.deps.fetchImpl
    )
  }

  mailFor(account: ConnectedAccount): MailService {
    return new MailService(this.graphFor(account), account)
  }

  calendarFor(account: ConnectedAccount): CalendarService {
    return new CalendarService(this.graphFor(account), account)
  }

  // -- connection lifecycle ------------------------------------------------

  async connect(): Promise<ConnectedAccount> {
    const outcome = await this.deps.auth.signIn()
    const account = await this.deps.registry.upsert(outcome)
    await this.deps.registry.markSynced(account.id)
    return this.deps.registry.get(account.id)!
  }

  async disconnect(accountId: string): Promise<ConnectedAccount | null> {
    const homeAccountId = this.deps.registry.homeAccountId(accountId)
    if (homeAccountId) await this.deps.auth.signOut(homeAccountId)
    return this.deps.registry.remove(accountId)
  }

  /** Verify an account still works, refreshing its status and last-synced time. */
  async sync(accountId: string): Promise<ConnectedAccount | null> {
    const account = this.deps.registry.get(accountId)
    if (!account) return null
    try {
      await this.graphFor(account).request('/me', { query: { $select: 'id,displayName,mail' } })
      await this.deps.registry.markSynced(accountId)
    } catch (error) {
      const detail =
        error instanceof NeedsReauthError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'This account could not be reached.'
      this.deps.registry.markProblem(
        accountId,
        error instanceof NeedsReauthError ? 'needs_reauth' : 'error',
        detail
      )
      this.deps.logger.warn('microsoft.sync_failed', { accountId, kind: error instanceof NeedsReauthError ? 'auth' : 'other' })
    }
    return this.deps.registry.get(accountId) ?? null
  }

  /** Keep account status in step with what actually happened on a read. */
  private hooks() {
    return {
      onSuccess: (account: ConnectedAccount) => void this.deps.registry.markSynced(account.id),
      onFailure: (account: ConnectedAccount, failure: { kind: string; reason: string }) => {
        this.deps.registry.markProblem(
          account.id,
          failure.kind === 'auth' ? 'needs_reauth' : 'error',
          failure.reason
        )
      }
    }
  }

  // -- multi-account reads -------------------------------------------------

  async listMail(query: MailQuery = {}): Promise<MultiAccountResult<MailMessage>> {
    const accounts = this.resolveAccounts(query.accountId)
    const limit = query.limit ?? DEFAULT_MAIL_LIMIT

    const result = await forEachAccount(
      accounts,
      async (account) => {
        const mail = this.mailFor(account)
        return query.search
          ? mail.search(query.search, limit)
          : mail.recent(limit, query.unreadOnly === true)
      },
      this.hooks()
    )

    // Newest first across every account, so a unified view reads chronologically.
    result.items.sort((a, b) => b.receivedAt - a.receivedAt)
    return result
  }

  async listEvents(query: CalendarQuery): Promise<MultiAccountResult<CalendarEvent>> {
    const accounts = this.resolveAccounts(query.accountId)
    const result = await forEachAccount(
      accounts,
      (account) => this.calendarFor(account).eventsBetween(query.from, query.to),
      this.hooks()
    )
    result.items.sort((a, b) => a.start - b.start)
    return result
  }

  async unreadCounts(): Promise<MultiAccountResult<{ accountId: string; accountLabel: string; count: number }>> {
    return forEachAccount(
      this.accounts(),
      async (account) => [
        {
          accountId: account.id,
          accountLabel: account.label,
          count: await this.mailFor(account).unreadCount()
        }
      ],
      this.hooks()
    )
  }

  /** Fetch one message with its body, from the account that owns it. */
  async getMessage(accountId: string, messageId: string): Promise<MailMessage | null> {
    const account = this.deps.registry.get(accountId)
    if (!account) return null
    return this.mailFor(account).get(messageId)
  }

  async getThread(accountId: string, conversationId: string): Promise<MailMessage[]> {
    const account = this.deps.registry.get(accountId)
    if (!account) return []
    return this.mailFor(account).thread(conversationId)
  }
}
