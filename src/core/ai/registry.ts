import type { ProviderDescriptor } from '../../shared/types'
import type { AIProvider } from './provider'
import { AnthropicProvider } from './anthropic-provider'
import { OpenAICompatibleProvider } from './openai-compatible-provider'

/**
 * Holds the available providers and tracks which one is active.
 *
 * Adding a provider later — Gemini, Bedrock, a self-hosted gateway — is a
 * matter of writing a class that implements `AIProvider` and registering it
 * here. Nothing in the assistant, search or UI layers needs to change.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, AIProvider>()
  private activeId: string
  private activeModel: string

  constructor(providers: AIProvider[], activeId: string, activeModel: string) {
    for (const provider of providers) this.providers.set(provider.id, provider)
    this.activeId = activeId
    this.activeModel = activeModel
  }

  static createDefault(options: {
    getApiKey: (providerId: string) => string | null
    getBaseUrl: () => string | undefined
    activeId: string
    activeModel: string
  }): ProviderRegistry {
    return new ProviderRegistry(
      [
        new AnthropicProvider(() => options.getApiKey('anthropic')),
        new OpenAICompatibleProvider(
          () => options.getApiKey('openai-compatible'),
          options.getBaseUrl
        )
      ],
      options.activeId,
      options.activeModel
    )
  }

  list(): AIProvider[] {
    return [...this.providers.values()]
  }

  get(providerId: string): AIProvider | undefined {
    return this.providers.get(providerId)
  }

  setActive(providerId: string, model: string): void {
    this.activeId = providerId
    this.activeModel = model
  }

  get activeModelId(): string {
    return this.activeModel
  }

  /** @returns the active provider, or null when it is unknown or unconfigured. */
  active(): AIProvider | null {
    const provider = this.providers.get(this.activeId)
    if (!provider) return null
    return provider.isConfigured() ? provider : null
  }

  /** The active provider regardless of whether it is configured. */
  activeUnchecked(): AIProvider | undefined {
    return this.providers.get(this.activeId)
  }

  describe(): ProviderDescriptor[] {
    return this.list().map((provider) => {
      const descriptor: ProviderDescriptor = {
        id: provider.id,
        label: provider.label,
        local: provider.local,
        requiresApiKey: provider.requiresApiKey,
        configured: provider.isConfigured(),
        models: provider.models,
        dataNotice: provider.dataNotice
      }
      return descriptor
    })
  }
}
