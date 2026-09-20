import { useEffect, useRef, useState } from 'react'
import type { JarvisSettings, SearchHit } from '../../shared/types'
import type { EmailDraft, JarvisReply, PendingAction } from '../../shared/communication'
import { ResultCard } from '../components/ResultCard'
import { MessageCard } from '../components/MessageCard'
import { EventCard } from '../components/EventCard'
import { ApprovalPanel } from '../components/ApprovalPanel'
import { DraftPanel } from '../components/DraftPanel'
import { DashboardCards } from '../components/DashboardCards'
import { AnswerText } from '../components/AnswerText'
import { Disclosure } from '../components/Disclosure'
import { formatClock, formatToday, greetingFor } from '../lib/format'
import { formatLocators, groupSources } from '../lib/sources'

interface Turn {
  id: string
  question: string
  reply: JarvisReply | null
  error: string | null
}

const EXAMPLES = [
  'Find my latest GTA operational plan',
  'What documents do I have relating to Titan Security?',
  'Find documents relating to LRD',
  'Summarise it and tell me what still needs attention'
]

export function HomePage({
  settings,
  active,
  onOpenRoute
}: {
  settings: JarvisSettings
  active: boolean
  onOpenRoute: (route: 'messages' | 'calendar' | 'files') => void
}): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  /** The document the user picked with "Ask about this", if any. */
  const [selected, setSelected] = useState<{ id: string; fileName: string } | null>(null)
  /** A prepared action or draft raised by the last answer. Neither has acted. */
  const [action, setAction] = useState<PendingAction | null>(null)
  const [draft, setDraft] = useState<EmailDraft | null>(null)
  const [now, setNow] = useState(() => new Date())
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // The greeting shows a live clock, so it is correct whenever the user looks.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Scroll the conversation container itself rather than calling
  // scrollIntoView, which would also scroll ancestors and can fight the fixed
  // composer. This keeps the newest message in view without moving the layout.
  //
  // `selected` is a dependency because the selection banner changes the
  // composer's height, and therefore the height of the area above it — without
  // re-anchoring, the last message would be clipped when it appears.
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
  }, [turns, busy, selected, action, draft])

  async function ask(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed || busy) return

    const id = `${Date.now()}`
    setTurns((prev) => [...prev, { id, question: trimmed, reply: null, error: null }])
    setQuestion('')
    setBusy(true)

    try {
      const reply = await window.jarvis.assistant.ask(trimmed)
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, reply } : t)))

      // A prepared action or draft surfaces beside the composer, where it
      // cannot be missed. Neither has done anything yet.
      setAction(reply.pendingAction ?? null)
      setDraft(reply.draft ?? null)

      // A fresh search means the user has moved on to a different document, so
      // the previous selection should not silently keep scoping later questions.
      if (reply.kind === 'results' && reply.results.length > 0) {
        setSelected(null)
        await window.jarvis.assistant.selectDocuments([])
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, error: message } : t)))
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void ask(question)
    }
  }

  async function selectDocument(hit: { document: { id: string; fileName: string } }): Promise<void> {
    // Toggle: clicking the selected document again clears the selection.
    if (selected?.id === hit.document.id) {
      setSelected(null)
      await window.jarvis.assistant.selectDocuments([])
      return
    }
    const accepted = await window.jarvis.assistant.selectDocuments([hit.document.id])
    if (accepted.includes(hit.document.id)) {
      setSelected({ id: hit.document.id, fileName: hit.document.fileName })
    }
    inputRef.current?.focus()
  }

  async function clearSelection(): Promise<void> {
    setSelected(null)
    await window.jarvis.assistant.selectDocuments([])
    inputRef.current?.focus()
  }

  const openDoc = (id: string): void => void window.jarvis.documents.open(id).catch(() => undefined)
  const revealDoc = (id: string): void =>
    void window.jarvis.documents.reveal(id).catch(() => undefined)

  const hasFolders = settings.folders.length > 0

  return (
    <div className="chat">
      {/* Only this region scrolls. The composer below it never moves. */}
      <div className="chat__scroll" ref={scrollRef}>
        <div className="chat__inner">
          <header className="greeting">
            <h1 className="greeting__hello">
              {greetingFor(now)}, {settings.displayName}
            </h1>
            <p className="greeting__meta">
              {formatToday(now)} · {formatClock(now)}
            </p>
          </header>

          {/* Refresh live counts on return without remounting the conversation. */}
          <DashboardCards key={active ? 'active' : 'inactive'} onOpen={onOpenRoute} />

          {!hasFolders ? (
            <div className="notice">
              Jarvis has no folders to look in yet. Open Settings → Data &amp; Permissions and
              authorise a folder, then run Index now. Jarvis only ever reads folders you choose, and
              never changes the files inside them.
            </div>
          ) : turns.length === 0 ? (
            <div className="examples">
              <div className="examples__label">Try asking</div>
              <div className="examples__list">
                {EXAMPLES.map((example) => (
                  <button key={example} className="chip" onClick={() => void ask(example)}>
                    {example}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="conversation">
            {turns.map((turn) => (
              <div key={turn.id}>
                <div className="turn turn--user">
                  <div className="turn__role">You</div>
                  <div className="turn__text">{turn.question}</div>
                </div>

                {turn.error ? (
                  <div className="turn turn--jarvis" style={{ marginTop: 'var(--s-5)' }}>
                    <div className="turn__role">Jarvis</div>
                    <div className="notice">{turn.error}</div>
                  </div>
                ) : turn.reply ? (
                  <div className="turn turn--jarvis" style={{ marginTop: 'var(--s-5)' }}>
                    <div className="turn__role">Jarvis</div>
                    <ReplyBody
                      reply={turn.reply}
                      onOpen={openDoc}
                      onReveal={revealDoc}
                      onSelect={(hit) => void selectDocument(hit)}
                      selectedId={selected?.id ?? null}
                    />
                  </div>
                ) : null}
              </div>
            ))}
            <div ref={endRef} />
          </div>
        </div>
      </div>

      {/* Fixed composer. It is a flex sibling of the scroll area rather than an
          overlay, so it can never cover the last message however long a reply
          is, and it stays correct when the window is resized. */}
      <div className="chat__composer">
        <div className="chat__inner">
          {action ? (
            <ApprovalPanel
              action={action}
              onResolved={(resolved) => {
                setAction(resolved)
                if (resolved.status === 'COMPLETED' || resolved.status === 'REJECTED') setDraft(null)
              }}
            />
          ) : draft ? (
            <DraftPanel draft={draft} onPrepared={setAction} onDiscard={() => setDraft(null)} />
          ) : null}
          {selected ? (
            <div className="selection">
              <span className="selection__label">Asking about</span>
              <span className="selection__name truncate" title={selected.fileName}>
                {selected.fileName}
              </span>
              <button
                className="btn btn--sm btn--ghost"
                onClick={() => void clearSelection()}
                title="Ask across all your documents again"
              >
                Clear
              </button>
            </div>
          ) : null}
          <div className="command">
            <textarea
              ref={inputRef}
              className="command__input"
              placeholder={selected ? `Ask about ${selected.fileName}…` : 'Ask Jarvis anything…'}
              value={question}
              rows={2}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={busy}
            />
            <div className="command__bar">
              <span className="command__hint">
                {busy ? (
                  <span className="thinking">
                    <span />
                    <span />
                    <span />
                  </span>
                ) : (
                  'Return to ask · Shift + Return for a new line'
                )}
              </span>
              <button
                className="btn btn--primary"
                onClick={() => void ask(question)}
                disabled={busy || question.trim() === ''}
              >
                Ask Jarvis
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * How many message cards a plain retrieval renders before it stops.
 *
 * A list answer *is* its cards, so the bound is generous — but forty cards in a
 * chat transcript is not a list, it is a wall, and the user loses the answer
 * they were reading. What is hidden is always stated.
 */
const RETRIEVAL_CARD_LIMIT = 12

/**
 * How many cards sit under a written answer.
 *
 * An analysis or a brief *is* the prose; the cards are the evidence behind it.
 * The core already bounds what it analyses, and every message here has a
 * paragraph written about it, so this only guards against a future caller
 * attaching more than it explained.
 */
const SUPPORTING_CARD_LIMIT = 15

function MessageSection({
  messages,
  shape
}: {
  messages: NonNullable<JarvisReply['messages']>
  shape: JarvisReply['shape']
}): React.JSX.Element {
  const written = shape === 'analyse' || shape === 'brief'
  const limit = written ? SUPPORTING_CARD_LIMIT : RETRIEVAL_CARD_LIMIT
  const shown = messages.slice(0, limit)
  const hidden = messages.length - shown.length

  return (
    <details className="supporting-evidence">
      <summary>{written ? `Messages behind this (${messages.length})` : `${messages.length} messages`}</summary>
      <div className="section-label">
        {written
          ? hidden > 0
            ? `The ${shown.length} messages behind this, of ${messages.length}`
            : shown.length === 1
              ? 'The message behind this'
              : 'The messages behind this'
          : hidden > 0
            ? `Showing ${shown.length} of ${messages.length} messages`
            : `${shown.length} ${shown.length === 1 ? 'message' : 'messages'}`}
      </div>
      <div className="results">
        {shown.map((message) => (
          <MessageCard key={`${message.accountId}-${message.id}`} message={message} />
        ))}
      </div>
      {hidden > 0 ? (
        <div className="suggestions">
          <div>· {hidden} more not shown here — open Messages to see the full list.</div>
        </div>
      ) : null}
    </details>
  )
}

function ReplyBody({
  reply,
  onOpen,
  onReveal,
  onSelect,
  selectedId
}: {
  reply: JarvisReply
  onOpen: (id: string) => void
  onReveal: (id: string) => void
  onSelect: (hit: SearchHit) => void
  selectedId: string | null
}): React.JSX.Element {
  // Citations stay per-passage in the data; this only collapses how they read.
  const grouped = groupSources(reply.sources)

  return (
    <>
      {reply.kind === 'answer' ? (
        <AnswerText text={reply.text} />
      ) : reply.text ? (
        <div className={reply.kind === 'results' ? 'answer' : 'notice'}>{reply.text}</div>
      ) : null}

      {reply.suggestions.length > 0 ? (
        <div className="suggestions">
          {reply.suggestions.map((s) => (
            <div key={s}>· {s}</div>
          ))}
        </div>
      ) : null}

      {grouped.length > 0 ? (
        <details className="sources supporting-evidence">
          <summary>Sources ({grouped.length})</summary>
          <div className="section-label" style={{ margin: '0 0 var(--s-3)' }}>
            Based on {grouped.length === 1 ? 'this file' : 'these files'}
          </div>
          <div className="sources__list">
            {grouped.map((group, i) => {
              const where = formatLocators(group.locators)
              return (
                <button
                  key={group.documentId}
                  className="source"
                  onClick={() => onOpen(group.documentId)}
                  title={group.path}
                >
                  <span className="source__num">{i + 1}</span>
                  <span className="source__body">
                    <span className="source__name">{group.fileName}</span>
                    {where ? <span className="source__locator">{where}</span> : null}
                  </span>
                </button>
              )
            })}
          </div>
        </details>
      ) : null}

      {reply.disclosure ? <Disclosure disclosure={reply.disclosure} /> : null}

      {reply.coverage ? <div className="notice">{reply.coverage}</div> : null}

      {reply.mailSources && reply.mailSources.length > 0 ? (
        <details className="sources supporting-evidence">
          <summary>Messages behind this ({reply.mailSources.length})</summary>
          <div className="section-label" style={{ margin: '0 0 var(--s-3)' }}>
            Based on {reply.mailSources.length === 1 ? 'this email' : 'these emails'}
          </div>
          <div className="sources__list">
            {reply.mailSources.map((source, i) => (
              <div className="source" key={`${source.messageId}-${i}`}>
                <span className="source__num">{i + 1}</span>
                <span className="source__body">
                  <span className="source__name">{source.subject}</span>
                  <span className="source__locator">
                    {source.from} · {source.accountLabel}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {reply.events && reply.events.length > 0 ? (
        <>
          <div className="section-label">
            {reply.events.length} {reply.events.length === 1 ? 'meeting' : 'meetings'}
          </div>
          <div className="results">
            {reply.events.map((event) => (
              <EventCard key={`${event.accountId}-${event.id}`} event={event} showDay />
            ))}
          </div>
        </>
      ) : null}

      {reply.messages && reply.messages.length > 0 ? (
        <MessageSection messages={reply.messages} shape={reply.shape} />
      ) : null}

      {reply.results.length > 0 ? (
        <>
          <div className="section-label">
            {reply.results.length} {reply.results.length === 1 ? 'file' : 'files'} found
          </div>
          <div className="results">
            {reply.results.map((hit) => (
              <ResultCard
                key={hit.document.id}
                hit={hit}
                onOpen={onOpen}
                onReveal={onReveal}
                onSelect={onSelect}
                selected={hit.document.id === selectedId}
              />
            ))}
          </div>
        </>
      ) : null}
    </>
  )
}
