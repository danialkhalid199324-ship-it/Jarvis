import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import { IPC, type BootstrapInfo, type DocumentListQuery, type DocumentListResult } from '../../shared/ipc'
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

  handle<[string], AssistantReply>(IPC.ask, services, (question) =>
    services.assistant.ask(question)
  )

  handle<[], boolean>(IPC.clearConversation, services, () => {
    services.session.clear()
    return true
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
}
