import { GraphClient } from './graph-client'
import { mapMessage, type GraphMessage } from './mapping'
import type { ConnectedAccount, MailMessage } from '../../shared/communication'

/** Fields Jarvis reads when listing. Kept narrow so responses stay small. */
const LIST_FIELDS =
  'id,conversationId,subject,bodyPreview,from,sender,toRecipients,ccRecipients,receivedDateTime,isRead,importance,hasAttachments,flag,webLink'

/** Listing adds the body only when a single message is opened. */
const DETAIL_FIELDS = `${LIST_FIELDS},body`

export const DEFAULT_MAIL_LIMIT = 25

/**
 * Reading mail from one Microsoft account.
 *
 * Every method takes the account it operates on, and every message it returns
 * is stamped with that account. There is no ambient "current mailbox", so one
 * account's results can never be mistaken for another's.
 */
export class MailService {
  private readonly graph: GraphClient
  private readonly account: ConnectedAccount

  constructor(graph: GraphClient, account: ConnectedAccount) {
    this.graph = graph
    this.account = account
  }

  /** Most recent messages in the inbox, newest first. */
  async recent(limit = DEFAULT_MAIL_LIMIT, unreadOnly = false): Promise<MailMessage[]> {
    const raw = await this.graph.listAll<GraphMessage>('/me/mailFolders/inbox/messages', {
      limit,
      query: {
        $select: LIST_FIELDS,
        $orderby: 'receivedDateTime desc',
        $top: Math.min(limit, 50),
        ...(unreadOnly ? { $filter: 'isRead eq false' } : {})
      }
    })
    return raw.map((m) => mapMessage(m, this.account))
  }

  /**
   * Full-text search across the mailbox.
   *
   * Graph's `$search` cannot be combined with `$orderby`, so results come back
   * in relevance order and Jarvis sorts them by date itself where that reads
   * better.
   */
  async search(query: string, limit = DEFAULT_MAIL_LIMIT): Promise<MailMessage[]> {
    const trimmed = query.trim()
    if (!trimmed) return []
    const raw = await this.graph.listAll<GraphMessage>('/me/messages', {
      limit,
      // Graph requires the search term to be quoted, and ConsistencyLevel for
      // some mailbox queries.
      query: { $search: `"${trimmed.replace(/"/g, '')}"`, $select: LIST_FIELDS, $top: Math.min(limit, 50) },
      headers: { ConsistencyLevel: 'eventual' }
    })
    return raw.map((m) => mapMessage(m, this.account))
  }

  /** One message including its body. */
  async get(messageId: string): Promise<MailMessage> {
    const raw = await this.graph.request<GraphMessage>(
      `/me/messages/${encodeURIComponent(messageId)}`,
      { query: { $select: DETAIL_FIELDS } }
    )
    return mapMessage(raw, this.account)
  }

  /** Every message in a conversation, oldest first, for thread summaries. */
  async thread(conversationId: string, limit = 20): Promise<MailMessage[]> {
    if (!conversationId) return []
    const raw = await this.graph.listAll<GraphMessage>('/me/messages', {
      limit,
      query: {
        $filter: `conversationId eq '${conversationId.replace(/'/g, "''")}'`,
        $select: DETAIL_FIELDS,
        $orderby: 'receivedDateTime asc',
        $top: Math.min(limit, 50)
      }
    })
    return raw.map((m) => mapMessage(m, this.account))
  }

  /** How many unread messages are in the inbox. */
  async unreadCount(): Promise<number> {
    const folder = await this.graph.request<{ unreadItemCount?: number }>('/me/mailFolders/inbox', {
      query: { $select: 'unreadItemCount' }
    })
    return folder.unreadItemCount ?? 0
  }

  /**
   * Send a message.
   *
   * Intentionally unexported from any conversational path: the only caller is
   * the approval engine's SEND_EMAIL executor, which runs solely after the user
   * has approved the exact contents.
   */
  async sendMail(payload: {
    to: string[]
    cc: string[]
    subject: string
    body: string
    replyToMessageId?: string
  }): Promise<void> {
    const recipients = (addresses: string[]): Array<{ emailAddress: { address: string } }> =>
      addresses.map((address) => ({ emailAddress: { address } }))

    // A reply keeps the Graph conversation threaded; a fresh message does not.
    if (payload.replyToMessageId) {
      await this.graph.request(
        `/me/messages/${encodeURIComponent(payload.replyToMessageId)}/reply`,
        {
          method: 'POST',
          body: {
            message: {
              toRecipients: recipients(payload.to),
              ccRecipients: recipients(payload.cc),
              subject: payload.subject
            },
            comment: payload.body
          }
        }
      )
      return
    }

    await this.graph.request('/me/sendMail', {
      method: 'POST',
      body: {
        message: {
          subject: payload.subject,
          body: { contentType: 'Text', content: payload.body },
          toRecipients: recipients(payload.to),
          ccRecipients: recipients(payload.cc)
        },
        saveToSentItems: true
      }
    })
  }

  /** Save a message to the Drafts folder without sending it. */
  async saveDraft(payload: {
    to: string[]
    cc: string[]
    subject: string
    body: string
  }): Promise<string> {
    const created = await this.graph.request<{ id?: string }>('/me/messages', {
      method: 'POST',
      body: {
        subject: payload.subject,
        body: { contentType: 'Text', content: payload.body },
        toRecipients: payload.to.map((address) => ({ emailAddress: { address } })),
        ccRecipients: payload.cc.map((address) => ({ emailAddress: { address } }))
      }
    })
    return created.id ?? ''
  }
}
