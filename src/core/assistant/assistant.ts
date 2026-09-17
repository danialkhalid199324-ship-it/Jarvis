import type {
  AssistantReply,
  ExternalCallDisclosure,
  SearchHit
} from '../../shared/types'
import type { DocumentStore } from '../storage/document-store'
import type { SearchIndex } from '../index/search-index'
import type { ProviderRegistry } from '../ai/registry'
import type { Logger } from '../logging/logger'
import { planQuery, type QueryPlan } from './query-plan'
import { retrieve } from './retriever'
import { buildExcerpts, citedSources, renderExcerpts, type Excerpt } from './context'
import type { Session } from './session'

/** Marker the model is told to use when the excerpts do not contain an answer. */
const INSUFFICIENT_MARKER = 'INSUFFICIENT'

const ANSWER_SYSTEM = `You are Jarvis, a private executive assistant answering questions about the user's own documents.

You will be given numbered excerpts from files on the user's Mac. Follow these rules exactly:

1. Answer ONLY from the excerpts provided. Never use outside knowledge about companies, people, regulations or events, even if you are confident.
2. Cite every factual claim with the excerpt number in square brackets, like [2]. Cite multiple as [1][3].
3. If the excerpts do not contain enough information to answer, reply with exactly "${INSUFFICIENT_MARKER}: " followed by one sentence saying what is missing. Do not guess, and do not pad the answer with general knowledge.
4. Do not describe what you were given or how you searched. Answer the question.
5. Be direct and businesslike. Use short paragraphs, and bullet points for lists. No preamble, no sign-off.
6. If the excerpts conflict, say so and cite both.`

const COMPARE_SYSTEM = `You are Jarvis, a private executive assistant comparing the user's own documents.

You will be given numbered excerpts from two or more files. Follow these rules exactly:

1. Compare ONLY on the basis of the excerpts provided. Never use outside knowledge.
2. Cite every claim with the excerpt number in square brackets, like [2].
3. Lead with the substantive differences, then what is common to both. Ignore trivial formatting differences.
4. If the excerpts are too thin to support a real comparison, reply with exactly "${INSUFFICIENT_MARKER}: " followed by one sentence saying what is missing.
5. Be direct and businesslike. No preamble, no sign-off.`

export interface AssistantDeps {
  store: DocumentStore
  index: SearchIndex
  providers: ProviderRegistry
  logger: Logger
  session: Session
  maxContextChars: () => number
}

/**
 * Turns a question into an answer grounded in the user's own files.
 *
 * The flow is always: plan → search locally → select passages → (only if the
 * question needs reading) ask the model about those passages. Search itself
 * never leaves the machine, and nothing beyond the selected passages is ever
 * transmitted.
 */
export class Assistant {
  private readonly deps: AssistantDeps

  constructor(deps: AssistantDeps) {
    this.deps = deps
  }

  async ask(question: string, signal?: AbortSignal): Promise<AssistantReply> {
    const { store, index, providers, logger, session } = this.deps
    const trimmed = question.trim()

    if (!trimmed) {
      return notice('Ask me to find a document, or a question about one.')
    }

    session.addUserTurn(trimmed)

    if (store.allDocuments().length === 0) {
      const reply = notice(
        'I have not indexed anything yet. Go to Settings → Data & Permissions, authorise a folder, then run Index now.'
      )
      session.addJarvisTurn(reply.text, reply)
      return reply
    }

    const provider = providers.active()
    const model = providers.activeModelId

    const plan = await planQuery(trimmed, provider, model, {
      recentContext: session.focusLabels(),
      ...(signal ? { signal } : {})
    })

    logger.info('assistant.query', {
      intent: plan.intent,
      planSource: plan.source,
      termCount: plan.terms.length,
      refersToContext: plan.refersToContext
    })

    const hits = await this.findHits(plan, index, store)

    if (hits.length === 0) {
      const reply = insufficient(
        `I could not find anything in your authorised folders matching that.`,
        suggestionsFor(plan, store)
      )
      session.addJarvisTurn(reply.text, reply)
      return reply
    }

    // Questions that only need a list of files never involve the AI provider.
    if (plan.intent === 'find' || plan.intent === 'locate') {
      const reply = resultsReply(plan, hits)
      session.addJarvisTurn(reply.text, reply)
      return reply
    }

    if (!provider) {
      const providerLabel = providers.activeUnchecked()?.label ?? 'An AI provider'
      const single = hits.length === 1
      const reply: AssistantReply = {
        kind: 'notice',
        text:
          `I found ${single ? 'a file that looks' : `${hits.length} files that look`} relevant, but reading ${single ? 'it' : 'them'} needs an AI provider. ` +
          `Add a key for ${providerLabel} in Settings → AI Provider, or point Jarvis at a model running on this Mac.`,
        results: hits,
        sources: [],
        suggestions: []
      }
      session.addJarvisTurn(reply.text, reply)
      return reply
    }

    const reply = await this.answerFromDocuments(trimmed, plan, hits, signal)
    session.addJarvisTurn(reply.text, reply)
    return reply
  }

