import type { AIProvider } from '../../ai/provider'
import type { ProviderRegistry } from '../../ai/registry'
import type { Logger } from '../../logging/logger'
import type { MicrosoftWorkspace } from '../../microsoft/workspace'
import { describeCoverage } from '../../microsoft/accounts'
import { needingAttention, scoreMessages, sortByNewest } from '../../communication/mail-intelligence'
import {
  buildMailExcerpts,
  citedMailSources,
  mailDisclosure,
  renderMailExcerpts
} from '../../communication/mail-context'
import { draftReply } from '../../communication/drafts'
import { extractSenderName, type Route } from '../routing'
import type {
  JarvisReply,
  MailMessage,
  ScoredMailMessage
} from '../../../shared/communication'

const MAIL_ANSWER_SYSTEM = `You are Jarvis, a private executive assistant answering questions about the user's own email.

You will be given numbered excerpts from emails in the user's connected accounts. Follow these rules exactly:

1. Answer ONLY from the excerpts provided. Never use outside knowledge about companies, people or events.
2. Cite every factual claim with the excerpt number in square brackets, like [2].
3. Always make clear which account a message came from when it matters.
4. If the excerpts do not contain enough information to answer, reply with exactly "INSUFFICIENT: " followed by one sentence saying what is missing. Do not guess.
5. Lead with what the user needs to do or know. Be direct and businesslike, no preamble and no sign-off.
6. Use short paragraphs, and bullet points when listing separate items.`

const INSUFFICIENT = 'INSUFFICIENT'

export interface MailCapabilityDeps {
  workspace: MicrosoftWorkspace
  providers: ProviderRegistry
  logger: Logger
  maxContextChars: () => number
}

/**
 * Answering questions about mail.
 *
 * Retrieval is always deterministic and always first: Microsoft Graph filters
 * and Jarvis's own attention scoring decide *which* messages matter, and only
 * then does a shortlist of those messages go to the AI provider — and only when
 * the question genuinely needs prose rather than a list.
 *
 * Listing, searching and triaging mail cost nothing and send nothing.
 */
export class MailCapability {
  private readonly deps: MailCapabilityDeps

  constructor(deps: MailCapabilityDeps) {
    this.deps = deps
  }

  /** Addresses belonging to the user, so "to me" can be told from "cc'd". */
  private ownAddresses(): string[] {
    return this.deps.workspace.accounts().map((a) => a.username)
  }

  private resolveAccountId(route: Route): string | undefined {
    if (route.allAccounts || !route.accountHint) return undefined
    const account = this.deps.workspace.findAccountByName(route.accountHint)
    return account?.id
  }

  async handle(question: string, route: Route, signal?: AbortSignal): Promise<JarvisReply> {
    const workspace = this.deps.workspace

    if (!workspace.isConfigured()) {
      return notice(
        'Microsoft 365 is not set up yet. Add your Azure application ID and connect an account in Settings → Connected Accounts.'
      )
    }
    if (!workspace.hasAccounts()) {
      return notice(
        'No Microsoft accounts are connected yet. Connect one in Settings → Connected Accounts and I can start reading your mail.'
      )
    }

    switch (route.mailIntent) {
      case 'draft':
        return this.handleDraft(question, route, signal)
      case 'attention':
        return this.handleAttention(route)
      case 'unread':
        return this.handleUnread(route)
      case 'search':
        return this.handleSearch(question, route)
      case 'answer':
        return this.handleAnswer(question, route, signal)
      default:
        return this.handleList(route)
    }
  }

  // -- retrieval only: nothing is sent anywhere --------------------------

  private async handleList(route: Route): Promise<JarvisReply> {
    const accountId = this.resolveAccountId(route)
    const result = await this.deps.workspace.listMail({ ...(accountId ? { accountId } : {}), limit: 25 })
    // A plain inbox reads chronologically. Every message keeps its attention
    // score and reasons — they drive the badges, not the order here.
    const scored = sortByNewest(scoreMessages(result.items, { ownAddresses: this.ownAddresses() }))
    const attention = scored.filter((m) => m.attention.needsAttention).length
    const unread = scored.filter((m) => !m.isRead).length

    const where = accountId ? ` in ${result.checkedAccounts[0] ?? 'that account'}` : ''
    const text =
      scored.length === 0
        ? `No recent messages${where}.`
        : `${scored.length} recent ${scored.length === 1 ? 'message' : 'messages'}${where}. ` +
          `${unread} unread, ${attention} ${attention === 1 ? 'looks like it needs' : 'look like they need'} attention.`

    return this.reply({ text, messages: scored, result, kind: 'results' })
  }

