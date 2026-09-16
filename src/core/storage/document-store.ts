import fs from 'node:fs/promises'
import path from 'node:path'
import { readJson, writeJsonAtomic, dirSize } from './json-file'
import type { DocumentChunk, DocumentMeta, IndexStats } from '../../shared/types'

const CATALOG_VERSION = 1

interface Catalog {
  version: number
  lastIndexedAt: number | null
  documents: DocumentMeta[]
}

/**
 * Jarvis's local index on disk.
 *
 * Layout under <dataDir>/index:
 *   catalog.json         — one record per indexed file (small, loaded eagerly)
 *   chunks/<docId>.json  — the extracted passages for that file
 *
 * Original files are never written to. Everything here is derived data: deleting
 * the whole directory loses nothing but the time it takes to re-index.
 *
 * This is deliberately behind a narrow interface. Swapping it for SQLite or a
 * vector store later means reimplementing this class, nothing above it.
 */
export class DocumentStore {
  readonly root: string
  private readonly catalogFile: string
  private readonly chunkDir: string
  private catalog: Catalog

  private constructor(root: string, catalog: Catalog) {
    this.root = root
    this.catalogFile = path.join(root, 'catalog.json')
    this.chunkDir = path.join(root, 'chunks')
    this.catalog = catalog
  }

  static async open(dataDir: string): Promise<DocumentStore> {
    const root = path.join(dataDir, 'index')
    await fs.mkdir(path.join(root, 'chunks'), { recursive: true })
    const catalog = await readJson<Catalog>(path.join(root, 'catalog.json'), {
      version: CATALOG_VERSION,
      lastIndexedAt: null,
      documents: []
    })
    // A catalog written by a future/older version is discarded rather than
    // misread; the next index run rebuilds it.
    if (catalog.version !== CATALOG_VERSION || !Array.isArray(catalog.documents)) {
      return new DocumentStore(root, { version: CATALOG_VERSION, lastIndexedAt: null, documents: [] })
    }
    return new DocumentStore(root, catalog)
  }

  allDocuments(): DocumentMeta[] {
    return this.catalog.documents
  }

  getDocument(id: string): DocumentMeta | undefined {
    return this.catalog.documents.find((d) => d.id === id)
  }

  getDocumentByPath(filePath: string): DocumentMeta | undefined {
    return this.catalog.documents.find((d) => d.path === filePath)
  }

  lastIndexedAt(): number | null {
    return this.catalog.lastIndexedAt
  }

  private chunkFile(documentId: string): string {
    return path.join(this.chunkDir, `${documentId}.json`)
  }

  async loadChunks(documentId: string): Promise<DocumentChunk[]> {
    return readJson<DocumentChunk[]>(this.chunkFile(documentId), [])
  }

  /** Insert or replace one document and its chunks. */
  async putDocument(meta: DocumentMeta, chunks: DocumentChunk[]): Promise<void> {
    await writeJsonAtomic(this.chunkFile(meta.id), chunks)
    const existing = this.catalog.documents.findIndex((d) => d.id === meta.id)
    if (existing >= 0) this.catalog.documents[existing] = meta
    else this.catalog.documents.push(meta)
  }

  async removeDocument(documentId: string): Promise<void> {
    this.catalog.documents = this.catalog.documents.filter((d) => d.id !== documentId)
    await fs.rm(this.chunkFile(documentId), { force: true })
  }

  /** Persist the catalog. Called once at the end of an index run. */
  async commit(lastIndexedAt: number | null = Date.now()): Promise<void> {
    this.catalog.lastIndexedAt = lastIndexedAt
    await writeJsonAtomic(this.catalogFile, this.catalog)
  }

  /**
   * Delete everything Jarvis has derived from the user's files. Original files
   * are untouched — this only removes <dataDir>/index.
   */
  async destroy(): Promise<void> {
    this.catalog = { version: CATALOG_VERSION, lastIndexedAt: null, documents: [] }
    await fs.rm(this.root, { recursive: true, force: true })
    await fs.mkdir(this.chunkDir, { recursive: true })
    await this.commit(null)
  }

  async stats(): Promise<IndexStats> {
    const byFileType: Record<string, number> = {}
    let chunkCount = 0
    for (const doc of this.catalog.documents) {
      byFileType[doc.fileType] = (byFileType[doc.fileType] ?? 0) + 1
      chunkCount += doc.chunkCount
    }
    return {
      documentCount: this.catalog.documents.length,
      chunkCount,
      lastIndexedAt: this.catalog.lastIndexedAt,
      indexSizeBytes: await dirSize(this.root),
      byFileType
    }
  }
}
