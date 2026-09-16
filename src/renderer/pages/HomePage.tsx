import { useEffect, useRef, useState } from 'react'
import type { AssistantReply, JarvisSettings } from '../../shared/types'
import { ResultCard } from '../components/ResultCard'
import { AnswerText } from '../components/AnswerText'
import { Disclosure } from '../components/Disclosure'
import { formatClock, formatToday, greetingFor } from '../lib/format'

interface Turn {
  id: string
  question: string
  reply: AssistantReply | null
  error: string | null
}

const EXAMPLES = [
  'Find my latest GTA operational plan',
  'What documents do I have relating to Titan Security?',
  'Find documents relating to LRD',
  'Summarise it and tell me what still needs attention'
]

export function HomePage({ settings }: { settings: JarvisSettings }): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  // The greeting shows a live clock, so it is correct whenever the user looks.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns, busy])

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

  const openDoc = (id: string): void => void window.jarvis.documents.open(id).catch(() => undefined)
  const revealDoc = (id: string): void =>
    void window.jarvis.documents.reveal(id).catch(() => undefined)

  const hasFolders = settings.folders.length > 0

  return (
    <>
      <header className="greeting">
        <h1 className="greeting__hello">
          {greetingFor(now)}, {settings.displayName}
        </h1>
        <p className="greeting__meta">
          {formatToday(now)} · {formatClock(now)}
        </p>
      </header>

      <div className="command">
        <textarea
          ref={inputRef}
          className="command__input"
          placeholder="Ask Jarvis anything…"
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

      {!hasFolders ? (
        <div className="notice" style={{ marginTop: 'var(--s-5)' }}>
          Jarvis has no folders to look in yet. Open Settings → Data &amp; Permissions and authorise a
          folder, then run Index now. Jarvis only ever reads folders you choose, and never changes
          the files inside them.
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
                <ReplyBody reply={turn.reply} onOpen={openDoc} onReveal={revealDoc} />
              </div>
            ) : null}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </>
  )
}

function ReplyBody({
  reply,
  onOpen,
  onReveal
}: {
  reply: AssistantReply
  onOpen: (id: string) => void
  onReveal: (id: string) => void
}): React.JSX.Element {
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

      {reply.sources.length > 0 ? (
        <div className="sources">
          <div className="section-label" style={{ margin: '0 0 var(--s-3)' }}>
            Based on these files
          </div>
          <div className="sources__list">
            {reply.sources.map((source, i) => (
              <button
                key={`${source.documentId}-${source.locator ?? i}`}
                className="source"
                onClick={() => onOpen(source.documentId)}
                title={source.path}
              >
                <span className="source__num">{i + 1}</span>
                <span>
                  {source.fileName}
                  {source.locator ? <span className="source__locator"> · {source.locator}</span> : null}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {reply.disclosure ? <Disclosure disclosure={reply.disclosure} /> : null}

      {reply.results.length > 0 ? (
        <>
          <div className="section-label">
            {reply.results.length} {reply.results.length === 1 ? 'file' : 'files'} found
          </div>
          <div className="results">
            {reply.results.map((hit) => (
              <ResultCard key={hit.document.id} hit={hit} onOpen={onOpen} onReveal={onReveal} />
            ))}
          </div>
        </>
      ) : null}
    </>
  )
}
