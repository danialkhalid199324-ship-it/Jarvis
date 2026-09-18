/** IPC channel names. Kept in one place so main and preload cannot drift. */
export const IPC = {
  // Bootstrap
  getBootstrap: 'jarvis:getBootstrap',

  // Settings & permissions
  getSettings: 'jarvis:getSettings',
  updateSettings: 'jarvis:updateSettings',
  chooseFolder: 'jarvis:chooseFolder',
  removeFolder: 'jarvis:removeFolder',

  // Indexing
  startIndexing: 'jarvis:startIndexing',
  cancelIndexing: 'jarvis:cancelIndexing',
  getIndexStatus: 'jarvis:getIndexStatus',
  getIndexStats: 'jarvis:getIndexStats',
  deleteIndex: 'jarvis:deleteIndex',
  indexStatusChanged: 'jarvis:indexStatusChanged',

  // Documents
  listDocuments: 'jarvis:listDocuments',
  openDocument: 'jarvis:openDocument',
  revealDocument: 'jarvis:revealDocument',

  // Assistant
  ask: 'jarvis:ask',
  clearConversation: 'jarvis:clearConversation',
  selectDocuments: 'jarvis:selectDocuments',

  // AI providers
  listProviders: 'jarvis:listProviders',
  setApiKey: 'jarvis:setApiKey',
  clearApiKey: 'jarvis:clearApiKey',

  // Diagnostics
  getActivityLog: 'jarvis:getActivityLog',
  openDataFolder: 'jarvis:openDataFolder',

  // Microsoft 365 (V0.2)
  msGetStatus: 'jarvis:msGetStatus',
  msSetClientId: 'jarvis:msSetClientId',
  msConnect: 'jarvis:msConnect',
  msDisconnect: 'jarvis:msDisconnect',
  msSyncAccount: 'jarvis:msSyncAccount',
  msSetAccountLabel: 'jarvis:msSetAccountLabel',

  // Mail
  mailList: 'jarvis:mailList',
  mailGet: 'jarvis:mailGet',
  mailDraftReply: 'jarvis:mailDraftReply',

  // Calendar
  calendarList: 'jarvis:calendarList',

  // Approvals — the only route to a consequential action
  approvalsPending: 'jarvis:approvalsPending',
  approvalsPrepareSend: 'jarvis:approvalsPrepareSend',
  approvalsApprove: 'jarvis:approvalsApprove',
  approvalsReject: 'jarvis:approvalsReject',

  // Brief & dashboard
  dailyBrief: 'jarvis:dailyBrief',
  dashboard: 'jarvis:dashboard'
} as const

/** Microsoft connection state, for Settings and the pages that depend on it. */
export interface MicrosoftStatus {
  /** True once an Azure application (client) ID has been supplied. */
  configured: boolean
  /** The client ID in use. Not a secret; shown so the user can check it. */
  clientId: string | null
  accounts: import('./communication').ConnectedAccount[]
  /** Delegated permissions this build requests, with reasons. */
  scopes: Array<{ scope: string; neededFor: string; requiresAdminConsent: boolean }>
}

export interface BootstrapInfo {
  appVersion: string
  /** Where Jarvis keeps its own data. Shown in Settings for transparency. */
  dataDir: string
  secureStorageAvailable: boolean
}

export interface DocumentListQuery {
  /** Free-text filter over file name and folder. */
  search?: string
  folderId?: string
  limit?: number
  offset?: number
}

export interface DocumentListResult {
  documents: import('./types').DocumentMeta[]
  total: number
}
