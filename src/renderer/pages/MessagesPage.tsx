import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ConnectedAccount,
  EmailDraft,
  PendingAction,
  ScoredMailMessage
} from '../../shared/communication'
import { MessageCard } from '../components/MessageCard'
import { DraftPanel } from '../components/DraftPanel'
import { ApprovalPanel } from '../components/ApprovalPanel'

type Filter = 'attention' | 'unread' | 'all'

/**
 * The email workspace.
 *
 * Deliberately not an email client. It answers one question — what needs my
 * attention and what should I do about it — and leaves everything else to
 * Outlook.
 */
export function MessagesPage(): React.JSX.Element {
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [filter, setFilter] = useState<Filter>('attention')
  const [search, setSearch] = useState('')
  const [messages, setMessages] = useState<ScoredMailMessage[]>([])
  const [coverage, setCoverage] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [selected, setSelected] = useState<ScoredMailMessage | null>(null)
  const [draft, setDraft] = useState<EmailDraft | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [action, setAction] = useState<PendingAction | null>(null)
  const [instruction, setInstruction] = useState('')

  useEffect(() => {
    void window.jarvis.microsoft.status().then((s) => setAccounts(s.accounts))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const reply = await window.jarvis.assistant.ask(
        buildQuestion(filter, search, accounts.find((a) => a.id === accountId)?.label)
      )
      setMessages(reply.messages ?? [])
      setCoverage(reply.coverage ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [filter, search, accountId, accounts])

  useEffect(() => {
    const timer = setTimeout(() => void load(), 200)
    return () => clearTimeout(timer)
  }, [load])

  async function startDraft(message: ScoredMailMessage): Promise<void> {
    setSelected(message)
    setDraft(null)
    setAction(null)
    setDrafting(true)
    setError(null)
    try {
      const reply = await window.jarvis.mail.draftReply(
        message.accountId,
        message.id,
        instruction.trim() || 'Acknowledge the message and reply appropriately.'
      )
      if (reply.draft) setDraft(reply.draft)
      else setError(reply.text)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDrafting(false)
    }
  }

  const subtitle = useMemo(() => {
    if (accounts.length === 0) return 'No Microsoft accounts connected yet.'
    if (loading) return 'Loading…'
    return `${messages.length} ${messages.length === 1 ? 'message' : 'messages'}`
  }, [accounts.length, loading, messages.length])

  if (accounts.length === 0) {
    return (
      <>
        <header className="page-header">
          <h1 className="page-header__title">Messages</h1>
          <p className="page-header__subtitle">{subtitle}</p>
        </header>
        <div className="empty">
          Connect a Microsoft 365 account in Settings → Connected Accounts and Jarvis can start
          triaging your mail.
        </div>
      </>
    )
  }

  return (
    <>
      <header className="page-header">
        <h1 className="page-header__title">Messages</h1>
        <p className="page-header__subtitle">{subtitle}</p>
      </header>

      <div className="toolbar">
        <div className="segmented">
          {(['attention', 'unread', 'all'] as Filter[]).map((f) => (
            <button
              key={f}
              className={`segmented__item${filter === f ? ' segmented__item--active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'attention' ? 'Needs attention' : f === 'unread' ? 'Unread' : 'Recent'}
            </button>
          ))}
        </div>

        {accounts.length > 1 ? (
          <select className="select" style={{ maxWidth: 190 }} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        ) : null}

        <input
          className="input"
          style={{ maxWidth: 240 }}
          placeholder="Search mail…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {coverage ? <div className="notice">{coverage}</div> : null}
      {error ? <p className="error-text">{error}</p> : null}

      {action ? (
        <ApprovalPanel
          action={action}
          onResolved={(resolved) => {
            setAction(resolved)
            if (resolved.status === 'COMPLETED') setDraft(null)
          }}
        />
      ) : draft ? (
        <DraftPanel draft={draft} onPrepared={setAction} onDiscard={() => setDraft(null)} />
      ) : selected ? (
        <div className="panel">
          <h2 className="panel__title">Reply to {selected.from?.name ?? selected.from?.address}</h2>
          <p className="panel__desc">{selected.subject}</p>
          <input
            className="input"
            placeholder="What should the reply say? e.g. Sunday Zoom works."
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
          <div className="panel__actions">
            <button className="btn btn--primary" disabled={drafting} onClick={() => void startDraft(selected)}>
              {drafting ? 'Drafting…' : 'Draft reply'}
            </button>
            <button className="btn btn--ghost" onClick={() => setSelected(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {!loading && messages.length === 0 ? (
        <div className="empty">
          {filter === 'attention'
            ? 'Nothing in your recent mail looks like it needs attention.'
            : 'No messages match.'}
        </div>
      ) : (
        <div className="results">
          {messages.map((message) => (
            <MessageCard
              key={`${message.accountId}-${message.id}`}
              message={message}
              selected={selected?.id === message.id}
              onDraft={(m) => {
                setSelected(m)
                setDraft(null)
                setAction(null)
              }}
            />
          ))}
        </div>
      )}
    </>
  )
}

/**
 * The page asks Jarvis the same questions the user would type, so the workspace
 * and the composer go through exactly one retrieval path.
 */
function buildQuestion(filter: Filter, search: string, accountLabel?: string): string {
  const scope = accountLabel ? ` in my ${accountLabel} account` : ''
  if (search.trim()) return `Search my emails for "${search.trim()}"${scope}`
  if (filter === 'unread') return `Show my unread emails${scope}`
  if (filter === 'attention') return `What emails need my attention${scope}?`
  return `Check my emails${scope}`
}
