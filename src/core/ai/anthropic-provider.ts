import Anthropic from '@anthropic-ai/sdk'
import type { ProviderModelInfo } from '../../shared/types'
import {
  ProviderNotConfiguredError,
  type AIProvider,
  type CompletionRequest,
  type CompletionResponse
} from './provider'

const MODELS: ProviderModelInfo[] = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 — most capable' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — faster, lower cost' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — fastest, lowest cost' }
]

/**
 * Anthropic Claude.
 *
 * The API key is read from the OS keychain at call time and never held in the
 * renderer, written to settings.json, or logged.
 */
export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic'
  readonly label = 'Anthropic Claude'
  readonly local = false
  readonly requiresApiKey = true
  readonly dataNotice =
    'Your question and the specific document excerpts Jarvis selected are sent to Anthropic to generate an answer. Whole files and whole folders are never sent.'
  readonly models = MODELS

  private readonly getApiKey: () => string | null

  constructor(getApiKey: () => string | null) {
    this.getApiKey = getApiKey
  }

  isConfigured(): boolean {
    return Boolean(this.getApiKey())
  }

  async complete(request: CompletionRequest, model: string): Promise<CompletionResponse> {
    const apiKey = this.getApiKey()
    if (!apiKey) throw new ProviderNotConfiguredError(this.label)

    const client = new Anthropic({ apiKey, maxRetries: 2 })
    const system = request.jsonSchemaHint
      ? `${request.system ?? ''}\n\nRespond with a single JSON object and nothing else. Shape:\n${request.jsonSchemaHint}`.trim()
      : request.system

    try {
      const response = await client.messages.create(
        {
          model,
          max_tokens: request.maxTokens ?? 4096,
          ...(system ? { system } : {}),
          messages: request.messages.map((m) => ({ role: m.role, content: m.content }))
        },
        request.signal ? { signal: request.signal } : {}
      )

      if (response.stop_reason === 'refusal') {
        throw new Error('The model declined to answer this request.')
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()

      return {
        text,
        model: response.model,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens
        }
      }
    } catch (error) {
      // Translate SDK errors into something a non-developer can act on.
      if (error instanceof Anthropic.AuthenticationError) {
        throw new Error('Your Anthropic API key was rejected. Check it in Settings → AI Provider.')
      }
      if (error instanceof Anthropic.NotFoundError) {
        throw new Error(`The model "${model}" is not available on your account.`)
      }
      if (error instanceof Anthropic.RateLimitError) {
        throw new Error('Anthropic is rate limiting requests right now. Try again in a moment.')
      }
      if (error instanceof Anthropic.APIConnectionError) {
        throw new Error('Jarvis could not reach Anthropic. Check your internet connection.')
      }
      if (error instanceof Anthropic.APIError) {
        throw new Error(`Anthropic returned an error (${error.status ?? 'unknown'}): ${error.message}`)
      }
      throw error
    }
  }
}
