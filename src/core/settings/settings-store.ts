import path from 'node:path'
import { readJson, writeJsonAtomic } from '../storage/json-file'
import { describeOverlap } from '../security/paths'
import { stableId } from '../util/ids'
import type { AuthorisedFolder, JarvisSettings } from '../../shared/types'

export const DEFAULT_MAX_FILE_SIZE_BYTES = 40 * 1024 * 1024 // 40 MB
export const DEFAULT_MAX_CONTEXT_CHARS = 60_000

export function defaultSettings(displayName = 'there'): JarvisSettings {
  return {
    displayName,
    folders: [],
    ai: {
      activeProviderId: 'anthropic',
      model: 'claude-opus-5'
    },
    maxContextChars: DEFAULT_MAX_CONTEXT_CHARS,
    maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES
  }
}

/**
 * Jarvis's non-secret configuration: the display name, the authorised-folder
 * list, and which AI provider to use. API keys are deliberately NOT stored
 * here — see `SecretStore`.
 */
export class SettingsStore {
  private readonly file: string
  private settings: JarvisSettings

  private constructor(file: string, settings: JarvisSettings) {
    this.file = file
    this.settings = settings
  }

  static async open(dataDir: string, displayName?: string): Promise<SettingsStore> {
    const file = path.join(dataDir, 'settings.json')
    const loaded = await readJson<Partial<JarvisSettings>>(file, {})
    const base = defaultSettings(displayName)
    const settings: JarvisSettings = {
      ...base,
      ...loaded,
      ai: { ...base.ai, ...(loaded.ai ?? {}) },
      folders: Array.isArray(loaded.folders) ? loaded.folders : []
    }
    return new SettingsStore(file, settings)
  }

  get(): JarvisSettings {
    // Hand out a copy so callers cannot mutate state behind our back.
    return structuredClone(this.settings)
  }

  folderPaths(): string[] {
    return this.settings.folders.map((f) => f.path)
  }

  private async save(): Promise<void> {
    await writeJsonAtomic(this.file, this.settings)
  }

  async update(patch: Partial<Omit<JarvisSettings, 'folders'>>): Promise<JarvisSettings> {
    this.settings = {
      ...this.settings,
      ...patch,
      ai: { ...this.settings.ai, ...(patch.ai ?? {}) }
    }
    await this.save()
    return this.get()
  }

  /**
   * Authorise a folder. Rejects duplicates and folders that overlap an existing
   * authorisation, so the permissions list always reads unambiguously.
   */
  async addFolder(folderPath: string, label?: string, context?: string): Promise<AuthorisedFolder> {
    const resolved = path.resolve(folderPath)
    const overlap = describeOverlap(this.folderPaths(), resolved)
    if (overlap) throw new Error(overlap)

    const folder: AuthorisedFolder = {
      id: stableId(resolved),
      path: resolved,
      label: label?.trim() || path.basename(resolved) || resolved,
      addedAt: new Date().toISOString()
    }
    if (context?.trim()) folder.context = context.trim()

    this.settings.folders = [...this.settings.folders, folder]
    await this.save()
    return folder
  }

  /** @returns the removed folder, or null when the id was unknown. */
  async removeFolder(folderId: string): Promise<AuthorisedFolder | null> {
    const found = this.settings.folders.find((f) => f.id === folderId) ?? null
    if (!found) return null
    this.settings.folders = this.settings.folders.filter((f) => f.id !== folderId)
    await this.save()
    return found
  }
}
