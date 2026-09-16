import type { ProviderModelInfo } from '../../shared/types'
import {
  ProviderNotConfiguredError,
  type AIProvider,
  type CompletionRequest,
  type CompletionResponse
} from './provider'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

const SUGGESTED_MODELS: ProviderModelInfo[] = [
  { id: 'gpt-4.1', label: 'OpenAI GPT-4.1' },
  { id: 'gpt-4.1-mini', label: 'OpenAI GPT-4.1 mini' },
  { id: 'llama3.1:8b', label: 'Ollama — Llama 3.1 8B (runs on this Mac)' },
  { id: 'qwen2.5:14b', label: 'Ollama — Qwen 2.5 14B (runs on this Mac)' }
]

function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')
  } catch {
    return false
  }
}

/**
 * Any service speaking the OpenAI chat-completions protocol.
 *
 * One implementation covers OpenAI itself and every local runtime that mimics
 * it — Ollama, LM Studio, llama.cpp's server. Pointing Jarvis at
 * `http://localhost:11434/v1` means no document text ever leaves the Mac, which
 * is why this provider exists in V0.1 alongside Anthropic.
 *
 * Implemented with `fetch` rather than the OpenAI SDK so Jarvis carries one
 * fewer dependency for what is a single HTTP call.
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly id = 'openai-compatible'
  readonly label = 'OpenAI-compatible (OpenAI, Ollama, LM Studio)'
  readonly requiresApiKey = false
  readonly models = SUGGESTED_MODELS

  private readonly getApiKey: () => string | null
  private readonly getBaseUrl: () => string

  constructor(getApiKey: () => string | null, getBaseUrl: () => string | undefined) {
    this.getApiKey = getApiKey
    this.getBaseUrl = () => (getBaseUrl() || DEFAULT_BASE_URL).replace(/\/+$/, '')
  }

  get local(): boolean {
    return isLocalEndpoint(this.getBaseUrl())
  }

  get dataNotice(): string {
    const baseUrl = this.getBaseUrl()
    return this.local
      ? `Inference runs on this Mac at ${baseUrl}. Nothing leaves your machine.`
      : `Your question and the specific document excerpts Jarvis selected are sent to ${baseUrl}. Whole files and whole folders are never sent.`
  }

  isConfigured(): boolean {
    // Local runtimes need no key; hosted endpoints do.
    return this.local || Boolean(this.getApiKey())
  }

  async complete(request: CompletionRequest, model: string): Promise<CompletionResponse> {
    if (!this.isConfigured()) throw new ProviderNotConfiguredError(this.label)

    const baseUrl = this.getBaseUrl()
    const apiKey = this.getApiKey()

    const system = request.jsonSchemaHint
      ? `${request.system ?? ''}\n\nRespond with a single JSON object and nothing else. Shape:\n${request.jsonSchemaHint}`.trim()
      : request.system

    const messages = [
      ...(system ? [{ role: 'system' as const, content: system }] : []),
      ...request.messages.map((m) => ({ role: m.role, content: m.content }))
    ]

    let response: Response
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({
          model,
          max_tokens: request.maxTokens ?? 4096,
          messages,
          ...(request.jsonSchemaHint ? { response_format: { type: 'json_object' } } : {})
        }),
        ...(request.signal ? { signal: request.signal } : {})
      })
    } catch {
      throw new Error(
        this.local
          ? `Jarvis could not reach your local model at ${baseUrl}. Is it running?`
          : `Jarvis could not reach ${baseUrl}. Check your internet connection.`
      )
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      if (response.status === 401 || response.status === 403) {
        throw new Error('Your API key was rejected. Check it in Settings → AI Provider.')
      }
      if (response.status === 404) {
        throw new Error(`The model "${model}" was not found at ${baseUrl}.`)
      }
      if (response.status === 429) {
        throw new Error('The provider is rate limiting requests right now. Try again in a moment.')
      }
      throw new Error(`The provider returned an error (${response.status}). ${body.slice(0, 200)}`)
    }

    const data = (await response.json()) as {
      model?: string
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }

    const text = data.choices?.[0]?.message?.content?.trim() ?? ''
    const usage: CompletionResponse['usage'] = {}
    if (typeof data.usage?.prompt_tokens === 'number') usage.inputTokens = data.usage.prompt_tokens
    if (typeof data.usage?.completion_tokens === 'number') {
      usage.outputTokens = data.usage.completion_tokens
    }

    return { text, model: data.model ?? model, usage }
  }
}
