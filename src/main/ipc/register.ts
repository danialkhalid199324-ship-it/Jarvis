import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import {
  IPC,
  type BootstrapInfo,
  type DocumentListQuery,
  type DocumentListResult,
  type MicrosoftStatus
} from '../../shared/ipc'
import { GRAPH_SCOPES } from '../../core/microsoft/scopes'
import { draftApprovalPreview } from '../../core/communication/drafts'
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
} from '../../shared/communication'
import type { Services } from '../services'
import { assertReadable } from '../../core/security/paths'
import type {
  AssistantReply,
  AuthorisedFolder,
  DocumentMeta,
  IndexStats,
  IndexStatus,
  IpcResult,
  JarvisSettings,
  LogEntry,
  ProviderDescriptor
} from '../../shared/types'

/**
 * Wrap a handler so the renderer always receives a plain result envelope rather
 * than a raw thrown error. Error text is written for the user, not a developer.
 */
function handle<A extends unknown[], R>(
  channel: string,
  services: Services,
  fn: (...args: A) => Promise<R> | R
): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResult<R>> => {
    try {
      return { ok: true, value: await fn(...(args as A)) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      services.logger.error('ipc.failed', { channel, error: message })
      return { ok: false, error: message }
    }
  })
}

export function registerIpc(services: Services, getWindow: () => BrowserWindow | null): void {
  // -- bootstrap -----------------------------------------------------------

  handle<[], BootstrapInfo>(IPC.getBootstrap, services, () => ({
    appVersion: app.getVersion(),
    dataDir: services.dataDir,
    secureStorageAvailable: services.secrets.isSecureStorageAvailable()
  }))

  // -- settings & permissions ---------------------------------------------

  handle<[], JarvisSettings>(IPC.getSettings, services, () => services.settings.get())

  handle<[Partial<JarvisSettings>], JarvisSettings>(
    IPC.updateSettings,
    services,
    async (patch) => {
      // `folders` is managed through the explicit add/remove handlers so a
      // settings write can never silently widen Jarvis's access.
      const { folders: _ignored, ...safe } = patch
      const updated = await services.settings.update(safe)
      services.syncProviders()
      services.logger.info('settings.updated', { keys: Object.keys(safe) })
      return updated
    }
  )

  /**
   * Authorising a folder is always user-initiated: it opens the native macOS
   * folder picker. Jarvis has no way to add a folder on its own.
   */
  handle<[], AuthorisedFolder | null>(IPC.chooseFolder, services, async () => {
    const window = getWindow()
    const result = await (window
      ? dialog.showOpenDialog(window, {
          title: 'Authorise a folder for Jarvis',
          message: 'Jarvis will read documents in this folder. It will never modify them.',
          buttonLabel: 'Authorise',
          properties: ['openDirectory', 'createDirectory']
        })
      : dialog.showOpenDialog({ properties: ['openDirectory'] }))

    if (result.canceled || result.filePaths.length === 0) return null

    const chosen = result.filePaths[0]!
    const folder = await services.settings.addFolder(chosen)
    services.logger.info('folder.authorised', { path: folder.path, label: folder.label })
    return folder
  })

  handle<[string], AuthorisedFolder | null>(IPC.removeFolder, services, async (folderId) => {
    const removed = await services.settings.removeFolder(folderId)
    if (!removed) return null

    // Revoking access means forgetting what was read from there.
    let dropped = 0
    for (const doc of [...services.store.allDocuments()]) {
      if (doc.folderId === folderId) {
        await services.store.removeDocument(doc.id)
        services.indexer.searchIndex.removeDocument(doc.id)
        dropped++
      }
    }
    await services.store.commit(services.store.lastIndexedAt())
    await services.indexer.searchIndex.save(services.store.root)

    services.logger.info('folder.revoked', { path: removed.path, documentsDropped: dropped })
    return removed
  })

  // -- indexing ------------------------------------------------------------

  const pushStatus = (status: IndexStatus): void => {
    services.indexStatus = status
    getWindow()?.webContents.send(IPC.indexStatusChanged, status)
  }

  handle<[{ force?: boolean }?], IndexStatus>(IPC.startIndexing, services, async (options) => {
    if (services.indexer.isRunning) return services.indexStatus

    const settings = services.settings.get()
    if (settings.folders.length === 0) {
      throw new Error('Authorise at least one folder before indexing.')
    }

    const controller = new AbortController()
    services.indexAbort = controller

    // Run in the background: the renderer gets progress via pushStatus.
    void services.indexer
      .run({
        folders: settings.folders,
        maxFileSizeBytes: settings.maxFileSizeBytes,
        force: options?.force === true,
        signal: controller.signal,
        onStatus: pushStatus
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        pushStatus({ ...services.indexStatus, phase: 'idle', error: message })
      })
      .finally(() => {
        services.indexAbort = null
      })

    return services.indexStatus
  })

  handle<[], IndexStatus>(IPC.cancelIndexing, services, () => {
    if (services.indexAbort) {
      services.indexAbort.abort()
      services.indexStatus = { ...services.indexStatus, phase: 'cancelling' }
      services.logger.info('index.cancelled_by_user')
    }
    return services.indexStatus
  })

  handle<[], IndexStatus>(IPC.getIndexStatus, services, () => services.indexStatus)

  handle<[], IndexStats>(IPC.getIndexStats, services, () => services.store.stats())

  handle<[], IndexStats>(IPC.deleteIndex, services, async () => {
    if (services.indexer.isRunning) {
      throw new Error('Indexing is running. Stop it before deleting the index.')
    }
    await services.indexer.clear()
    services.session.clear()
    services.logger.info('index.deleted_by_user')
    return services.store.stats()
  })

  // -- documents -----------------------------------------------------------

  handle<[DocumentListQuery | undefined], DocumentListResult>(
    IPC.listDocuments,
    services,
    (query) => {
      const limit = query?.limit ?? 100
      const offset = query?.offset ?? 0
      const needle = query?.search?.trim().toLowerCase()

      let docs: DocumentMeta[] = services.store.allDocuments()
      if (query?.folderId) docs = docs.filter((d) => d.folderId === query.folderId)
      if (needle) {
        docs = docs.filter(
          (d) =>
            d.fileName.toLowerCase().includes(needle) ||
            d.directory.toLowerCase().includes(needle)
        )
      }
      docs = [...docs].sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))
      return { documents: docs.slice(offset, offset + limit), total: docs.length }
    }
  )

  /**
   * Open a file in its default macOS application. The path is re-checked
   * against the authorised folder list first, so a stale or crafted id cannot
   * make Jarvis open something outside them.
   */
  handle<[string], boolean>(IPC.openDocument, services, async (documentId) => {
    const doc = services.store.getDocument(documentId)
    if (!doc) throw new Error('Jarvis no longer has a record of that file.')
    const real = await assertReadable(services.settings.folderPaths(), doc.path)
    const error = await shell.openPath(real)
    if (error) throw new Error(`macOS could not open that file: ${error}`)
    services.logger.info('document.opened', { fileName: doc.fileName })
    return true
  })

  handle<[string], boolean>(IPC.revealDocument, services, async (documentId) => {
    const doc = services.store.getDocument(documentId)
    if (!doc) throw new Error('Jarvis no longer has a record of that file.')
    const real = await assertReadable(services.settings.folderPaths(), doc.path)
    shell.showItemInFolder(real)
    return true
  })

  // -- assistant -----------------------------------------------------------

  // The composer now goes through the router, which dispatches to documents,
  // mail, calendar or the brief. Document questions reach the V0.1 assistant
  // by exactly the path they always did.
  handle<[string], JarvisReply>(IPC.ask, services, (question) =>
    services.router.ask(question)
  )

  handle<[], boolean>(IPC.clearConversation, services, () => {
    services.router.reset()
    return true
  })

  /**
   * "Ask about this": scope the conversation to documents the user picked.
   * An empty list clears the selection. Ids are validated against the index, so
   * the selection can only ever name a document Jarvis already holds.
   */
  handle<[string[]], string[]>(IPC.selectDocuments, services, (documentIds) => {
    const valid = (documentIds ?? []).filter((id) => services.store.getDocument(id) !== undefined)
    services.session.pin(valid)
    services.logger.info('assistant.documents_selected', { count: valid.length })
    return valid
  })

  // -- providers -----------------------------------------------------------

  handle<[], ProviderDescriptor[]>(IPC.listProviders, services, () => {
    services.syncProviders()
    return services.providers.describe()
  })

  handle<[string, string], boolean>(IPC.setApiKey, services, async (providerId, apiKey) => {
    await services.secrets.set(providerId, apiKey)
    services.logger.info('provider.key_stored', { providerId })
    return true
  })

  handle<[string], boolean>(IPC.clearApiKey, services, async (providerId) => {
    await services.secrets.clear(providerId)
    services.logger.info('provider.key_cleared', { providerId })
    return true
  })

  // -- diagnostics ---------------------------------------------------------

  handle<[number | undefined], LogEntry[]>(IPC.getActivityLog, services, (limit) =>
    services.logger.recent(limit ?? 150)
  )

  handle<[], boolean>(IPC.openDataFolder, services, async () => {
    await shell.openPath(services.dataDir)
    return true
  })

  // -- Microsoft 365 -------------------------------------------------------

  const microsoftStatus = (): MicrosoftStatus => ({
    configured: services.msAuth.isConfigured(),
    clientId: services.settings.get().microsoft.clientId ?? null,
    accounts: services.workspace.accounts(),
    scopes: GRAPH_SCOPES
  })

  handle<[], MicrosoftStatus>(IPC.msGetStatus, services, microsoftStatus)

  handle<[string], MicrosoftStatus>(IPC.msSetClientId, services, async (clientId) => {
    await services.settings.update({ microsoft: { clientId: clientId.trim() } })
    services.logger.info('microsoft.client_id_set')
    return microsoftStatus()
  })

  /**
   * Connect an account. Opens the system browser; the window is not involved,
   * and no credential passes through the renderer at any point.
   */
  handle<[], ConnectedAccount>(IPC.msConnect, services, () => services.workspace.connect())

  handle<[string], MicrosoftStatus>(IPC.msDisconnect, services, async (accountId) => {
    await services.workspace.disconnect(accountId)
    return microsoftStatus()
  })

  handle<[string], ConnectedAccount | null>(IPC.msSyncAccount, services, (accountId) =>
    services.workspace.sync(accountId)
  )

  handle<[string, string], ConnectedAccount | null>(
    IPC.msSetAccountLabel,
    services,
    (accountId, label) => services.accounts.setLabel(accountId, label)
  )

  // -- Mail ----------------------------------------------------------------

  handle<[MailQuery | undefined], MultiAccountResult<MailMessage>>(
    IPC.mailList,
    services,
    (query) => services.workspace.listMail(query ?? {})
  )

  handle<[string, string], MailMessage | null>(IPC.mailGet, services, (accountId, messageId) =>
    services.workspace.getMessage(accountId, messageId)
  )

  handle<[string, string, string], JarvisReply>(
    IPC.mailDraftReply,
    services,
    (accountId, messageId, instruction) =>
      services.mail.draftFor(accountId, messageId, instruction)
  )

  // -- Calendar ------------------------------------------------------------

  handle<[{ from: number; to: number; accountId?: string }], MultiAccountResult<CalendarEvent>>(
    IPC.calendarList,
    services,
    (query) => services.workspace.listEvents(query)
  )

  // -- Approvals -----------------------------------------------------------

  handle<[], PendingAction[]>(IPC.approvalsPending, services, () => services.approvals.pending())

  /**
   * Turn a draft into a SEND_EMAIL action awaiting approval.
   *
   * This is as far as a draft can get without the user: the action is
   * PROPOSED, and nothing is sent until they approve it.
   */
  handle<[EmailDraft], PendingAction>(IPC.approvalsPrepareSend, services, (draft) => {
    const account = services.workspace.accounts().find((a) => a.id === draft.accountId)
    if (!account) throw new Error('That Microsoft account is no longer connected.')
    if (draft.to.length === 0) throw new Error('Add at least one recipient before sending.')

    return services.approvals.propose({
      type: 'SEND_EMAIL',
      riskLevel: 'high',
      description: `Send email to ${draft.to.map((r) => r.address).join(', ')}`,
      source: 'Review & Send',
      accountId: account.id,
      accountLabel: account.label,
      preview: draftApprovalPreview(draft),
      warning: 'Once sent, an email cannot be recalled from Jarvis.',
      payload: {
        accountId: account.id,
        to: draft.to.map((r) => r.address),
        cc: draft.cc.map((r) => r.address),
        subject: draft.subject,
        body: draft.body,
        ...(draft.inReplyToMessageId ? { replyToMessageId: draft.inReplyToMessageId } : {})
      }
    })
  })

  /**
   * The single point at which anything consequential happens.
   * Reached only by the user pressing Approve in the approval panel.
   */
  handle<[string], PendingAction>(IPC.approvalsApprove, services, (actionId) =>
    services.approvals.approve(actionId)
  )

  handle<[string], PendingAction>(IPC.approvalsReject, services, (actionId) =>
    services.approvals.reject(actionId)
  )

  // -- Brief & dashboard ---------------------------------------------------

  handle<[], DailyBrief>(IPC.dailyBrief, services, () => services.brief.build())
  handle<[], DashboardSummary>(IPC.dashboard, services, () => services.brief.dashboard())
}
