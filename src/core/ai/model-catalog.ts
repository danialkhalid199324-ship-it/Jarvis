import type { ProviderModelInfo } from '../../shared/types'

export interface ProviderModelCatalog {
  defaultModel: string
  models: ProviderModelInfo[]
}

/** The single source of truth for models shown by Jarvis. */
export const MODEL_CATALOG = {
  anthropic: {
    defaultModel: 'claude-opus-5',
    models: [
      { id: 'claude-opus-5', label: 'Claude Opus 5 — most capable' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — faster, lower cost' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — fastest, lowest cost' }
    ]
  },
  openai: {
    defaultModel: 'gpt-6-luna',
    models: [
      { id: 'gpt-6-luna', label: 'GPT-6 Luna — efficient routine work' },
      { id: 'gpt-6-sol', label: 'GPT-6 Sol — more capable reasoning' }
    ]
  },
  'openai-compatible': {
    defaultModel: 'llama3.1:8b',
    models: [
      { id: 'llama3.1:8b', label: 'Ollama — Llama 3.1 8B (runs on this Mac)' },
      { id: 'qwen2.5:14b', label: 'Ollama — Qwen 2.5 14B (runs on this Mac)' }
    ]
  }
} satisfies Record<string, ProviderModelCatalog>

export function defaultModelFor(providerId: string): string | undefined {
  return (MODEL_CATALOG as Record<string, ProviderModelCatalog>)[providerId]?.defaultModel
}
