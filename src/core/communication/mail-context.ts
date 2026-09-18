import type { ExternalCallDisclosure } from '../../shared/types'
import type { MailMessage, MailSourceReference } from '../../shared/communication'

/** One email passage prepared for the AI provider. */
export interface MailExcerpt {
  /** 1-based number the model cites with. */
  number: number
  messageId: string
  accountId: string
  accountLabel: string
  subject: string
  from: string
  receivedAt: number
  /** Header line plus trimmed body. This is all that leaves the machine. */
  text: string
}

export interface MailExcerptBundle {
  excerpts: MailExcerpt[]
  charsSent: number
  subjects: string[]
  accountLabels: string[]
}

/** Per-message ceiling, so one long thread cannot crowd out the rest. */
const PER_MESSAGE_CHARS = 2_200

function formatDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 16).replace('T', ' ')
}

/**
 * Assemble the email text that will be sent to the AI provider.
 *
 * The mail counterpart of the document excerpt builder, and the only place
 * message content is prepared to leave the machine. It sends the messages
 * Jarvis actually selected, truncated, under a hard overall budget — never a
 * mailbox, never a folder, never "everything from this sender".
 *
 * A message with no body loaded contributes only its server-side preview, so
 * listing mail and answering about it cost the same in privacy terms as what
 * the user already saw on screen.
 */
export function buildMailExcerpts(
  messages: readonly MailMessage[],
  options: { maxChars: number; maxMessages: number }
): MailExcerptBundle {
  const excerpts: MailExcerpt[] = []
  let charsSent = 0
  let number = 1

  for (const message of messages.slice(0, options.maxMessages)) {
    const bodyRaw = (message.body ?? message.preview ?? '').trim()
    if (!bodyRaw && !message.subject) continue

    const body =
      bodyRaw.length > PER_MESSAGE_CHARS
        ? `${bodyRaw.slice(0, PER_MESSAGE_CHARS)}…[truncated]`
        : bodyRaw

    // The header is part of the answer's grounding: who sent it and when is
    // often the whole point of the question.
    const header = [
      `Account: ${message.accountLabel}`,
      `From: ${message.from ? `${message.from.name ?? ''} <${message.from.address}>`.trim() : 'unknown'}`,
      `Date: ${formatDate(message.receivedAt)}`,
      `Subject: ${message.subject}`,
      message.isRead ? null : 'Status: unread'
    ]
      .filter(Boolean)
      .join('\n')

    const text = `${header}\n\n${body}`
    if (charsSent + text.length > options.maxChars && excerpts.length > 0) break

    excerpts.push({
      number,
      messageId: message.id,
      accountId: message.accountId,
      accountLabel: message.accountLabel,
      subject: message.subject,
      from: message.from?.address ?? 'unknown',
      receivedAt: message.receivedAt,
      text
    })
    charsSent += text.length
    number++
  }

  return {
    excerpts,
    charsSent,
    subjects: [...new Set(excerpts.map((e) => e.subject))],
    accountLabels: [...new Set(excerpts.map((e) => e.accountLabel))]
  }
}

/** Render excerpts for the prompt, numbered so the model can cite them. */
export function renderMailExcerpts(excerpts: readonly MailExcerpt[]): string {
  return excerpts.map((e) => `[${e.number}]\n${e.text}`).join('\n\n---\n\n')
}

/** Which emails the answer actually cited. */
export function citedMailSources(
  answer: string,
  excerpts: readonly MailExcerpt[]
): MailSourceReference[] {
  const cited = new Set<number>()
  for (const match of answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const part of match[1]!.split(',')) {
      const n = Number.parseInt(part.trim(), 10)
      if (Number.isFinite(n)) cited.add(n)
    }
  }

  // With no citations, list everything the model saw — the user must always be
  // able to check an answer against the messages behind it.
  const relevant = cited.size > 0 ? excerpts.filter((e) => cited.has(e.number)) : excerpts

  return relevant.map((e) => ({
    messageId: e.messageId,
    accountId: e.accountId,
    accountLabel: e.accountLabel,
    subject: e.subject,
    from: e.from,
    receivedAt: e.receivedAt
  }))
}

/** Statement of exactly what was sent, shown on every AI-generated mail answer. */
export function mailDisclosure(
  bundle: MailExcerptBundle,
  provider: { id: string; label: string; local: boolean },
  model: string
): ExternalCallDisclosure {
  return {
    providerId: provider.id,
    providerLabel: provider.label,
    local: provider.local,
    model,
    excerptCount: bundle.excerpts.length,
    charsSent: bundle.charsSent,
    // `fileNames` stays empty: this is mail, not documents.
    fileNames: [],
    itemKind: 'emails',
    itemLabels: bundle.subjects,
    accountLabels: bundle.accountLabels
  }
}
