import path from 'node:path'
import { app, safeStorage } from 'electron'
import { DocumentStore } from '../core/storage/document-store'
import { SearchIndex } from '../core/index/search-index'
import { Indexer } from '../core/index/indexer'
import { Logger } from '../core/logging/logger'
import { SettingsStore } from '../core/settings/settings-store'
import { SecretStore, type Encryptor } from '../core/security/secrets'
import { ProviderRegistry } from '../core/ai/registry'
import { Assistant } from '../core/assistant/assistant'
import { Session } from '../core/assistant/session'
import type { IndexStatus } from '../shared/types'

/**
 * Electron's OS-backed encryption, adapted to the core `Encryptor` interface.
 * On macOS this is Keychain Services.
 */
const electronEncryptor: Encryptor = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (cipher) => safeStorage.decryptString(cipher)
}

/**
 * Everything Jarvis needs, wired together once at startup.
 *
 * All of this lives in the main process. The renderer never touches the
 * filesystem, the index or an API key — it only sends messages over the narrow
 * IPC surface in `ipc/register.ts`.
 */
export class Services {
  readonly dataDir: string
  readonly logger: Logger
  readonly settings: SettingsStore
  readonly secrets: SecretStore
  readonly store: DocumentStore
  readonly indexer: Indexer
  readonly providers: ProviderRegistry
  readonly session: Session
  readonly assistant: Assistant

  /** Live indexing state, polled by the UI and pushed on change. */
  indexStatus: IndexStatus = { phase: 'idle', total: 0, processed: 0, skipped: 0, failed: 0 }
  indexAbort: AbortController | null = null

  private constructor(init: {
    dataDir: string
    logger: Logger
    settings: SettingsStore
    secrets: SecretStore
    store: DocumentStore
    indexer: Indexer
    providers: ProviderRegistry
    session: Session
    assistant: Assistant
  }) {
    this.dataDir = init.dataDir
    this.logger = init.logger
    this.settings = init.settings
    this.secrets = init.secrets
    this.store = init.store
    this.indexer = init.indexer
    this.providers = init.providers
    this.session = init.session
    this.assistant = init.assistant
  }

  static async create(): Promise<Services> {
    const dataDir = app.getPath('userData')
    const logger = new Logger(path.join(dataDir, 'logs'))

    // Default the greeting to the macOS account name, so Jarvis is personal
    // from the first launch without asking the user to configure anything.
    const displayName = firstName(app.getPath('home'))

    const settings = await SettingsStore.open(dataDir, displayName)
    const secrets = await SecretStore.open(dataDir, electronEncryptor)
    const store = await DocumentStore.open(dataDir)

    // Prefer the persisted search index; rebuild from the chunk store if it is
    // missing or was written by an older version.
    let index = await SearchIndex.load(store.root)
    if (!index || index.documentCount !== store.allDocuments().length) {
      index = await Indexer.rebuildIndex(store)
      await index.save(store.root)
      logger.info('index.rebuilt_on_start', { documents: store.allDocuments().length })
    }

    const indexer = new Indexer(store, index, logger)
    const current = settings.get()

    const providers = ProviderRegistry.createDefault({
      getApiKey: (providerId) => secrets.get(providerId),
      getBaseUrl: () => settings.get().ai.baseUrl,
      activeId: current.ai.activeProviderId,
      activeModel: current.ai.model
    })

    const session = new Session()
    const assistant = new Assistant({
      store,
      index: indexer.searchIndex,
      providers,
      logger,
      session,
      maxContextChars: () => settings.get().maxContextChars
    })

    logger.info('app.started', { version: app.getVersion() })

    return new Services({
      dataDir,
      logger,
      settings,
      secrets,
      store,
      indexer,
      providers,
      session,
      assistant
    })
  }

  /** Keep the provider registry in step with saved settings. */
  syncProviders(): void {
    const ai = this.settings.get().ai
    this.providers.setActive(ai.activeProviderId, ai.model)
  }
}

function firstName(homeDir: string): string {
  const base = path.basename(homeDir)
  if (!base) return 'there'
  const cleaned = base.replace(/[._-]+/g, ' ').trim()
  const first = cleaned.split(/\s+/)[0] ?? cleaned
  return first.charAt(0).toUpperCase() + first.slice(1)
}
