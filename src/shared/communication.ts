/**
 * Types for Jarvis's communication layer (V0.2): Microsoft 365 mail and
 * calendar, drafts, approvals and the daily brief.
 *
 * Like `types.ts`, everything here crosses the IPC boundary and must be
 * structured-clone safe. Nothing in this file ever carries a token, an auth
 * code or a client secret — see `ConnectedAccount`, which deliberately holds
 * only identity and status.
 */

import type { DocumentMeta, ExternalCallDisclosure } from './types'

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export type AccountStatus =
  /** Signed in and usable. */
  | 'connected'
  /** Tokens expired or consent revoked — the user must sign in again. */
  | 'needs_reauth'
  /** Reachable but the last operation failed. */
  | 'error'

/**
 * A connected Microsoft 365 account, as shown to the user.
 *
 * This is the *only* account shape that reaches the renderer. Access tokens,
 * refresh tokens and the MSAL cache never appear here or anywhere outside the
 * main process.
 */
export interface ConnectedAccount {
  /** Stable Jarvis-local id. */
  id: string
  /** Sign-in name, i.e. the email address. */
  username: string
  displayName: string
  /** Microsoft tenant the account belongs to. */
  tenantId: string
  /** User-defined label, e.g. "GTA". Falls back to the display name. */
  label: string
  connectedAt: string
  lastSyncAt: number | null
  status: AccountStatus
  /** Plain-language explanation when status is not 'connected'. */
  statusDetail?: string
}

/** One account that could not be reached during a multi-account operation. */
export interface AccountFailure {
  accountId: string
  accountLabel: string
  /** Machine-readable cause. */
  kind: GraphErrorKind
  /** Plain-language explanation shown to the user. */
  reason: string
}

/**
 * The result of an operation spanning several accounts.
 *
 * Successes and failures are returned together and never conflated: Jarvis must
 * be able to say "I checked 3 of your 4 accounts" rather than silently
 * presenting partial data as complete.
 */
export interface MultiAccountResult<T> {
  items: T[]
  /** Labels of accounts that answered successfully. */
  checkedAccounts: string[]
  failures: AccountFailure[]
}

export type GraphErrorKind =
  | 'auth'
  | 'consent'
  | 'not_found'
  | 'throttled'
  | 'offline'
  | 'timeout'
  | 'server'
  | 'unknown'

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

export interface MailAddress {
  name?: string
  address: string
}

export interface MailMessage {
  id: string
  /** Which connected account this message belongs to. Never inferred. */
  accountId: string
  accountLabel: string
  conversationId: string
  subject: string
  from: MailAddress | null
  to: MailAddress[]
  cc: MailAddress[]
  receivedAt: number
  isRead: boolean
  importance: 'low' | 'normal' | 'high'
  isFlagged: boolean
  hasAttachments: boolean
  /** Short server-provided preview. Always present. */
  preview: string
  /** Full plain-text body. Only populated when the message is opened. */
  body?: string
  webLink?: string
}

/** Why Jarvis thinks a message needs attention. Computed without any AI. */
export interface AttentionAssessment {
  needsAttention: boolean
  /** Higher means more pressing. Only meaningful relative to siblings. */
  score: number
  /** Plain-language signals, e.g. "marked high importance", "addressed to you". */
  reasons: string[]
}

export interface ScoredMailMessage extends MailMessage {
  attention: AttentionAssessment
}