  /** Search for the question, honouring conversational context. */
  private async findHits(
    plan: QueryPlan,
    index: SearchIndex,
    store: DocumentStore
  ): Promise<SearchHit[]> {
    const { session } = this.deps
    // An explicitly selected document ("Ask about this") outranks the focus
    // Jarvis infers from the previous answer.
    const pinned = session.pinnedDocuments()
    const focus = pinned.length > 0 ? pinned : session.focus()

    // "Summarise it" — the question carries no subject of its own, so it is
    // about the documents already on screen. An explicit selection scopes the
    // question on its own, without needing a pronoun to trigger it.
    const staysInContext =
      (pinned.length > 0 || plan.refersToContext) && focus.length > 0 && plan.intent !== 'find'

    if (staysInContext) {
      const restricted = await retrieve(plan, index, store, {
        limit: plan.intent === 'compare' ? 4 : 3,
        restrictTo: new Set(focus)
      })
      if (restricted.length > 0) return restricted

      // The follow-up used words not present in those documents. Fall back to
      // the focused documents themselves rather than searching the whole
      // archive, which would silently change the subject.
      const fallback: SearchHit[] = []
      for (const id of focus) {
        const meta = store.getDocument(id)
        if (!meta) continue
        fallback.push({
          document: meta,
          score: 1,
          reason:
            pinned.length > 0
              ? 'You selected this document to ask about.'
              : 'Carried over from your previous question.',
          snippets: []
        })
      }
      if (fallback.length > 0) return fallback
    }

    return retrieve(plan, index, store, {
      limit: plan.intent === 'compare' ? 4 : 8
    })
  }

