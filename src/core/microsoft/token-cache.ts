import type { ICachePlugin, TokenCacheContext } from '@azure/msal-node'
import type { SecretStore } from '../security/secrets'

/** Key under which the encrypted MSAL cache is stored. */
export const TOKEN_CACHE_KEY = 'microsoft:msal-token-cache'

/**
 * Persists MSAL's token cache through Jarvis's existing Keychain-backed
 * secret store.
 *
 * The cache holds refresh tokens, so it is treated exactly like an API key:
 * encrypted by the OS keychain, written to a file only in ciphertext, never
 * logged, and never reachable from the renderer. `SecretStore` already refuses
 * to persist anything when the keychain is unavailable, which means a machine
 * with a locked keychain simply cannot end up with tokens on disk in the clear.
 */
export class EncryptedTokenCache implements ICachePlugin {
  private readonly secrets: SecretStore

  constructor(secrets: SecretStore) {
    this.secrets = secrets
  }

  async beforeCacheAccess(context: TokenCacheContext): Promise<void> {
    const stored = this.secrets.get(TOKEN_CACHE_KEY)
    if (stored) context.tokenCache.deserialize(stored)
  }

  async afterCacheAccess(context: TokenCacheContext): Promise<void> {
    if (!context.cacheHasChanged) return
    await this.secrets.set(TOKEN_CACHE_KEY, context.tokenCache.serialize())
  }

  /** Forget every cached token. Used when the last account disconnects. */
  async clear(): Promise<void> {
    await this.secrets.clear(TOKEN_CACHE_KEY)
  }
}