export interface MailQuery {
  /** Restrict to one account; omit to search every connected account. */
  accountId?: string
  /** Free-text search passed to Microsoft Graph. */
  search?: string
  /** Only unread messages. */
  unreadOnly?: boolean
  /** Maximum messages per account. */
  limit?: number
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface EventAttendee {
  name?: string
  address: string
  /** Graph response status, e.g. accepted / declined / none. */
  response?: string
  /** True for the meeting's required attendees. */
  required?: boolean
}

export interface CalendarEvent {
  id: string
  accountId: string
  accountLabel: string
  subject: string
  /** Epoch millis. */
  start: number
  end: number
  isAllDay: boolean
  location?: string
  onlineMeetingUrl?: string
  organizer: MailAddress | null
  attendees: EventAttendee[]
  isCancelled: boolean
  bodyPreview?: string
  webLink?: string
}

export interface CalendarQuery {
  accountId?: string
  /** Epoch millis, inclusive. */
  from: number
  /** Epoch millis, exclusive. */
  to: number
}

/** A gap between meetings, used to answer "when am I free?". */
export interface FreeSlot {
  start: number
  end: number
  minutes: number
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export interface EmailDraft {
  /** The account the message would be sent from. Always explicit. */
  accountId: string
  accountLabel: string
  fromAddress: string
  to: MailAddress[]
  cc: MailAddress[]
  subject: string
  body: string
  /** Set when this is a reply, so Graph can thread it correctly. */
  inReplyToMessageId?: string
  conversationId?: string
  /** Which messages Jarvis read to write this draft. */
  disclosure?: ExternalCallDisclosure
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export type PendingActionType = 'SEND_EMAIL' | 'CREATE_EVENT' | 'UPDATE_EVENT' | 'DELETE_EVENT'

export type PendingActionStatus =
  /** Prepared and waiting for the user. Nothing has happened outside Jarvis. */
  | 'PROPOSED'
  /** The user approved it; execution is about to begin. */
  | 'APPROVED'
  | 'EXECUTING'
  | 'COMPLETED'
  /** The user declined. Terminal. */
  | 'REJECTED'
  | 'FAILED'

export type RiskLevel = 'low' | 'medium' | 'high'

/** One labelled before/after row in an approval panel. */
export interface ApprovalField {
  label: string
  value: string
  /** Present when this field would change; `value` is then the proposed value. */
  previous?: string
}

/**
 * A consequential action Jarvis has prepared but not performed.
 *
 * Nothing leaves Jarvis while an action is PROPOSED. Only an explicit user
 * approval moves it forward, and only the approval engine can execute it —
 * there is no path from a conversational instruction to execution.
 */
export interface PendingAction {
  id: string
  type: PendingActionType
  status: PendingActionStatus
  riskLevel: RiskLevel
  /** One-line summary, e.g. "Send email to sarah@example.com". */
  description: string
  /** What prompted this, e.g. the user's own words. */
  source: string
  accountId: string
  accountLabel: string
  /** Everything the approval panel needs to render, including before/after. */
  preview: ApprovalField[]
  /** Extra warning shown for destructive actions. */
  warning?: string
  createdAt: number
  expiresAt: number
  completedAt?: number
  /** Populated when status is FAILED. */
  error?: string
  /** Set once executed, e.g. the created event id. */
  resultSummary?: string
}

// ---------------------------------------------------------------------------
// Daily brief
// ---------------------------------------------------------------------------

/**
 * The daily brief keeps retrieved fact and AI judgement strictly apart:
 * `facts` is what Jarvis actually read, `focus` is the model's prioritisation
 * of it, labelled as such in the UI.
 */
export interface DailyBrief {
  generatedAt: number
  facts: {
    meetingsToday: CalendarEvent[]
    nextMeeting: CalendarEvent | null
    unreadCount: number
    needsAttentionCount: number
    /** The highest-scoring messages, already filtered deterministically. */
    priorityMail: ScoredMailMessage[]
    recentDocuments: DocumentMeta[]
  }
  /** AI-generated executive summary. Null when no provider is configured. */
  focus: string | null
  /** Why `focus` is null, when it is. */
  focusUnavailableReason?: string
  disclosure?: ExternalCallDisclosure
  accountsChecked: number
  accountsTotal: number
  failures: AccountFailure[]
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/** Real counts for the Home cards. Every field is retrieved, never invented. */
export interface DashboardSummary {
  mail: {
    available: boolean
    needsAttention: number
    unread: number
  }
  calendar: {
    available: boolean
    today: number
    nextSubject?: string
    nextStart?: number
  }
  documents: {
    indexed: number
    lastIndexedAt: number | null
  }
  accountsTotal: number
  accountsChecked: number
  failures: AccountFailure[]
}
