import { useEffect, useState } from 'react'
import type { DashboardSummary } from '../../shared/communication'
import { formatDateTime } from '../lib/format'

interface Props {
  onOpen: (route: 'messages' | 'calendar' | 'files') => void
}

function nextAt(epochMs?: number): string {
  if (!epochMs) return ''
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/**
 * The Home cards.
 *
 * Every number here was retrieved. Nothing is estimated and nothing is
 * invented: a capability Jarvis cannot reach says so, rather than showing a
 * zero that would read as "all clear".
 */
export function DashboardCards({ onOpen }: Props): React.JSX.Element | null {
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.jarvis.brief
      .dashboard()
      .then((s) => {
        if (!cancelled) setSummary(s)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (failed || !summary) return null

  const noMicrosoft = summary.accountsTotal === 0

  return (
    <div className="cards">
      <button className="card" onClick={() => onOpen('messages')}>
        <div className="card__label">Email</div>
        {noMicrosoft ? (
          <div className="card__empty">Connect an account</div>
        ) : summary.mail.available ? (
          <>
            <div className="card__value">{summary.mail.needsAttention}</div>
            <div className="card__detail">
              need attention · {summary.mail.unread} unread
            </div>
          </>
        ) : (
          <div className="card__empty">Mail unavailable</div>
        )}
      </button>

      <button className="card" onClick={() => onOpen('calendar')}>
        <div className="card__label">Meetings</div>
        {noMicrosoft ? (
          <div className="card__empty">Connect an account</div>
        ) : summary.calendar.available ? (
          <>
            <div className="card__value">{summary.calendar.today}</div>
            <div className="card__detail">
              {summary.calendar.nextSubject
                ? `Next: ${summary.calendar.nextSubject} — ${nextAt(summary.calendar.nextStart)}`
                : 'today'}
            </div>
          </>
        ) : (
          <div className="card__empty">Calendar unavailable</div>
        )}
      </button>

      <button className="card" onClick={() => onOpen('files')}>
        <div className="card__label">Files</div>
        <div className="card__value">{summary.documents.indexed.toLocaleString()}</div>
        <div className="card__detail">
          {summary.documents.lastIndexedAt
            ? `Indexed ${formatDateTime(summary.documents.lastIndexedAt)}`
            : 'Not indexed yet'}
        </div>
      </button>

      {summary.failures.length > 0 ? (
        <div className="cards__notice">
          {`Checked ${summary.accountsChecked} of ${summary.accountsTotal} accounts. ` +
            summary.failures.map((f) => f.reason).join(' ')}
        </div>
      ) : null}
    </div>
  )
}
