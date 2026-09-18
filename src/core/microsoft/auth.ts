import {
  PublicClientApplication,
  LogLevel,
  type AccountInfo,
  type Configuration
} from '@azure/msal-node'
import { TOKEN_SCOPES, REQUESTED_SCOPES } from './scopes'
import type { EncryptedTokenCache } from './token-cache'
import type { Logger } from '../logging/logger'

/**
 * Microsoft identity platform sign-in for a desktop app.
 *
 * The flow is the one Microsoft recommends for native applications:
 * authorization code with PKCE, opened in the user's own system browser, with
 * the response caught on a short-lived loopback listener that MSAL manages and
 * closes. There is no embedded web view, no client secret, and no
 * username/password path.
 *
 * Jarvis is registered as a *public* client, so there is no secret to leak.
 * The client id is not a secret either, but it is supplied by the user rather
 * than hardcoded so each person uses their own Azure app registration.
 */

export class MicrosoftNotConfiguredError extends Error {
  constructor() {
    super(
      'Microsoft 365 is not set up yet. Add your Azure application (client) ID in Settings → Connected Accounts.'
    )
    this.name = 'MicrosoftNotConfiguredError'
  }
}

/** The account's tokens are gone or consent was withdrawn; the user must sign in again. */
export class NeedsReauthError extends Error {
  readonly accountId: string
  constructor(accountId: string, detail?: string) {
    super(
      detail ??
        'This Microsoft account needs to be reconnected. Its session has expired or access was withdrawn.'
    )
    this.name = 'NeedsReauthError'
    this.accountId = accountId
  }
}

export interface SignInOutcome {
  homeAccountId: string
  username: string
  displayName: string
  tenantId: string
}

export interface AuthDeps {
  /** Azure app registration client id, from settings. Null when unset. */
  getClientId: () => string | null
  /** Authority, e.g. 'common' (default), 'organizations', or a tenant id. */
  getAuthority: () => string | undefined
  cache: EncryptedTokenCache
  /** Opens the sign-in page in the user's default browser. */
  openBrowser: (url: string) => Promise<void>
  logger: Logger
}

/** Shown in the browser tab after sign-in completes, so the user knows to go back. */
const SUCCESS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a0d14;color:#e8ecf3;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
div{text-align:center}h1{font-weight:600;letter-spacing:-0.02em}p{color:#9aa6bb}</style></head>
<body><div><h1>Connected to Jarvis</h1><p>You can close this tab and return to Jarvis.</p></div></body></html>`

const ERROR_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a0d14;color:#e8ecf3;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
div{text-align:center}h1{font-weight:600}p{color:#9aa6bb}</style></head>
<body><div><h1>Sign-in did not complete</h1><p>Return to Jarvis and try again.</p></div></body></html>`

export class MicrosoftAuthenticator {
  private readonly deps: AuthDeps
  private client: PublicClientApplication | null = null
  private clientKey = ''

  constructor(deps: AuthDeps) {
    this.deps = deps
  }

  isConfigured(): boolean {
    return Boolean(this.deps.getClientId())
  }

  /**
   * Build (or rebuild) the MSAL client. Rebuilt when the client id or authority
   * changes so a corrected registration takes effect without a restart.
   */
  private getClient(): PublicClientApplication {
    const clientId = this.deps.getClientId()
    if (!clientId) throw new MicrosoftNotConfiguredError()

    const authority = `https://login.microsoftonline.com/${this.deps.getAuthority() || 'common'}`
    const key = `${clientId}|${authority}`
    if (this.client && this.clientKey === key) return this.client

    const config: Configuration = {
      auth: { clientId, authority },
      cache: { cachePlugin: this.deps.cache },
      system: {
        loggerOptions: {
          // MSAL logs can contain tokens and PII. Jarvis routes only
          // error-level messages to its own log and never enables PII.
          piiLoggingEnabled: false,
          logLevel: LogLevel.Error,
          loggerCallback: (_level, message, containsPii) => {
            if (containsPii) return
            this.deps.logger.warn('microsoft.msal', { message })
          }
        }
      }
    }
    this.client = new PublicClientApplication(config)
    this.clientKey = key
    return this.client
  }

  /**
   * Interactive sign-in. Opens the system browser and waits for the redirect.
   *
   * @throws MicrosoftNotConfiguredError when no client id is set.
   */
  async signIn(): Promise<SignInOutcome> {
    const client = this.getClient()
    const result = await client.acquireTokenInteractive({
      scopes: TOKEN_SCOPES,
      openBrowser: this.deps.openBrowser,
      successTemplate: SUCCESS_PAGE,
      errorTemplate: ERROR_PAGE
    })

    const account = result.account
    if (!account) throw new Error('Microsoft did not return an account for that sign-in.')

    this.deps.logger.info('microsoft.signed_in', {
      username: account.username,
      tenantId: account.tenantId
    })

    return {
      homeAccountId: account.homeAccountId,
      username: account.username,
      displayName: account.name || account.username,
      tenantId: account.tenantId
    }
  }

  /**
   * A valid access token for an account, refreshed silently.
   *
   * The returned string is a bearer token: it is handed straight to the Graph
   * client and must never be logged, persisted outside the encrypted cache, or
   * passed to an AI provider.
   *
   * @throws NeedsReauthError when silent refresh is no longer possible.
   */
  async getAccessToken(homeAccountId: string): Promise<string> {
    const client = this.getClient()
    const account = await client.getTokenCache().getAccountByHomeId(homeAccountId)
    if (!account) {
      throw new NeedsReauthError(
        homeAccountId,
        'Jarvis no longer has a session for this account. Reconnect it to continue.'
      )
    }

    try {
      const result = await client.acquireTokenSilent({ account, scopes: TOKEN_SCOPES })
      if (!result.accessToken) throw new NeedsReauthError(homeAccountId)
      return result.accessToken
    } catch (error) {
      // Any silent-refresh failure means the user has to intervene. The
      // underlying message can contain identifiers, so it is not surfaced.
      if (error instanceof NeedsReauthError) throw error
      this.deps.logger.warn('microsoft.silent_refresh_failed', { accountId: homeAccountId })
      throw new NeedsReauthError(homeAccountId)
    }
  }

  /** Accounts MSAL currently holds tokens for. */
  async listCachedAccounts(): Promise<AccountInfo[]> {
    if (!this.isConfigured()) return []
    try {
      return await this.getClient().getAllAccounts()
    } catch {
      return []
    }
  }

  /** Remove an account's tokens from the cache. */
  async signOut(homeAccountId: string): Promise<void> {
    if (!this.isConfigured()) return
    const client = this.getClient()
    const account = await client.getTokenCache().getAccountByHomeId(homeAccountId)
    if (account) await client.getTokenCache().removeAccount(account)
    this.deps.logger.info('microsoft.signed_out', { accountId: homeAccountId })
  }

  /** The scopes this build asks for, for display in Settings. */
  requestedScopes(): string[] {
    return REQUESTED_SCOPES
  }
}
