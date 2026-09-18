import type { AIProvider } from '../ai/provider'
import { buildMailExcerpts, mailDisclosure, renderMailExcerpts } from './mail-context'
import type { EmailDraft, MailMessage, ConnectedAccount } from '../../shared/communication'

const DRAFT_SYSTEM = `You are Jarvis, drafting an email reply on behalf of a busy executive.

Rules:
1. Write only the body of the reply. No subject line, no "Subject:", no email headers.
2. Match the register of the thread you are replying to — professional and direct, neither stiff nor chatty.
3. Be brief. Most replies are two to five sentences. Do not pad.
4. Use only facts present in the thread or in the user's instruction. Never invent a date, a number, a name, a price or a commitment.
5. If the instruction requires a detail the thread does not contain, leave a clearly marked placeholder in square brackets rather than guessing.
6. Do not add a signature block or sign-off name — the user's mail client adds that.
7. Open with an appropriate greeting using the recipient's first name if it is known.
8. Output the body text only, with no commentary about what you wrote.`

export interface DraftRequest {
  /** The message being replied to. */
  replyTo: MailMessage
  /** What the user asked for, e.g. "say Sunday Zoom works". */
  instruction: string
  /** Earlier messages in the thread, for tone and facts. */
  thread?: readonly MailMessage[]
  account: ConnectedAccount
  /** The signed-in user's own addresses, so they are not added as recipients. */
  ownAddresses: readonly string[]
  maxContextChars: number
}

/** Reply-all recipients, minus the user themselves and any duplicate. */
function replyRecipients(
  message: MailMessage,
  ownAddresses: readonly string[]
): { to: MailMessage['to']; cc: MailMessage['cc'] } {
  const own = ownAddresses.map((a) => a.toLowerCase())
  const seen = new Set<string>()

  const keep = (address: string): boolean => {
    const lower = address.toLowerCase()
    if (own.includes(lower) || seen.has(lower)) return false
    seen.add(lower)
    return true
  }

  // The sender is the primary recipient of a reply.
  const to = message.from && keep(message.from.address) ? [message.from] : []
  // Everyone else who was on the original stays copied, minus the user.
  const cc = [...message.to, ...message.cc].filter((r) => keep(r.address))

  return { to, cc }
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`
}

/**
 * Write a reply.
 *
 * This produces text and nothing else. There is no code path from here to
 * Microsoft Graph: sending requires a SEND_EMAIL action to be proposed,
 * displayed in full, and explicitly approved by the user.
 *
 * @throws when no AI provider is configured — Jarvis says so rather than
 * fabricating a reply.
 */
export async function draftReply(
  request: DraftRequest,
  provider: AIProvider,
  model: string,
  signal?: AbortSignal
): Promise<EmailDraft> {
  const context = [...(request.thread ?? []), request.replyTo]
  // Deduplicate in case the message being replied to is also in the thread.
  const unique = [...new Map(context.map((m) => [m.id, m])).values()].sort(
    (a, b) => a.receivedAt - b.receivedAt
  )

  const bundle = buildMailExcerpts(unique, {
    maxChars: request.maxContextChars,
    maxMessages: 8
  })

  const response = await provider.complete(
    {
      system: DRAFT_SYSTEM,
      maxTokens: 1200,
      messages: [
        {
          role: 'user',
          content:
            `Write a reply to the most recent message below.\n\n` +
            `What the reply should say: ${request.instruction}\n\n` +
            `The thread:\n\n${renderMailExcerpts(bundle.excerpts)}`
        }
      ],
      ...(signal ? { signal } : {})
    },
    model
  )

  const body = response.text.trim()
  const { to, cc } = replyRecipients(request.replyTo, request.ownAddresses)

  const draft: EmailDraft = {
    accountId: request.account.id,
    accountLabel: request.account.label,
    fromAddress: request.account.username,
    to,
    cc,
    subject: replySubject(request.replyTo.subject),
    body,
    inReplyToMessageId: request.replyTo.id,
    disclosure: mailDisclosure(
      bundle,
      { id: provider.id, label: provider.label, local: provider.local },
      model
    )
  }
  if (request.replyTo.conversationId) draft.conversationId = request.replyTo.conversationId

  return draft
}

/**
 * The approval panel's view of a draft: the exact recipients, subject and body
 * that would be sent, with nothing hidden or summarised.
 */
export function draftApprovalPreview(draft: EmailDraft): Array<{ label: string; value: string }> {
  const fields = [
    { label: 'From account', value: `${draft.accountLabel} (${draft.fromAddress})` },
    { label: 'To', value: draft.to.map((r) => r.address).join(', ') || '(no recipient)' }
  ]
  if (draft.cc.length > 0) {
    fields.push({ label: 'Cc', value: draft.cc.map((r) => r.address).join(', ') })
  }
  fields.push({ label: 'Subject', value: draft.subject })
  fields.push({ label: 'Message', value: draft.body })
  return fields
}
