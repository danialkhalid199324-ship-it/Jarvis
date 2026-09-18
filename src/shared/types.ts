/**
 * Types shared between the Electron main process, the preload bridge and the
 * renderer. Everything here must be structured-clone safe (no class instances,
 * no functions) because it crosses the IPC boundary.
 */

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/** A folder the user has explicitly authorised Jarvis to read. */
export interface AuthorisedFolder {
  id: string
  /** Absolute, resolved path on disk. */
  path: string
  /** Friendly label shown in the UI (defaults to the folder name). */
  label: string
  /** ISO timestamp of when the user granted access. */
  addedAt: string
  /**
   * Optional business/context tag. V0.1 stores and displays this but does not
   * yet route queries by it — that is V0.3 (multi-business intelligence).
   */
  context?: string
}

// ---------------------------------------------------------------------------
// Documents & indexing
// ---------------------------------------------------------------------------

export type SupportedFileType = 'pdf' | 'docx' | 'txt' | 'md' | 'csv' | 'xlsx'

/** Metadata Jarvis holds about one indexed file. */
export interface DocumentMeta {
  /** Stable id derived from the absolute path. */
  id: string
  path: string
  fileName: string
  /** Directory containing the file. */
  directory: string
  fileType: SupportedFileType
  /** Bytes. */
  size: number
  /** Epoch millis of last modification, or null if unavailable. */
  modifiedAt: number | null
  /** Id of the authorised folder this file was found under. */
  folderId: string
  /** Epoch millis of when Jarvis last indexed it. */
  indexedAt: number
  /** Number of text chunks extracted. */
  chunkCount: number
  /** Total characters of extracted text. */
  charCount: number
  /** Set when extraction failed; the file stays listed but is not searchable. */
  extractionError?: string
}

/** One retrievable passage of a document. */
export interface DocumentChunk {
  id: string
  documentId: string
  /** Zero-based position within the document. */
  ordinal: number
  text: string
  /** Human-readable location, e.g. "page 4" or "sheet: Invoices". */
  locator?: string
}

export type IndexPhase = 'idle' | 'scanning' | 'extracting' | 'writing' | 'cancelling'

export interface IndexStatus {
  phase: IndexPhase
  /** Files discovered in this run. */
  total: number
  /** Files processed so far in this run. */
  processed: number
  /** Files skipped because they were unchanged since the last run. */
  skipped: number
  /** Files that could not be read or parsed. */
  failed: number
  /** Path currently being processed, for display. */
  currentFile?: string
  startedAt?: number
  finishedAt?: number
  /** Populated when the last run ended with an error. */
  error?: string
}

export interface IndexStats {
  documentCount: number
  chunkCount: number
  /** Epoch millis of the last completed index run. */
  lastIndexedAt: number | null
  /** Approximate on-disk size of Jarvis's index in bytes. */
  indexSizeBytes: number
  byFileType: Record<string, number>
}

// ---------------------------------------------------------------------------
// Search & answers
// ---------------------------------------------------------------------------

export interface SearchHit {
  document: DocumentMeta
  /** Relevance score; higher is better. Only meaningful relative to siblings. */
  score: number
  /** Plain-language explanation of why Jarvis surfaced this file. */
  reason: string
  /** Best-matching passages, most relevant first. */
  snippets: Array<{ chunkId: string; text: string; locator?: string }>
}

export interface SourceReference {
  documentId: string
  fileName: string
  path: string
  locator?: string
}

export type AnswerKind =
  /** A list of matching files. */
  | 'results'
  /** A grounded prose answer with citations. */
  | 'answer'
  /** Jarvis could not find enough information. */
  | 'insufficient'
  /** Something went wrong (no provider configured, index empty, etc.). */
  | 'notice'

export interface AssistantReply {
  kind: AnswerKind
  /** Prose shown to the user. Empty for pure result lists. */
  text: string
  results: SearchHit[]
  sources: SourceReference[]
  /** Suggested follow-up searches, shown when Jarvis finds nothing. */
  suggestions: string[]
  /**
   * Set when this reply required sending document text to an external AI
   * provider, so the UI can say so plainly.
   */
  disclosure?: ExternalCallDisclosure
}

/** What Jarvis sent off the machine, and to whom. */
export interface ExternalCallDisclosure {
  providerId: string
  providerLabel: string
  /** True when the provider runs on this machine (e.g. Ollama). */
  local: boolean
  model: string
  /** Number of document excerpts included in the request. */
  excerptCount: number
  /** Approximate characters of document text sent. */
  charsSent: number
  /** File names whose excerpts were included. */
  fileNames: string[]
  /**
   * What kind of material the excerpts came from. Absent means documents,
   * which is what V0.1 always sent.
   */
  itemKind?: 'documents' | 'emails' | 'calendar' | 'mixed'
  /**
   * Labels for non-document sources — email subjects, meeting titles. Kept
   * separate from `fileNames` so the document disclosure stays exactly as it
   * was, and so the UI can word each case correctly.
   */
  itemLabels?: string[]
  /** Which connected accounts the material came from. */
  accountLabels?: string[]
}

export interface ConversationTurn {
  id: string
  role: 'user' | 'jarvis'
  text: string
  at: number
  reply?: AssistantReply
}

// ---------------------------------------------------------------------------
// AI provider configuration
// ---------------------------------------------------------------------------

export interface ProviderModelInfo {
  id: string
  label: string
}

export interface ProviderDescriptor {
  id: string
  label: string
  /** True when inference happens on this machine and no data leaves it. */
  local: boolean
  /** Whether this provider needs an API key. */
  requiresApiKey: boolean
  /** Whether a key is currently stored for it. */
  configured: boolean
  models: ProviderModelInfo[]
  /** Shown in Settings so the user knows where their text would go. */
  dataNotice: string
  /** Optional endpoint override (OpenAI-compatible providers). */
  baseUrl?: string
}

export interface AISettings {
  activeProviderId: string
  model: string
  /** For OpenAI-compatible providers pointed at a custom/local endpoint. */
  baseUrl?: string
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface JarvisSettings {
  /** Used for the greeting. */
  displayName: string
  folders: AuthorisedFolder[]
  ai: AISettings
  /** Maximum characters of document text sent to the AI in one request. */
  maxContextChars: number
  /** Files larger than this (bytes) are skipped during indexing. */
  maxFileSizeBytes: number
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  at: string
  level: LogLevel
  event: string
  detail?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// IPC result envelope
// ---------------------------------------------------------------------------

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string }
