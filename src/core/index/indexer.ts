import { crawlFolder, type DiscoveredFile } from '../files/crawler'
import { parseDocument } from '../parsers'
import { chunkSegments } from './chunker'
import { SearchIndex } from './search-index'
import type { DocumentStore } from '../storage/document-store'
import type { Logger } from '../logging/logger'
import { stableId } from '../util/ids'
import { assertReadable } from '../security/paths'
import type {
  AuthorisedFolder,
  DocumentMeta,
  IndexStatus
} from '../../shared/types'

export interface IndexRunOptions {
  folders: readonly AuthorisedFolder[]
  maxFileSizeBytes: number
  /** Re-extract every file even if it looks unchanged. */
  force?: boolean
  signal?: AbortSignal
  onStatus?: (status: IndexStatus) => void
}

export interface IndexRunResult {
  processed: number
  skipped: number
  failed: number
  removed: number
  durationMs: number
  cancelled: boolean
}

/**
 * Builds and maintains Jarvis's local index.
 *
 * Two guarantees hold throughout:
 *  - Every path is re-checked against the authorised folder list before it is
 *    opened, even though the crawler only walks authorised roots.
 *  - Files are opened read-only. Nothing here writes, moves, renames or deletes
 *    anything outside Jarvis's own data directory.
 *
 * Re-indexing is incremental: a file whose size and modification time are
 * unchanged since the last run is skipped without being re-read.
 */
export class Indexer {
  private readonly store: DocumentStore
  private readonly logger: Logger
  private readonly index: SearchIndex
  private running = false

  constructor(store: DocumentStore, index: SearchIndex, logger: Logger) {
    this.store = store
    this.index = index
    this.logger = logger
  }

  get searchIndex(): SearchIndex {
    return this.index
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Rebuild the in-memory search index from the persisted chunk store. */
  static async rebuildIndex(store: DocumentStore): Promise<SearchIndex> {
    const index = new SearchIndex()
    for (const doc of store.allDocuments()) {
      index.addDocument(doc.id, doc.fileName, doc.directory)
      const chunks = await store.loadChunks(doc.id)
      for (const chunk of chunks) index.addChunk(chunk.id, doc.id, chunk.text)
    }
    return index
  }

  async run(options: IndexRunOptions): Promise<IndexRunResult> {
    if (this.running) throw new Error('Indexing is already in progress.')
    this.running = true

    const startedAt = Date.now()
    const status: IndexStatus = {
      phase: 'scanning',
      total: 0,
      processed: 0,
      skipped: 0,
      failed: 0,
      startedAt
    }
    const emit = (): void => options.onStatus?.({ ...status })
    emit()

    let removed = 0
    try {
      const roots = options.folders.map((f) => f.path)

      // 1. Discover everything readable under the authorised folders.
      const discovered: Array<DiscoveredFile & { folderId: string }> = []
      for (const folder of options.folders) {
        if (options.signal?.aborted) break
        const files = await crawlFolder(folder.path, {
          maxFileSizeBytes: options.maxFileSizeBytes,
          ...(options.signal ? { signal: options.signal } : {}),
          onProgress: (currentPath, found) => {
            status.currentFile = currentPath
            status.total = discovered.length + found
            emit()
          }
        })
        for (const file of files) discovered.push({ ...file, folderId: folder.id })
      }

      status.total = discovered.length
      status.phase = 'extracting'
      emit()

      // 2. Drop anything that is no longer present or no longer authorised.
      const livePaths = new Set(discovered.map((f) => f.path))
      for (const doc of [...this.store.allDocuments()]) {
        if (!livePaths.has(doc.path)) {
          await this.store.removeDocument(doc.id)
          this.index.removeDocument(doc.id)
          removed++
        }
      }

      // 3. Extract and index what changed.
      for (const file of discovered) {
        if (options.signal?.aborted) break
        status.currentFile = file.path
        emit()

        const documentId = stableId(file.path)
        const existing = this.store.getDocument(documentId)
        const unchanged =
          !options.force &&
          existing !== undefined &&
          existing.size === file.size &&
          existing.modifiedAt === file.modifiedAt &&
          this.index.hasDocument(documentId)

        if (unchanged) {
          status.skipped++
          emit()
          continue
        }

        try {
          // Defence in depth: re-verify authorisation, resolving symlinks,
          // immediately before opening the file.
          const realPath = await assertReadable(roots, file.path)
          const parsed = await parseDocument(realPath, file.fileType)
          const chunks = chunkSegments(documentId, parsed.segments)

          const meta: DocumentMeta = {
            id: documentId,
            path: file.path,
            fileName: file.fileName,
            directory: file.directory,
            fileType: file.fileType,
            size: file.size,
            modifiedAt: file.modifiedAt,
            folderId: file.folderId,
            indexedAt: Date.now(),
            chunkCount: chunks.length,
            charCount: parsed.charCount
          }
          if (parsed.warning) meta.extractionError = parsed.warning

          await this.store.putDocument(meta, chunks)
          this.index.removeDocument(documentId)
          this.index.addDocument(documentId, file.fileName, file.directory)
          for (const chunk of chunks) this.index.addChunk(chunk.id, documentId, chunk.text)

          status.processed++
        } catch (err) {
          status.failed++
          const message = err instanceof Error ? err.message : String(err)
          this.logger.warn('index.file_failed', { path: file.path, error: message })
          // Keep the file listed so the user can see Jarvis knows about it but
          // could not read it, rather than it silently vanishing.
          const meta: DocumentMeta = {
            id: documentId,
            path: file.path,
            fileName: file.fileName,
            directory: file.directory,
            fileType: file.fileType,
            size: file.size,
            modifiedAt: file.modifiedAt,
            folderId: file.folderId,
            indexedAt: Date.now(),
            chunkCount: 0,
            charCount: 0,
            extractionError: message
          }
          await this.store.putDocument(meta, [])
          this.index.removeDocument(documentId)
          this.index.addDocument(documentId, file.fileName, file.directory)
        }
        emit()
      }

      // 4. Persist.
      status.phase = 'writing'
      delete status.currentFile
      emit()
      await this.store.commit()
      await this.index.save(this.store.root)

      const cancelled = options.signal?.aborted === true
      status.phase = 'idle'
      status.finishedAt = Date.now()
      emit()

      this.logger.info('index.run_completed', {
        processed: status.processed,
        skipped: status.skipped,
        failed: status.failed,
        removed,
        cancelled,
        durationMs: status.finishedAt - startedAt
      })

      return {
        processed: status.processed,
        skipped: status.skipped,
        failed: status.failed,
        removed,
        durationMs: status.finishedAt - startedAt,
        cancelled
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      status.phase = 'idle'
      status.error = message
      status.finishedAt = Date.now()
      emit()
      this.logger.error('index.run_failed', { error: message })
      throw err
    } finally {
      this.running = false
    }
  }

  /** Forget everything Jarvis derived, leaving the user's files untouched. */
  async clear(): Promise<void> {
    if (this.running) throw new Error('Indexing is running. Stop it before deleting the index.')
    await this.store.destroy()
    // Cleared in place so the assistant and any other holder of this index
    // keeps a valid reference.
    this.index.clear()
    await this.index.save(this.store.root)
    this.logger.info('index.cleared')
  }
}