  private async handleUnread(route: Route): Promise<JarvisReply> {
    const accountId = this.resolveAccountId(route)
    const result = await this.deps.workspace.listMail({
      ...(accountId ? { accountId } : {}),
      unreadOnly: true,
      limit: 30
    })
    const scored = sortByNewest(scoreMessages(result.items, { ownAddresses: this.ownAddresses() }))
    return this.reply({
      text:
        scored.length === 0
          ? 'Nothing unread.'
          : `${scored.length} unread ${scored.length === 1 ? 'message' : 'messages'}.`,
      messages: scored,
      result,
      kind: 'results'
    })
  }

  private async handleAttention(route: Route): Promise<JarvisReply> {
    const accountId = this.resolveAccountId(route)
    const result = await this.deps.workspace.listMail({
      ...(accountId ? { accountId } : {}),
      limit: 40
    })
    // Scoring decides *which* messages appear here; the date decides the order
    // they are read in. Mixing the two made the list jump around in time,
    // which is hard to scan. Every message keeps its score and reasons — the
    // badges and the "raised because…" line render from the message itself.
    const flagged = sortByNewest(
      needingAttention(result.items, { ownAddresses: this.ownAddresses() })
    )

    const text =
      flagged.length === 0
        ? 'Nothing in your recent mail looks like it needs attention.'
        : `${flagged.length} ${flagged.length === 1 ? 'message looks' : 'messages look'} like they need attention, newest first. ` +
          `I picked these out on what Microsoft already tells me — unread, flagged, marked important, addressed to you directly — and on what the messages say.`

    return this.reply({ text, messages: flagged, result, kind: 'results' })
  }

  private async handleSearch(question: string, route: Route): Promise<JarvisReply> {
    const accountId = this.resolveAccountId(route)
    const sender = extractSenderName(question)
    const terms = route.searchTerms ?? sender ?? ''

    if (!terms) {
      return notice('Tell me what to look for — a sender, a subject, or a phrase.')
    }

    const result = await this.deps.workspace.listMail({
      ...(accountId ? { accountId } : {}),
      search: terms,
      limit: 25
    })
    // Graph returns search hits in relevance order; newest first is what a
    // person scanning results actually wants.
    const scored = sortByNewest(scoreMessages(result.items, { ownAddresses: this.ownAddresses() }))

    const where = accountId
      ? ` in ${result.checkedAccounts[0] ?? 'that account'}`
      : result.checkedAccounts.length > 1
        ? ` across ${result.checkedAccounts.length} accounts`
        : ''

    const text =
      scored.length === 0
        ? `I could not find any mail matching "${terms}"${where}.`
        : `${scored.length} ${scored.length === 1 ? 'message' : 'messages'} matching "${terms}"${where}.`

    return this.reply({
      text,
      messages: scored,
      result,
      kind: scored.length === 0 ? 'insufficient' : 'results',
      suggestions:
        scored.length === 0
          ? [
              'Try a different word from the subject line.',
              'Search a sender name instead, for example "emails from Sarah".',
              'If the message is older, it may be outside the mail Jarvis reads.'
            ]
          : []
    })
  }

  // -- answering: the only path that sends anything ----------------------

