import type { ProviderRegistry } from '../ai/registry'
import type { Logger } from '../logging/logger'
import type { DocumentStore } from '../storage/document-store'
import type { MicrosoftWorkspace } from '../microsoft/workspace'
import { needingAttention, scoreMessages } from './mail-intelligence'
import { buildMailExcerpts, mailDisclosure } from './mail-context'
import { formatTime, startOfDay, endOfDay } from './time'
import type {
  AccountFailure,
  DailyBrief,
  DashboardSummary
} from '../../shared/communication'

const BRIEF_SYSTEM = `You are Jarvis, writing the "focus" section of a busy executive's morning brief.

You will be given a factual summary of their day: meetings, and the emails that scored highest on objective signals. Follow these rules exactly:

1. Use ONLY what you are given. Never invent a meeting, a sender, a deadline or a number.
2. Write 2–4 short sentences. This sits under a list of facts the user can already see, so do not repeat the list — say what it means.
3. Lead with the single thing most worth their attention, and say why.
4. Note any genuine collision or tight turnaround you can see in the times given.
5. If there is genuinely little to flag, say so plainly in one sentence. Do not manufacture urgency.
6. No greeting, no sign-off, no headings.`

export interface BriefDeps {
  workspace: MicrosoftWorkspace
  store: DocumentStore
  providers: ProviderRegistry
  logger: Logger
  maxContextChars: () => number
  now?: () => number
}

/**
 * The daily brief.
 *
 * Built in two clearly separated halves. `facts` is retrieved data — meetings
 * that exist, messages that scored highest on objective signals — and is what
 * the UI renders as fact. `focus` is the model's read of those facts, labelled
 * as AI-generated wherever it appears.
 *
 * If no provider is configured, the brief still works: the user gets the facts
 * and an honest note that the summary is unavailable, rather than nothing.
 */
export class DailyBriefService {
  private readonly deps: BriefDeps
  private readonly now: () => number

  constructor(deps: BriefDeps) {
    this.deps = deps
    this.now = deps.now ?? ((): number => Date.now())
  }

