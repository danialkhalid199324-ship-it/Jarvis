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
  openDataFolder: 'jarvis:openDataFolder'
} as const

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
