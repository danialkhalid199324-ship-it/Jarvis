import type { ScoredMailMessage } from '../../shared/communication'
import { formatDate } from '../lib/format'

interface Props {
  message: ScoredMailMessage
  onOpen?: (message: ScoredMailMessage) => void
  onDraft?: (message: ScoredMailMessage) => void
  selected?: boolean
}

function when(epochMs: number): string {
  const today = new Date().setHours(0, 0, 0, 0)
  if (epochMs >= today) {
    return new Date(epochMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  }
  return formatDate(epochMs)
}

/**
 * One email, as an executive assistant would present it: who, what, when,
 * which account, and — when Jarvis raised it — why.
 */
export function MessageCard({ message, onOpen, onDraft, selected }: Props): React.JSX.Element {
  const from = message.from?.name ?? message.from?.address ?? 'Unknown sender'

  return (
    <div className={`result message${selected ? ' result--selected' : ''}`}>
      <div className="result__head">
        <span className="result__name">{message.subject}</span>
        <span className="result__badges">
          {!message.isRead ? <span className="badge badge--unread">Unread</span> : null}
          {message.importance === 'high' ? <span className="badge badge--high">High</span> : null}
          <span className="result__type">{message.accountLabel}</span>
        </span>
      </div>

      <div className="result__meta">
        <span className="message__from">{from}</span>
        <span>{when(message.receivedAt)}</span>
        {message.hasAttachments ? <span>Attachment</span> : null}
      </div>

      {message.preview ? <div className="result__snippet">{message.preview.slice(0, 260)}</div> : null}

      {message.attention.needsAttention && message.attention.reasons.length > 0 ? (
        <p className="result__reason">
          Raised because it is {message.attention.reasons.slice(0, 3).join(', ')}.
        </p>
      ) : null}

      {onOpen || onDraft ? (
        <div className="result__actions">
          {onOpen ? (
            <button className="btn btn--sm btn--ghost" onClick={() => onOpen(message)}>
              Open
            </button>
          ) : null}
          {onDraft ? (
            <button className="btn btn--sm" onClick={() => onDraft(message)}>
              Draft reply
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