  private async handleAnswer(
    question: string,
    route: Route,
    signal?: AbortSignal
  ): Promise<JarvisReply> {
    const accountId = this.resolveAccountId(route)
    const terms = route.searchTerms ?? extractSenderName(question)

    // Retrieve deterministically first — a search when the user named a
    // subject, the recent inbox otherwise.
    const result = terms
      ? await this.deps.workspace.listMail({ ...(accountId ? { accountId } : {}), search: terms, limit: 15 })
      : await this.deps.workspace.listMail({
          ...(accountId ? { accountId } : {}),
          unreadOnly: /\bunread\b/i.test(question),
          limit: 20
        })

    const scored = scoreMessages(result.items, { ownAddresses: this.ownAddresses() })

    if (scored.length === 0) {
      return this.reply({
        text: terms
          ? `I could not find any mail about "${terms}" to answer from.`
          : 'There is no recent mail to answer from.',
        messages: [],
        result,
        kind: 'insufficient',
        suggestions: ['Try naming the sender or a word from the subject line.']
      })
    }

    const provider = this.deps.providers.active()
    if (!provider) {
      return this.reply({
        text:
          `I found ${scored.length} relevant ${scored.length === 1 ? 'message' : 'messages'}, but reading and summarising them needs an AI provider. ` +
          'Add a key in Settings → AI Provider.',
        messages: scored,
        result,
        kind: 'notice'
      })
    }

    // Fetch bodies only for the handful actually being read.
    const detailed = await this.withBodies(scored.slice(0, 6))
    return this.answerFrom(question, detailed, scored, result, provider, signal)
  }

  /** Load full bodies for a small set, falling back to the preview on failure. */
  private async withBodies(messages: readonly ScoredMailMessage[]): Promise<MailMessage[]> {
    const loaded = await Promise.all(
      messages.map(async (message) => {
        if (message.body) return message
        try {
          return await this.deps.workspace.getMessage(message.accountId, message.id) ?? message
        } catch {
          // A body we cannot fetch is not a reason to fail the whole answer;
          // the preview still carries real content.
          return message
        }
      })
    )
    return loaded
  }

  private async answerFrom(
    question: string,
    detailed: readonly MailMessage[],
    scored: ScoredMailMessage[],
    result: { checkedAccounts: string[]; failures: Array<{ reason: string }> },
    provider: AIProvider,
    signal?: AbortSignal
  ): Promise<JarvisReply> {
    const model = this.deps.providers.activeModelId
    const bundle = buildMailExcerpts(detailed, {
      maxChars: this.deps.maxContextChars(),
      maxMessages: 6
    })

    if (bundle.excerpts.length === 0) {
      return this.reply({
        text: 'I found matching messages but could not read their contents.',
        messages: scored,
        result,
        kind: 'insufficient'
      })
    }

    const disclosure = mailDisclosure(
      bundle,
      { id: provider.id, label: provider.label, local: provider.local },
      model
    )

    this.deps.logger.info('mail.external_call', {
      providerId: provider.id,
      local: provider.local,
      model,
      excerptCount: bundle.excerpts.length,
      charsSent: bundle.charsSent,
      accounts: bundle.accountLabels
    })

    let text: string
    try {
      const response = await provider.complete(
        {
          system: MAIL_ANSWER_SYSTEM,
          maxTokens: 2000,
          messages: [
            {
              role: 'user',
              content: `Question: ${question}\n\nEmails:\n\n${renderMailExcerpts(bundle.excerpts)}`
            }
          ],
          ...(signal ? { signal } : {})
        },
        model
      )
      text = response.text.trim()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.logger.error('mail.external_call_failed', { providerId: provider.id, error: message })
      return this.reply({
        text: `I found the messages below, but could not read them just now. ${message}`,
        messages: scored,
        result,
        kind: 'notice'
      })
    }

    if (text.toUpperCase().startsWith(INSUFFICIENT)) {
      const detail = text.slice(INSUFFICIENT.length).replace(/^[:\s]+/, '').trim()
      return this.reply({
        text: `I could not find enough in these messages to answer that${detail ? `: ${detail}` : '.'}`,
        messages: scored,
        result,
        kind: 'insufficient',
        disclosure,
        mailSources: citedMailSources('', bundle.excerpts)
      })
    }

    return this.reply({
      text,
      messages: scored,
      result,
      kind: 'answer',
      disclosure,
      mailSources: citedMailSources(text, bundle.excerpts)
    })
  }

  // -- drafting: produces text, never a send -----------------------------

