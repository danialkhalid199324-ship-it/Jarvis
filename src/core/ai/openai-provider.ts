import {
  ProviderNotConfiguredError,
  type AIProvider,
  type CompletionRequest,
  type CompletionResponse
} from './provider'
import { MODEL_CATALOG } from './model-catalog'

const RESPONSES_URL = 'https://api.openai.com/v1/responses'

interface OpenAIResponse {
  model?: string
  status?: 'completed' | 'failed' | 'in_progress' | 'cancelled' | 'queued' | 'incomplete'
  output?: Array<{
    type?: string
    content?: Array<{ type?: string; text?: string }>
  }>
  usage?: { input_tokens?: number; output_tokens?: number }
}

/** Official OpenAI Responses API. Keys and requests remain in the main process. */
export class OpenAIProvider implements AIProvider {
  readonly id = 'openai'
  readonly label = 'OpenAI'
  readonly local = false
  readonly requiresApiKey = true
  readonly dataNotice =
    'Your question and the specific excerpts Jarvis selected are sent to OpenAI to generate an answer. Whole files, folders and mailboxes are never sent.'
  readonly models = MODEL_CATALOG.openai.models
  readonly defaultModel = MODEL_CATALOG.openai.defaultModel

  constructor(private readonly getApiKey: () => string | null) {}

  isConfigured(): boolean {
    return Boolean(this.getApiKey())
  }

  async complete(request: CompletionRequest, model: string): Promise<CompletionResponse> {
    const apiKey = this.getApiKey()
    if (!apiKey) throw new ProviderNotConfiguredError(this.label)

    const instructions = request.jsonSchemaHint
      ? `${request.system ?? ''}\n\nRespond with a single JSON object and nothing else. Shape:\n${request.jsonSchemaHint}`.trim()
      : request.system

    let response: Response
    try {
      response = await fetch(RESPONSES_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          ...(instructions ? { instructions } : {}),
          input: request.messages.map((message) => ({
            role: message.role,
            content: message.content
          })),
          max_output_tokens: request.maxTokens ?? 4096,
          store: false,
          ...(request.jsonSchemaHint ? { text: { format: { type: 'json_object' } } } : {})
        }),
        ...(request.signal ? { signal: request.signal } : {})
      })
    } catch (error) {
      if (request.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error
      }
      throw new Error('Jarvis could not reach OpenAI. Check your internet connection.')
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('Your OpenAI API key was rejected. Check it in Settings → AI Provider.')
      }
      if (response.status === 404) {
        throw new Error(`The model "${model}" is not available on your OpenAI account.`)
      }
      if (response.status === 429) {
        throw new Error('OpenAI is rate limiting requests right now. Try again in a moment.')
      }
      throw new Error(`OpenAI returned an error (${response.status}). Try again later.`)
    }

    const data = (await response.json()) as OpenAIResponse
    if (data.status === 'failed' || data.status === 'cancelled') {
      throw new Error('OpenAI could not complete the response. Try again later.')
    }
    const text = (data.output ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((content) => content.type === 'output_text' && typeof content.text === 'string')
      .map((content) => content.text!.trim())
      .filter(Boolean)
      .join('\n')

    const usage: CompletionResponse['usage'] = {}
    if (typeof data.usage?.input_tokens === 'number') usage.inputTokens = data.usage.input_tokens
    if (typeof data.usage?.output_tokens === 'number') usage.outputTokens = data.usage.output_tokens

    return { text, model: data.model ?? model, usage }
  }
}
