import { useState } from 'react'
import type { PendingAction } from '../../shared/communication'

interface Props {
  action: PendingAction
  onResolved: (action: PendingAction) => void
}

const VERB: Record<PendingAction['type'], string> = {
  SEND_EMAIL: 'Send this email',
  CREATE_EVENT: 'Create this meeting',
  UPDATE_EVENT: 'Apply this change',
  DELETE_EVENT: 'Cancel this meeting'
}

const HEADING: Record<PendingAction['type'], string> = {
  SEND_EMAIL: 'Approve sending this email',
  CREATE_EVENT: 'Approve this new meeting',
  UPDATE_EVENT: 'Approve this calendar change',
  DELETE_EVENT: 'Approve this cancellation'
}

/**
 * The approval gate.
 *
 * Shows the exact thing that would happen — every recipient, the full message
 * body, the before and after of a time change — and does nothing until the
 * user presses the approve button. This component is the only place in the UI
 * from which a consequential action can be started.
 */
export function ApprovalPanel({ action, onResolved }: Props): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const settled = action.status !== 'PROPOSED'

  async function run(decision: 'approve' | 'reject'): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const result =
        decision === 'approve'
          ? await window.jarvis.approvals.approve(action.id)
          : await window.jarvis.approvals.reject(action.id)
      onResolved(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`approval approval--${action.riskLevel}`}>
      <div className="approval__head">
        <span className="approval__badge">Needs your approval</span>
        <span className="approval__account">{action.accountLabel}</span>
      </div>

      <h3 className="approval__title">{HEADING[action.type]}</h3>

      <dl className="approval__fields">
        {action.preview.map((field) => (
          <div className="approval__field" key={field.label}>
            <dt>{field.label}</dt>
            <dd>
              {field.previous !== undefined ? (
                <>
                  <span className="approval__before">{field.previous}</span>
                  <span className="approval__arrow">→</span>
                  <span className="approval__after">{field.value}</span>
                </>
              ) : (
                <span className="approval__value">{field.value}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>

      {action.warning ? <p className="approval__warning">{action.warning}</p> : null}

      {settled ? (
        <p className={action.status === 'COMPLETED' ? 'ok-text' : 'error-text'}>
          {action.status === 'COMPLETED'
            ? (action.resultSummary ?? 'Done.')
            : action.status === 'REJECTED'
              ? 'Cancelled. Nothing was sent or changed.'
              : (action.error ?? `This action ${action.status.toLowerCase()}.`)}
        </p>
      ) : (
        <>
          <div className="approval__actions">
            <button className="btn" disabled={busy} onClick={() => void run('reject')}>
              Cancel
            </button>
            <button
              className={action.riskLevel === 'high' ? 'btn btn--danger' : 'btn btn--primary'}
              disabled={busy}
              onClick={() => void run('approve')}
            >
              {busy ? 'Working…' : VERB[action.type]}
            </button>
          </div>
          <p className="approval__note">
            Nothing has happened yet. Jarvis only acts when you press the button above.
          </p>
        </>
      )}

      {error ? <p className="error-text">{error}</p> : null}
    </div>
  )
}