  async build(signal?: AbortSignal): Promise<DailyBrief> {
    const now = this.now()
    const accounts = this.deps.workspace.accounts()
    const failures: AccountFailure[] = []
    let checked = 0

    // -- facts: calendar ---------------------------------------------------
    let meetingsToday: DailyBrief['facts']['meetingsToday'] = []
    if (accounts.length > 0) {
      const events = await this.deps.workspace.listEvents({ from: startOfDay(now), to: endOfDay(now) })
      meetingsToday = events.items
      failures.push(...events.failures)
      checked = Math.max(checked, events.checkedAccounts.length)
    }
    const nextMeeting = meetingsToday.find((e) => e.end > now) ?? null

    // -- facts: mail -------------------------------------------------------
    let unreadCount = 0
    let priorityMail: DailyBrief['facts']['priorityMail'] = []
    let needsAttentionCount = 0

    if (accounts.length > 0) {
      const mail = await this.deps.workspace.listMail({ limit: 40 })
      // Merge failure lists without double-counting an account that failed both.
      for (const failure of mail.failures) {
        if (!failures.some((f) => f.accountId === failure.accountId)) failures.push(failure)
      }
      checked = Math.max(checked, mail.checkedAccounts.length)

      const ownAddresses = accounts.map((a) => a.username)
      const scored = scoreMessages(mail.items, { ownAddresses, now })
      unreadCount = scored.filter((m) => !m.isRead).length
      const attention = needingAttention(mail.items, { ownAddresses, now })
      needsAttentionCount = attention.length
      priorityMail = attention.slice(0, 5)
    }

    // -- facts: documents --------------------------------------------------
    const recentDocuments = [...this.deps.store.allDocuments()]
      .sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))
      .slice(0, 3)

    const brief: DailyBrief = {
      generatedAt: now,
      facts: {
        meetingsToday,
        nextMeeting,
        unreadCount,
        needsAttentionCount,
        priorityMail,
        recentDocuments
      },
      focus: null,
      accountsChecked: checked,
      accountsTotal: accounts.length,
      failures
    }

    // -- AI: prioritisation, clearly separated from the facts above -------
    const provider = this.deps.providers.active()
    if (!provider) {
      brief.focusUnavailableReason =
        'Add an AI provider in Settings to get a written summary of what needs attention.'
      return brief
    }
    if (meetingsToday.length === 0 && priorityMail.length === 0) {
      brief.focusUnavailableReason = 'Nothing to summarise — your day looks clear so far.'
      return brief
    }

    const bundle = buildMailExcerpts(priorityMail, {
      maxChars: Math.min(this.deps.maxContextChars(), 12_000),
      maxMessages: 5
    })

    const factSheet = [
      `Today is ${new Date(now).toDateString()}.`,
      meetingsToday.length === 0
        ? 'No meetings scheduled today.'
        : `Meetings today (${meetingsToday.length}):\n` +
          meetingsToday
            .map((e) => `- ${formatTime(e.start)}–${formatTime(e.end)} ${e.subject} (${e.accountLabel})`)
            .join('\n'),
      `Unread email: ${unreadCount}. Scored as needing attention: ${needsAttentionCount}.`,
      bundle.excerpts.length > 0
        ? `Highest-scoring messages:\n${bundle.excerpts.map((e) => e.text).join('\n\n---\n\n')}`
        : 'No individual messages stood out.'
    ].join('\n\n')

    try {
      const response = await provider.complete(
        {
          system: BRIEF_SYSTEM,
          maxTokens: 600,
          messages: [{ role: 'user', content: factSheet }],
          ...(signal ? { signal } : {})
        },
        this.deps.providers.activeModelId
      )
      brief.focus = response.text.trim() || null
      brief.disclosure = mailDisclosure(
        bundle,
        { id: provider.id, label: provider.label, local: provider.local },
        this.deps.providers.activeModelId
      )
      this.deps.logger.info('brief.generated', {
        meetings: meetingsToday.length,
        priorityMail: priorityMail.length,
        excerptCount: bundle.excerpts.length
      })
    } catch (error) {
      brief.focusUnavailableReason =
        error instanceof Error ? error.message : 'The AI provider could not be reached.'
    }

    return brief
  }

  /**
   * Counts for the Home cards.
   *
   * Every number is retrieved. When an account cannot be reached the card says
   * so rather than showing a lower number as though it were complete.
   */
  async dashboard(): Promise<DashboardSummary> {
    const now = this.now()
    const accounts = this.deps.workspace.accounts()
    const stats = await this.deps.store.stats()

    const summary: DashboardSummary = {
      mail: { available: false, needsAttention: 0, unread: 0 },
      calendar: { available: false, today: 0 },
      documents: { indexed: stats.documentCount, lastIndexedAt: stats.lastIndexedAt },
      accountsTotal: accounts.length,
      accountsChecked: 0,
      failures: []
    }

    if (accounts.length === 0) return summary

    const [mail, events] = await Promise.all([
      this.deps.workspace.listMail({ limit: 40 }),
      this.deps.workspace.listEvents({ from: startOfDay(now), to: endOfDay(now) })
    ])

    const ownAddresses = accounts.map((a) => a.username)
    const scored = scoreMessages(mail.items, { ownAddresses, now })

    summary.mail = {
      available: mail.checkedAccounts.length > 0,
      needsAttention: scored.filter((m) => m.attention.needsAttention).length,
      unread: scored.filter((m) => !m.isRead).length
    }

    const next = events.items.find((e) => e.end > now)
    summary.calendar = {
      available: events.checkedAccounts.length > 0,
      today: events.items.length,
      ...(next ? { nextSubject: next.subject, nextStart: next.start } : {})
    }

    summary.accountsChecked = Math.max(mail.checkedAccounts.length, events.checkedAccounts.length)
    for (const failure of [...mail.failures, ...events.failures]) {
      if (!summary.failures.some((f) => f.accountId === failure.accountId)) {
        summary.failures.push(failure)
      }
    }

    return summary
  }
}
