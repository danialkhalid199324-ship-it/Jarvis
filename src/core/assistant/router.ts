import type { Assistant } from './assistant'
import type { Session } from './session'
import type { Logger } from '../logging/logger'
import { routeQuestion, type Route } from './routing'
import type { MailCapability } from './capabilities/mail-capability'
import type { CalendarCapability } from './capabilities/calendar-capability'
import type { DailyBriefService } from '../communication/daily-brief'
import type { MicrosoftWorkspace } from '../microsoft/workspace'
import { formatTime } from '../communication/time'
import type { DailyBrief, JarvisReply } from '../../shared/communication'

export interface RouterDeps {
  /** The V0.1 document assistant, used unchanged. */
  documents: Assistant
  mail: MailCapability
  calendar: CalendarCapability
  brief: DailyBriefService
  workspace: MicrosoftWorkspace
  session: Session
  logger: Logger
}

/**
 * Sends each question to the capability that can answer it.
 *
 * The router owns dispatch and nothing else — it holds no retrieval logic, no
 * prompts and no Graph calls. Each capability is a separate module that can be
 * tested on its own, and adding one later means adding a branch here rather
 * than growing a single assistant function.
 *
 * The document assistant is called through exactly the same entry point it had
 * in V0.1, so every V0.1 behaviour — conversational context, citations,
 * insufficiency handling — is preserved by construction rather than reproduced.
 */
export class JarvisRouter {
  private readonly deps: RouterDeps
  /** Which capability last answered, so short follow-ups stay in place. */
  private lastCapability: JarvisReply['capability'] = 'documents'

  constructor(deps: RouterDeps) {
    this.deps = deps
  }

  /** Exposed for the UI so it can show where a question would go. */
  classify(question: string): Route {
    return routeQuestion(question, {
      accountLabels: this.deps.workspace.accounts().map((a) => a.label),
      hasMailContext: this.lastCapability === 'mail',
      hasCalendarContext: this.lastCapability === 'calendar'
    })
  }

  async ask(question: string, signal?: AbortSignal): Promise<JarvisReply> {
    const route = this.classify(question)
    this.deps.logger.info('router.dispatch', {
      capability: route.capability,
      mailIntent: route.mailIntent,
      calendarIntent: route.calendarIntent,
      reason: route.reason
    })

    const reply = await this.dispatch(question, route, signal)
    // Only remember a capability that actually produced something to follow up
    // on, so a failed mail lookup does not capture the next question.
    if (reply.kind !== 'notice') this.lastCapability = reply.capability ?? 'documents'
    return reply
  }

  private async dispatch(
    question: string,
    route: Route,
    signal?: AbortSignal
  ): Promise<JarvisReply> {
    switch (route.capability) {
      case 'mail':
        return this.deps.mail.handle(question, route, signal)

      case 'calendar':
        return this.deps.calendar.handle(question, route)

      case 'brief':
        return this.briefReply(signal)

      case 'documents':
      default:
        return this.documentsWithMailFallback(question, route, signal)
    }
  }

  /**
   * Answer from local documents, and only if that finds nothing, look in mail.
   *
   * This exists for questions like "What happened with the Bluebird invoice?",
   * which could reasonably mean either. Documents are searched first and win
   * outright when they match, so V0.1 behaviour is untouched; the mail search
   * runs only on an empty result and is labelled clearly when it does.
   */
  private async documentsWithMailFallback(
    question: string,
    route: Route,
    signal?: AbortSignal
  ): Promise<JarvisReply> {
    const documentReply: JarvisReply = await this.deps.documents.ask(question, signal)
    documentReply.capability = 'documents'

    const foundNothing = documentReply.kind === 'insufficient' && documentReply.results.length === 0
    const canSearchMail =
      this.deps.workspace.isConfigured() && this.deps.workspace.hasAccounts()

    if (!foundNothing || !canSearchMail || route.reason === 'explicit document vocabulary') {
      return documentReply
    }

    const mailReply = await this.deps.mail.handle(
      question,
      { ...route, capability: 'mail', mailIntent: 'search', ...(route.searchTerms ? {} : { searchTerms: question }) },
      signal
    )

    if (!mailReply.messages || mailReply.messages.length === 0) {
      // Nothing anywhere. Say so once, mentioning both places were checked.
      return {
        ...documentReply,
        text: `${documentReply.text} I also checked your connected Microsoft accounts and found nothing matching.`
      }
    }

    return {
      ...mailReply,
      text: `I could not find that in your documents, but your email has ${
        mailReply.messages.length === 1 ? 'a match' : `${mailReply.messages.length} matches`
      }.\n\n${mailReply.text}`
    }
  }

  /**
   * The daily brief, written as an executive would want to read it.
   *
   * One factual headline — what is in the diary, what is in the inbox — then
   * the written summary. The cards underneath are evidence for it, not the
   * answer itself, which is why the counts are stated in a sentence rather than
   * left for the user to work out by scrolling.
   */
  private async briefReply(signal?: AbortSignal): Promise<JarvisReply> {
    const brief = await this.deps.brief.build(signal)
    const { facts } = brief

    const headline = `${briefCalendarLine(facts)} ${briefMailLine(facts)}`.trim()

    const body = brief.focus ?? brief.focusUnavailableReason ?? ''
    const reply: JarvisReply = {
      kind: 'answer',
      capability: 'brief',
      shape: 'brief',
      text: body ? `${headline}\n\n${body}` : headline,
      results: [],
      sources: [],
      suggestions: [],
      messages: facts.priorityMail,
      events: facts.meetingsToday
    }
    if (brief.disclosure) reply.disclosure = brief.disclosure
    if (brief.failures.length > 0) {
      reply.coverage = `I checked ${brief.accountsChecked} of your ${brief.accountsTotal} connected accounts. ${brief.failures
        .map((f) => f.reason)
        .join(' ')}`
    }
    return reply
  }

  /** Reset conversational routing along with the session. */
  reset(): void {
    this.lastCapability = 'documents'
    this.deps.session.clear()
  }
}

/** What is in the diary, in one honest sentence. */
function briefCalendarLine(facts: DailyBrief['facts']): string {
  // Not "your day is clear": Jarvis can see the connected calendar and nothing
  // else, so an empty one is a fact about the calendar, not about the day.
  if (facts.meetingsToday.length === 0) {
    return 'No meetings are showing on your connected calendar today.'
  }
  const count = `${facts.meetingsToday.length} ${
    facts.meetingsToday.length === 1 ? 'meeting' : 'meetings'
  } today`
  return facts.nextMeeting
    ? `${count}, next at ${formatTime(facts.nextMeeting.start)}.`
    : `${count}, all now finished.`
}

/** What is in the inbox, in one honest sentence. */
function briefMailLine(facts: DailyBrief['facts']): string {
  if (facts.unreadCount === 0 && facts.needsAttentionCount === 0) {
    return 'Nothing unread and nothing flagged for attention.'
  }
  const unread = `${facts.unreadCount} unread`
  return facts.needsAttentionCount === 0
    ? `${unread}, none of which looks like it needs attention.`
    : `${unread}, ${facts.needsAttentionCount} ${
        facts.needsAttentionCount === 1 ? 'message needs' : 'messages need'
      } attention.`
}
