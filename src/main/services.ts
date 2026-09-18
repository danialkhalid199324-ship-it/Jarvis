import path from 'node:path'
import { app, safeStorage, shell } from 'electron'
import { DocumentStore } from '../core/storage/document-store'
import { SearchIndex } from '../core/index/search-index'
import { Indexer } from '../core/index/indexer'
import { Logger } from '../core/logging/logger'
import { SettingsStore } from '../core/settings/settings-store'
import { SecretStore, type Encryptor } from '../core/security/secrets'
import { ProviderRegistry } from '../core/ai/registry'
import { Assistant } from '../core/assistant/assistant'
import { Session } from '../core/assistant/session'
import { MicrosoftAuthenticator } from '../core/microsoft/auth'
import { EncryptedTokenCache } from '../core/microsoft/token-cache'
import { AccountRegistry } from '../core/microsoft/accounts'
import { MicrosoftWorkspace } from '../core/microsoft/workspace'
import { ApprovalEngine } from '../core/communication/approvals'
import { DailyBriefService } from '../core/communication/daily-brief'
import { MailCapability } from '../core/assistant/capabilities/mail-capability'
import {
  CalendarCapability,
  type CancelEventPayload,
  type CreateEventPayload,
  type UpdateEventPayload
} from '../core/assistant/capabilities/calendar-capability'
import { JarvisRouter } from '../core/assistant/router'
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
  readonly msAuth: MicrosoftAuthenticator
  readonly accounts: AccountRegistry
  readonly workspace: MicrosoftWorkspace
  readonly approvals: ApprovalEngine
  readonly mail: MailCapability
  readonly calendar: CalendarCapability
  readonly brief: DailyBriefService
  readonly router: JarvisRouter

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
    msAuth: MicrosoftAuthenticator
    accounts: AccountRegistry
    workspace: MicrosoftWorkspace
    approvals: ApprovalEngine
    mail: MailCapability
    calendar: CalendarCapability
    brief: DailyBriefService
    router: JarvisRouter
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
    this.msAuth = init.msAuth
    this.accounts = init.accounts
    this.workspace = init.workspace
    this.approvals = init.approvals
    this.mail = init.mail
    this.calendar = init.calendar
    this.brief = init.brief
    this.router = init.router
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

    // -- V0.2: Microsoft 365 --------------------------------------------
    const accounts = await AccountRegistry.open(dataDir)
    const msAuth = new MicrosoftAuthenticator({
      getClientId: () => settings.get().microsoft.clientId?.trim() || null,
      getAuthority: () => settings.get().microsoft.authority,
      cache: new EncryptedTokenCache(secrets),
      // Sign-in happens in the user's own browser, never inside Jarvis.
      openBrowser: async (url) => {
        await shell.openExternal(url)
      },
      logger
    })
    const workspace = new MicrosoftWorkspace({ auth: msAuth, registry: accounts, logger })

    const approvals = new ApprovalEngine(logger)
    const maxContextChars = (): number => settings.get().maxContextChars

    const mail = new MailCapability({ workspace, providers, logger, maxContextChars })
    const calendar = new CalendarCapability({ workspace, approvals, logger })
    const brief = new DailyBriefService({ workspace, store, providers, logger, maxContextChars })

    // The executors are registered here, in the main process, and are held
    // privately by the engine. No conversational path can reach them: the only
    // way to run one is ApprovalEngine.approve(), called from the IPC handler
    // that the user's explicit approval click triggers.
    Services.registerExecutors(approvals, workspace)

    const router = new JarvisRouter({
      documents: assistant,
      mail,
      calendar,
      brief,
      workspace,
      session,
      logger
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
      assistant,
      msAuth,
      accounts,
      workspace,
      approvals,
      mail,
      calendar,
      brief,
      router
    })
  }

  /** Wire each approved action type to the Graph call that carries it out. */
  private static registerExecutors(approvals: ApprovalEngine, workspace: MicrosoftWorkspace): void {
    const accountFor = (accountId: string) => {
      const account = workspace.accounts().find((a) => a.id === accountId)
      if (!account) throw new Error('That Microsoft account is no longer connected.')
      return account
    }

    approvals.registerExecutor<{
      accountId: string
      to: string[]
      cc: string[]
      subject: string
      body: string
      replyToMessageId?: string
    }>('SEND_EMAIL', async (payload) => {
      const account = accountFor(payload.accountId)
      await workspace.mailFor(account).sendMail({
        to: payload.to,
        cc: payload.cc,
        subject: payload.subject,
        body: payload.body,
        ...(payload.replyToMessageId ? { replyToMessageId: payload.replyToMessageId } : {})
      })
      return `Sent from ${account.label} to ${payload.to.join(', ')}`
    })

    approvals.registerExecutor<CreateEventPayload>('CREATE_EVENT', async (payload) => {
      const account = accountFor(payload.accountId)
      await workspace.calendarFor(account).createEvent({
        subject: payload.subject,
        start: payload.start,
        end: payload.end,
        attendees: payload.attendees,
        ...(payload.location ? { location: payload.location } : {})
      })
      return `Created "${payload.subject}" in ${account.label}`
    })

    approvals.registerExecutor<UpdateEventPayload>('UPDATE_EVENT', async (payload) => {
      const account = accountFor(payload.accountId)
      await workspace.calendarFor(account).updateEvent(payload.eventId, payload.changes)
      return `Updated the meeting in ${account.label}`
    })

    approvals.registerExecutor<CancelEventPayload>('DELETE_EVENT', async (payload) => {
      const account = accountFor(payload.accountId)
      await workspace.calendarFor(account).cancelEvent(payload.eventId, payload.comment)
      return `Cancelled the meeting in ${account.label}`
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