  private async handleDraft(
    question: string,
    route: Route,
    signal?: AbortSignal
  ): Promise<JarvisReply> {
    const provider = this.deps.providers.active()
    if (!provider) {
      return notice('Drafting a reply needs an AI provider. Add a key in Settings → AI Provider.')
    }

    const accountId = this.resolveAccountId(route)
    const sender = extractSenderName(question)
    const terms = sender ?? route.searchTerms

    const result = terms
      ? await this.deps.workspace.listMail({ ...(accountId ? { accountId } : {}), search: terms, limit: 10 })
      : await this.deps.workspace.listMail({ ...(accountId ? { accountId } : {}), limit: 10 })

    const candidates = scoreMessages(result.items, { ownAddresses: this.ownAddresses() })
    // Reply to the most recent matching message; the user can pick another
    // from the list and draft against that instead.
    const target = [...candidates].sort((a, b) => b.receivedAt - a.receivedAt)[0]

    if (!target) {
      return this.reply({
        text: terms
          ? `I could not find a message from "${terms}" to reply to.`
          : 'I could not find a recent message to reply to.',
        messages: [],
        result,
        kind: 'insufficient',
        suggestions: ['Open the message in Messages and use Draft reply there.']
      })
    }

    return this.draftFor(target.accountId, target.id, question, signal)
  }

  /**
   * Draft a reply to a specific message. Used both conversationally and from
   * the Messages workspace. Returns a draft for review — nothing is sent.
   */
  async draftFor(
    accountId: string,
    messageId: string,
    instruction: string,
    signal?: AbortSignal
  ): Promise<JarvisReply> {
    const provider = this.deps.providers.active()
    if (!provider) {
      return notice('Drafting a reply needs an AI provider. Add a key in Settings → AI Provider.')
    }

    const account = this.deps.workspace.accounts().find((a) => a.id === accountId)
    if (!account) return notice('That account is no longer connected.')

    const message = await this.deps.workspace.getMessage(accountId, messageId)
    if (!message) return notice('That message could not be loaded.')

    const thread = message.conversationId
      ? await this.deps.workspace.getThread(accountId, message.conversationId).catch(() => [])
      : []

    const draft = await draftReply(
      {
        replyTo: message,
        instruction,
        thread,
        account,
        ownAddresses: this.ownAddresses(),
        maxContextChars: this.deps.maxContextChars()
      },
      provider,
      this.deps.providers.activeModelId,
      signal
    )

    this.deps.logger.info('mail.draft_created', {
      accountLabel: account.label,
      // The draft body is never logged.
      recipients: draft.to.length + draft.cc.length
    })

    return {
      kind: 'answer',
      capability: 'mail',
      text:
        `I have drafted a reply to ${message.from?.name ?? message.from?.address ?? 'the sender'}. ` +
        'Nothing has been sent — review it, edit it if you need to, then choose Review & Send.',
      results: [],
      sources: [],
      suggestions: [],
      draft,
      ...(draft.disclosure ? { disclosure: draft.disclosure } : {})
    }
  }

  // -- shared reply assembly ---------------------------------------------

  private reply(input: {
    text: string
    messages: ScoredMailMessage[]
    result: { checkedAccounts: string[]; failures: Array<{ reason: string }> }
    kind: JarvisReply['kind']
    suggestions?: string[]
    disclosure?: JarvisReply['disclosure']
    mailSources?: JarvisReply['mailSources']
  }): JarvisReply {
    const total = this.deps.workspace.accounts().length
    const coverage = describeCoverage(
      { items: [], checkedAccounts: input.result.checkedAccounts, failures: input.result.failures as never },
      total
    )

    const reply: JarvisReply = {
      kind: input.kind,
      capability: 'mail',
      text: input.text,
      results: [],
      sources: [],
      suggestions: input.suggestions ?? [],
      messages: input.messages
    }
    if (coverage) reply.coverage = coverage
    if (input.disclosure) reply.disclosure = input.disclosure
    if (input.mailSources) reply.mailSources = input.mailSources
    return reply
  }
}

function notice(text: string): JarvisReply {
  return { kind: 'notice', capability: 'mail', text, results: [], sources: [], suggestions: [] }
}