  /** Read the selected documents and answer from them, with citations. */
  private async answerFromDocuments(
    question: string,
    plan: QueryPlan,
    hits: SearchHit[],
    signal?: AbortSignal
  ): Promise<AssistantReply> {
    const { providers, logger, store } = this.deps
    const provider = providers.active()
    if (!provider) return notice('No AI provider is configured.')
    const model = providers.activeModelId

    const isSummary = /\bsummar(y|ise|ize)\b|\boverview\b/i.test(question)
    const maxDocuments = plan.intent === 'compare' ? Math.min(hits.length, 4) : Math.min(hits.length, 3)

    const bundle = await buildExcerpts(hits, store, {
      maxChars: this.deps.maxContextChars(),
      maxDocuments,
      // A summary should read the document in order; a targeted question should
      // read the passages that matched.
      preferDocumentStart: isSummary || plan.refersToContext
    })

    if (bundle.excerpts.length === 0) {
      return insufficient(
        'I found matching files, but none of them has readable text. Scanned PDFs need to be run through OCR before I can read them.',
        []
      )
    }

    const disclosure: ExternalCallDisclosure = {
      providerId: provider.id,
      providerLabel: provider.label,
      local: provider.local,
      model,
      excerptCount: bundle.excerpts.length,
      charsSent: bundle.charsSent,
      fileNames: bundle.fileNames
    }

    logger.info('assistant.external_call', {
      providerId: provider.id,
      local: provider.local,
      model,
      excerptCount: bundle.excerpts.length,
      charsSent: bundle.charsSent,
      files: bundle.fileNames
    })

    let text: string
    try {
      const response = await provider.complete(
        {
          system: plan.intent === 'compare' ? COMPARE_SYSTEM : ANSWER_SYSTEM,
          maxTokens: 2000,
          messages: [
            {
              role: 'user',
              content: `Question: ${question}\n\nExcerpts from the user's files:\n\n${renderExcerpts(bundle.excerpts)}`
            }
          ],
          ...(signal ? { signal } : {})
        },
        model
      )
      text = response.text.trim()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('assistant.external_call_failed', { providerId: provider.id, error: message })
      return {
        kind: 'notice',
        text: `I found the files below, but could not read them just now. ${message}`,
        results: hits,
        sources: [],
        suggestions: []
      }
    }

    if (!text) {
      return insufficient('I did not get an answer back from the model. Try asking again.', [])
    }

    // The model was told to say so plainly rather than invent an answer.
    if (text.toUpperCase().startsWith(INSUFFICIENT_MARKER)) {
      const detail = text.slice(INSUFFICIENT_MARKER.length).replace(/^[:\s]+/, '').trim()
      return {
        kind: 'insufficient',
        text:
          `I could not find enough in these documents to answer that${detail ? `: ${detail}` : '.'}\n\n` +
          `The files I read are listed below if you want to open them.`,
        results: hits,
        sources: bundle.excerpts.map(toSource),
        suggestions: suggestionsFor(plan, store),
        disclosure
      }
    }

    return {
      kind: 'answer',
      text,
      results: hits,
      sources: citedSources(text, bundle.excerpts),
      suggestions: [],
      disclosure
    }
  }
}

// ---------------------------------------------------------------------------
// Reply helpers
// ---------------------------------------------------------------------------

function toSource(excerpt: Excerpt): AssistantReply['sources'][number] {
  const source: AssistantReply['sources'][number] = {
    documentId: excerpt.documentId,
    fileName: excerpt.fileName,
    path: excerpt.path
  }
  if (excerpt.locator) source.locator = excerpt.locator
  return source
}

function notice(text: string): AssistantReply {
  return { kind: 'notice', text, results: [], sources: [], suggestions: [] }
}

function insufficient(text: string, suggestions: string[]): AssistantReply {
  return { kind: 'insufficient', text, results: [], sources: [], suggestions }
}

function resultsReply(plan: QueryPlan, hits: SearchHit[]): AssistantReply {
  const top = hits[0]!
  const text =
    plan.intent === 'locate'
      ? `${top.document.fileName} is in ${top.document.directory}.`
      : hits.length === 1
        ? `I found one file.`
        : `I found ${hits.length} files. The closest match is ${top.document.fileName}.`

  return { kind: 'results', text, results: hits, sources: [], suggestions: [] }
}

/**
 * Suggest what to try next when a search comes up empty. Suggestions are drawn
 * from what is actually in the index, never invented.
 */
function suggestionsFor(plan: QueryPlan, store: DocumentStore): string[] {
  const suggestions: string[] = []

  if (plan.fileTypes.length > 0) {
    suggestions.push('Try the same question without naming a file type.')
  }

  // Offer the folder names Jarvis actually has, so the user can narrow down.
  const folders = new Set<string>()
  for (const doc of store.allDocuments()) {
    const parts = doc.directory.split(/[\\/]/).filter(Boolean)
    const last = parts[parts.length - 1]
    if (last) folders.add(last)
    if (folders.size >= 6) break
  }
  if (folders.size > 0) {
    suggestions.push(`Search by folder name, for example: "${[...folders].slice(0, 3).join('", "')}".`)
  }

  suggestions.push('Check that the folder containing it is authorised in Settings → Data & Permissions.')
  suggestions.push('If you added the file recently, run Index now to pick it up.')

  return suggestions
}
