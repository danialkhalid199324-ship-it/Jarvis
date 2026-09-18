import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type BootstrapInfo,
  type DocumentListQuery,
  type DocumentListResult,
  type MicrosoftStatus
} from '../shared/ipc'
import type {
  CalendarEvent,
  ConnectedAccount,
  DailyBrief,
  DashboardSummary,
  EmailDraft,
  JarvisReply,
  MailMessage,
  MailQuery,
  MultiAccountResult,
  PendingAction
} from '../shared/communication'
import type {
  AssistantReply,
  AuthorisedFolder,
  IndexStats,
  IndexStatus,
  IpcResult,
  JarvisSettings,
  LogEntry,
  ProviderDescriptor
} from '../shared/types'

/**
 * The only bridge between the UI and the rest of Jarvis.
 *
 * Everything exposed here is an explicit, named operation. The renderer gets no
 * `require`, no filesystem access and no way to reach a channel that is not on
 * this list — so a bug or a malicious string in a document cannot widen what
 * the UI is able to do.
 */

/** Unwrap the main process's result envelope, turning failures into throws. */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!result.ok) throw new Error(result.error)
  return result.value
}

const api = {
  getBootstrap: (): Promise<BootstrapInfo> => call(IPC.getBootstrap),

  settings: {
    get: (): Promise<JarvisSettings> => call(IPC.getSettings),
    update: (patch: Partial<JarvisSettings>): Promise<JarvisSettings> =>
      call(IPC.updateSettings, patch)
  },

  folders: {
    /** Opens the native folder picker. Resolves to null if the user cancels. */
    choose: (): Promise<AuthorisedFolder | null> => call(IPC.chooseFolder),
    remove: (folderId: string): Promise<AuthorisedFolder | null> =>
      call(IPC.removeFolder, folderId)
  },

  index: {
    start: (options?: { force?: boolean }): Promise<IndexStatus> => call(IPC.startIndexing, options),
    cancel: (): Promise<IndexStatus> => call(IPC.cancelIndexing),
    status: (): Promise<IndexStatus> => call(IPC.getIndexStatus),
    stats: (): Promise<IndexStats> => call(IPC.getIndexStats),
    deleteAll: (): Promise<IndexStats> => call(IPC.deleteIndex),
    onStatusChange: (listener: (status: IndexStatus) => void): (() => void) => {
      const handler = (_event: unknown, status: IndexStatus): void => listener(status)
      ipcRenderer.on(IPC.indexStatusChanged, handler)
      return () => ipcRenderer.removeListener(IPC.indexStatusChanged, handler)
    }
  },

  documents: {
    list: (query?: DocumentListQuery): Promise<DocumentListResult> => call(IPC.listDocuments, query),
    open: (documentId: string): Promise<boolean> => call(IPC.openDocument, documentId),
    reveal: (documentId: string): Promise<boolean> => call(IPC.revealDocument, documentId)
  },

  assistant: {
    ask: (question: string): Promise<JarvisReply> => call(IPC.ask, question),
    clearConversation: (): Promise<boolean> => call(IPC.clearConversation),
    /** Scope the conversation to chosen documents; pass [] to clear. */
    selectDocuments: (documentIds: string[]): Promise<string[]> =>
      call(IPC.selectDocuments, documentIds)
  },

  providers: {
    list: (): Promise<ProviderDescriptor[]> => call(IPC.listProviders),
    setApiKey: (providerId: string, apiKey: string): Promise<boolean> =>
      call(IPC.setApiKey, providerId, apiKey),
    clearApiKey: (providerId: string): Promise<boolean> => call(IPC.clearApiKey, providerId)
  },

  diagnostics: {
    activityLog: (limit?: number): Promise<LogEntry[]> => call(IPC.getActivityLog, limit),
    openDataFolder: (): Promise<boolean> => call(IPC.openDataFolder)
  },

  /**
   * Microsoft 365. Note what is absent: there is no way to read a token, a
   * refresh token or an auth code from here. The renderer can ask Jarvis to
   * connect an account and can see the account's identity and status, and
   * nothing else.
   */
  microsoft: {
    status: (): Promise<MicrosoftStatus> => call(IPC.msGetStatus),
    setClientId: (clientId: string): Promise<MicrosoftStatus> => call(IPC.msSetClientId, clientId),
    connect: (): Promise<ConnectedAccount> => call(IPC.msConnect),
    disconnect: (accountId: string): Promise<MicrosoftStatus> => call(IPC.msDisconnect, accountId),
    sync: (accountId: string): Promise<ConnectedAccount | null> => call(IPC.msSyncAccount, accountId),
    setLabel: (accountId: string, label: string): Promise<ConnectedAccount | null> =>
      call(IPC.msSetAccountLabel, accountId, label)
  },

  mail: {
    list: (query?: MailQuery): Promise<MultiAccountResult<MailMessage>> => call(IPC.mailList, query),
    get: (accountId: string, messageId: string): Promise<MailMessage | null> =>
      call(IPC.mailGet, accountId, messageId),
    /** Produces a draft for review. Never sends. */
    draftReply: (accountId: string, messageId: string, instruction: string): Promise<JarvisReply> =>
      call(IPC.mailDraftReply, accountId, messageId, instruction)
  },

  calendar: {
    list: (query: { from: number; to: number; accountId?: string }): Promise<MultiAccountResult<CalendarEvent>> =>
      call(IPC.calendarList, query)
  },

  /**
   * Approvals. `approve` is the only call in this whole bridge that can cause
   * a change outside Jarvis, and it takes nothing but the id of an action the
   * user has already been shown in full.
   */
  approvals: {
    pending: (): Promise<PendingAction[]> => call(IPC.approvalsPending),
    prepareSend: (draft: EmailDraft): Promise<PendingAction> => call(IPC.approvalsPrepareSend, draft),
    approve: (actionId: string): Promise<PendingAction> => call(IPC.approvalsApprove, actionId),
    reject: (actionId: string): Promise<PendingAction> => call(IPC.approvalsReject, actionId)
  },

  brief: {
    today: (): Promise<DailyBrief> => call(IPC.dailyBrief),
    dashboard: (): Promise<DashboardSummary> => call(IPC.dashboard)
  }
}

export type JarvisApi = typeof api

contextBridge.exposeInMainWorld('jarvis', api)
