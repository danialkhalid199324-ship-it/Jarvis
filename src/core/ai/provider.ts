import type { ProviderModelInfo } from '../../shared/types'

/**
 * Jarvis's AI provider abstraction.
 *
 * Everything above this interface — query planning, answering, summarising —
 * is written against `AIProvider` and knows nothing about Anthropic, OpenAI or
 * any particular SDK. Adding a provider means implementing this interface and
 * registering it; no other file changes.
 */

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface CompletionRequest {
  system?: string
  messages: ChatMessage[]
  maxTokens?: number
  /**
   * When set, the provider is asked for a single JSON object matching this
   * shape. Providers implement it however their API allows; callers always get
   * back raw text to parse.
   */
  jsonSchemaHint?: string
  signal?: AbortSignal
}

export interface CompletionResponse {
  text: string
  model: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

export interface AIProvider {
  readonly id: string
  readonly label: string
  /** True when inference runs on this machine, so no data leaves it. */
  readonly local: boolean
  readonly requiresApiKey: boolean
  /** Plain-language statement of where the user's text goes. Shown in Settings. */
  readonly dataNotice: string
  readonly models: ProviderModelInfo[]

  /** Whether the provider has everything it needs to be called right now. */
  isConfigured(): boolean

  complete(request: CompletionRequest, model: string): Promise<CompletionResponse>
}

/** Thrown when a provider cannot run because it has not been set up. */
export class ProviderNotConfiguredError extends Error {
  constructor(label: string) {
    super(`${label} is not set up yet. Add an API key in Settings → AI Provider.`)
    this.name = 'ProviderNotConfiguredError'
  }
}

/**
 * Pull the first JSON object out of a model response, tolerating the code
 * fences and preamble that models sometimes add.
 *
 * @returns the parsed value, or null when nothing parseable was found. Callers
 * must handle null rather than assume well-formed output.
 */
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidates = [fenced?.[1], text].filter((c): c is string => typeof c === 'string')

  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    try {
      return JSON.parse(trimmed) as T
    } catch {
      // Fall through to brace-matching.
    }
    const start = trimmed.indexOf('{')
    if (start < 0) continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i]!
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') inString = !inString
      if (inString) continue
      if (ch === '{') depth++
      if (ch === '}') {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1)) as T
          } catch {
            break
          }
        }
      }
    }
  }
  return null
}
