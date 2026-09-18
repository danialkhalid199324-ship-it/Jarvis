import { useCallback, useEffect, useState } from 'react'
import type { CalendarEvent, ConnectedAccount, PendingAction } from '../../shared/communication'
import { EventCard } from '../components/EventCard'
import { ApprovalPanel } from '../components/ApprovalPanel'

type View = 'today' | 'upcoming'

function dayStart(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * The calendar workspace: today, the week ahead, and a place to prepare a
 * change. Preparing is all it does — approval happens in the panel, and only
 * then does anything reach Microsoft 365.
 */
export function CalendarPage(): React.JSX.Element {
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [view, setView] = useState<View>('today')
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [failures, setFailures] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [request, setRequest] = useState('')
  const [preparing, setPreparing] = useState(false)
  const [action, setAction] = useState<PendingAction | null>(null)

  useEffect(() => {
    void window.jarvis.microsoft.status().then((s) => setAccounts(s.accounts))
  }, [])

  const load = useCallback(async () => {
    if (accounts.length === 0) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    const now = Date.now()
    const from = dayStart(now)
    const to = view === 'today' ? from + 86_400_000 : from + 7 * 86_400_000
    try {
      const result = await window.jarvis.calendar.list({
        from,
        to,
        ...(accountId ? { accountId } : {})
      })
      setEvents(result.items)
      setFailures(result.failures.map((f) => f.reason))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [view, accountId, accounts.length])

  useEffect(() => {
    void load()
  }, [load])

  async function prepare(): Promise<void> {
    if (!request.trim()) return
    setPreparing(true)
    setError(null)
    setAction(null)
    try {
      const reply = await window.jarvis.assistant.ask(request.trim())
      if (reply.pendingAction) setAction(reply.pendingAction)
      else setError(reply.text)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPreparing(false)
    }
  }

  if (accounts.length === 0) {
    return (
      <>
        <header className="page-header">
          <h1 className="page-header__title">Calendar</h1>
        </header>
        <div className="empty">
          Connect a Microsoft 365 account in Settings → Connected Accounts and your calendar will
          appear here.
        </div>
      </>
    )
  }

  return (
    <>
      <header className="page-header">
        <h1 className="page-header__title">Calendar</h1>
        <p className="page-header__subtitle">
          {loading
            ? 'Loading…'
            : `${events.length} ${events.length === 1 ? 'meeting' : 'meetings'} ${
                view === 'today' ? 'today' : 'in the next seven days'
              }`}
        </p>
      </header>

      <div className="toolbar">
        <div className="segmented">
          {(['today', 'upcoming'] as View[]).map((v) => (
            <button
              key={v}
              className={`segmented__item${view === v ? ' segmented__item--active' : ''}`}
              onClick={() => setView(v)}
            >
              {v === 'today' ? 'Today' : 'Upcoming'}
            </button>
          ))}
        </div>
        {accounts.length > 1 ? (
          <select className="select" style={{ maxWidth: 190 }} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">All calendars</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {failures.map((f) => (
        <div className="notice" key={f}>
          {f}
        </div>
      ))}

      <div className="panel">
        <h2 className="panel__title">Prepare a change</h2>
        <p className="panel__desc">
          Describe what you want — "move the Titan Strategy Call tomorrow to 3 PM", "cancel
          tomorrow's stand-up". Jarvis prepares it and shows you exactly what would happen. Your
          calendar is not touched until you approve.
        </p>
        <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
          <input
            className="input"
            placeholder="What would you like to change?"
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void prepare()
            }}
          />
          <button className="btn" disabled={preparing || !request.trim()} onClick={() => void prepare()}>
            {preparing ? 'Preparing…' : 'Prepare'}
          </button>
        </div>
        {error ? <p className="error-text">{error}</p> : null}
      </div>

      {action ? <ApprovalPanel action={action} onResolved={(r) => { setAction(r); if (r.status === 'COMPLETED') void load() }} /> : null}

      {!loading && events.length === 0 ? (
        <div className="empty">Nothing scheduled {view === 'today' ? 'today' : 'in the next seven days'}.</div>
      ) : (
        <div className="results">
          {events.map((event) => (
            <EventCard key={`${event.accountId}-${event.id}`} event={event} showDay={view === 'upcoming'} />
          ))}
        </div>
      )}
    </>
  )
}
