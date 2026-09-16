import path from 'node:path'
import { readJson, writeJsonAtomic } from '../storage/json-file'

/**
 * Credential storage.
 *
 * API keys never appear in source, in settings.json, in logs, or in the
 * renderer process. They live in a separate file encrypted by the OS keychain
 * (on macOS, Electron's `safeStorage` is backed by Keychain Services), and the
 * only thing that ever reads them is the AI provider inside the main process.
 *
 * The encryption primitive is injected so that `core` stays free of Electron
 * imports and remains unit-testable.
 */
export interface Encryptor {
  /** True when OS-backed encryption is available on this machine. */
  isAvailable(): boolean
  encrypt(plainText: string): Buffer
  decrypt(cipher: Buffer): string
}

/**
 * Fallback used only when the OS keychain is unavailable. It does not encrypt.
 * `SecretStore` refuses to persist through it, so a key is never written to
 * disk in the clear — the user is told to retry instead.
 */
export const unavailableEncryptor: Encryptor = {
  isAvailable: () => false,
  encrypt: () => {
    throw new Error('Secure storage is not available on this machine.')
  },
  decrypt: () => {
    throw new Error('Secure storage is not available on this machine.')
  }
}

interface SecretsFile {
  /** providerId -> base64 of the OS-encrypted key. */
  [providerId: string]: string
}

export class SecretStore {
  private readonly file: string
  private readonly encryptor: Encryptor
  private cache: SecretsFile = {}

  private constructor(file: string, encryptor: Encryptor, cache: SecretsFile) {
    this.file = file
    this.encryptor = encryptor
    this.cache = cache
  }

  static async open(dataDir: string, encryptor: Encryptor): Promise<SecretStore> {
    const file = path.join(dataDir, 'secrets.enc.json')
    const cache = await readJson<SecretsFile>(file, {})
    return new SecretStore(file, encryptor, cache)
  }

  isSecureStorageAvailable(): boolean {
    return this.encryptor.isAvailable()
  }

  /** Provider ids that currently have a key stored. */
  configuredProviders(): string[] {
    return Object.keys(this.cache)
  }

  has(providerId: string): boolean {
    return typeof this.cache[providerId] === 'string'
  }

  /** @returns the decrypted key, or null when absent/undecryptable. */
  get(providerId: string): string | null {
    const encoded = this.cache[providerId]
    if (!encoded) return null
    try {
      return this.encryptor.decrypt(Buffer.from(encoded, 'base64'))
    } catch {
      return null
    }
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    const trimmed = apiKey.trim()
    if (!trimmed) throw new Error('API key cannot be empty.')
    if (!this.encryptor.isAvailable()) {
      throw new Error(
        'Jarvis will not save an API key without OS-backed encryption. ' +
          'Your keychain is unavailable — unlock it and try again.'
      )
    }
    this.cache[providerId] = this.encryptor.encrypt(trimmed).toString('base64')
    await writeJsonAtomic(this.file, this.cache)
  }

  async clear(providerId: string): Promise<void> {
    delete this.cache[providerId]
    await writeJsonAtomic(this.file, this.cache)
  }
}
