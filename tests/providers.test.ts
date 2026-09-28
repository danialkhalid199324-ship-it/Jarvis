import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { OpenAIProvider } from '../src/core/ai/openai-provider'
import { ProviderRegistry } from '../src/core/ai/registry'
import { MODEL_CATALOG } from '../src/core/ai/model-catalog'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('official OpenAI provider', () => {
  test('translates Jarvis requests to Responses API and reads all output text', async () => {
    let url = ''
    let init: RequestInit | undefined
    globalThis.fetch = async (input, requestInit) => {
      url = String(input)
      init = requestInit
      return response({
        model: 'gpt-6-luna-2026-09-22',
        output: [
          { type: 'reasoning', content: [] },
          {
            type: 'message',
            content: [
              { type: 'output_text', text: 'First.' },
              { type: 'output_text', text: 'Second.' }
            ]
          }
        ],
        usage: { input_tokens: 12, output_tokens: 7 }
      })
    }

    const provider = new OpenAIProvider(() => 'sk-openai-secret')
    const result = await provider.complete(
      {
        system: 'Stay grounded.',
        messages: [{ role: 'user', content: 'Summarise selected excerpt.' }],
        maxTokens: 321
      },
      'gpt-6-luna'
    )

    assert.equal(url, 'https://api.openai.com/v1/responses')
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer sk-openai-secret')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    assert.equal(body.model, 'gpt-6-luna')
    assert.equal(body.instructions, 'Stay grounded.')
    assert.equal(body.max_output_tokens, 321)
    assert.equal(body.store, false)
    assert.deepEqual(body.input, [{ role: 'user', content: 'Summarise selected excerpt.' }])
    assert.ok(!String(init?.body).includes('sk-openai-secret'))
    assert.equal(result.text, 'First.\nSecond.')
    assert.equal(result.model, 'gpt-6-luna-2026-09-22')
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 7 })
  })

  test('requests JSON object output when Jarvis supplies a schema hint', async () => {
    let body: Record<string, unknown> = {}
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return response({
        model: 'gpt-6-sol',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }]
      })
    }
    const provider = new OpenAIProvider(() => 'secret')
    await provider.complete(
      { messages: [{ role: 'user', content: 'Plan' }], jsonSchemaHint: '{"ok": boolean}' },
      'gpt-6-sol'
    )
    assert.deepEqual(body.text, { format: { type: 'json_object' } })
    assert.match(String(body.instructions), /single JSON object/)
  })

  test('does not call the network without a key', async () => {
    let called = false
    globalThis.fetch = async () => {
      called = true
      return response({})
    }
    const provider = new OpenAIProvider(() => null)
    await assert.rejects(
      () => provider.complete({ messages: [{ role: 'user', content: 'Hello' }] }, 'gpt-6-luna'),
      /not set up yet/
    )
    assert.equal(called, false)
  })

  for (const [status, expected] of [
    [401, /API key was rejected/],
    [403, /API key was rejected/],
    [404, /not available on your OpenAI account/],
    [429, /rate limiting/],
    [500, /OpenAI returned an error \(500\)/]
  ] as const) {
    test(`sanitises HTTP ${status} errors`, async () => {
      globalThis.fetch = async () => response({ error: { message: 'secret response detail' } }, status)
      const provider = new OpenAIProvider(() => 'sk-never-show')
      await assert.rejects(
        () => provider.complete({ messages: [{ role: 'user', content: 'Hello' }] }, 'gpt-6-luna'),
        (error: Error) => {
          assert.match(error.message, expected)
          assert.ok(!error.message.includes('sk-never-show'))
          assert.ok(!error.message.includes('secret response detail'))
          return true
        }
      )
    })
  }

  test('reports network failure without leaking the key', async () => {
    globalThis.fetch = async () => {
      throw new Error('socket failed with sk-never-show')
    }
    const provider = new OpenAIProvider(() => 'sk-never-show')
    await assert.rejects(
      () => provider.complete({ messages: [{ role: 'user', content: 'Hello' }] }, 'gpt-6-luna'),
      (error: Error) => {
        assert.equal(error.message, 'Jarvis could not reach OpenAI. Check your internet connection.')
        return true
      }
    )
  })

  test('turns a failed response status into a sanitised error', async () => {
    globalThis.fetch = async () =>
      response({
        status: 'failed',
        error: { message: 'internal detail containing sk-never-show' }
      })
    const provider = new OpenAIProvider(() => 'sk-never-show')
    await assert.rejects(
      () => provider.complete({ messages: [{ role: 'user', content: 'Hello' }] }, 'gpt-6-luna'),
      (error: Error) => {
        assert.equal(error.message, 'OpenAI could not complete the response. Try again later.')
        assert.ok(!error.message.includes('sk-never-show'))
        return true
      }
    )
  })

  test('preserves cancellation rather than disguising it as a network error', async () => {
    const controller = new AbortController()
    globalThis.fetch = async () => {
      controller.abort()
      throw new DOMException('This operation was aborted', 'AbortError')
    }
    const provider = new OpenAIProvider(() => 'secret')
    await assert.rejects(
      () =>
        provider.complete(
          { messages: [{ role: 'user', content: 'Hello' }], signal: controller.signal },
          'gpt-6-luna'
        ),
      (error: Error) => error.name === 'AbortError'
    )
  })
})

describe('provider registry', () => {
  test('registers Anthropic, official OpenAI and compatible/local separately', () => {
    const keys: Record<string, string> = { anthropic: 'anthropic-key' }
    const registry = ProviderRegistry.createDefault({
      getApiKey: (id) => keys[id] ?? null,
      getBaseUrl: () => undefined,
      activeId: 'anthropic',
      activeModel: MODEL_CATALOG.anthropic.defaultModel
    })
    assert.deepEqual(registry.list().map((provider) => provider.id), [
      'anthropic',
      'openai',
      'openai-compatible'
    ])
    assert.equal(registry.active()?.id, 'anthropic')
    assert.equal(registry.get('openai')?.defaultModel, 'gpt-6-luna')
    assert.equal(registry.get('openai-compatible')?.local, true)
    const publicDescription = JSON.stringify(registry.describe())
    assert.ok(!publicDescription.includes('anthropic-key'))
  })

  test('does not fall back when the selected provider is unconfigured', () => {
    const registry = ProviderRegistry.createDefault({
      getApiKey: (id) => (id === 'anthropic' ? 'anthropic-key' : null),
      getBaseUrl: () => undefined,
      activeId: 'openai',
      activeModel: 'gpt-6-luna'
    })
    assert.equal(registry.active(), null)
    assert.equal(registry.activeUnchecked()?.id, 'openai')
  })

  test('switches provider and model only when explicitly directed', () => {
    const registry = ProviderRegistry.createDefault({
      getApiKey: () => 'configured',
      getBaseUrl: () => undefined,
      activeId: 'anthropic',
      activeModel: 'claude-sonnet-5'
    })
    registry.setActive('openai', 'gpt-6-sol')
    assert.equal(registry.active()?.id, 'openai')
    assert.equal(registry.activeModelId, 'gpt-6-sol')
  })

  test('preload has no API-key retrieval capability', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    assert.match(source, /setApiKey/)
    assert.match(source, /clearApiKey/)
    assert.doesNotMatch(source, /getApiKey/)
  })
})
