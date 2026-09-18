import { useEffect, useState } from 'react'
import type { EmailDraft, PendingAction } from '../../shared/communication'
import { Disclosure } from './Disclosure'

interface Props {
  draft: EmailDraft
  onPrepared: (action: PendingAction) => void
  onDiscard: () => void
}

/**
 * An editable draft.
 *
 * Three exits, and none of them sends: Discard throws it away, Save to Drafts
 * puts it in Outlook untouched, and Review & Send hands it to the approval
 * panel — which is where the user, and only the user, can send it.
 */
export function DraftPanel({ draft, onPrepared, onDiscard }: Props): React.JSX.Element {
  const [subject, setSubject] = useState(draft.subject)
  const [body, setBody] = useState(draft.body)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A newly generated draft replaces whatever was being edited.
  useEffect(() => {
    setSubject(draft.subject)
    setBody(draft.body)
  }, [draft])

  async function reviewAndSend(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const action = await window.jarvis.approvals.prepareSend({ ...draft, subject, body })
      onPrepared(action)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="draft">
      <div className="draft__head">
        <span className="draft__badge">Draft — not sent</span>
        <span className="draft__account">{draft.accountLabel}</span>
      </div>

      <dl className="draft__fields">
        <div className="draft__field">
          <dt>From</dt>
          <dd>{draft.fromAddress}</dd>
        </div>
        <div className="draft__field">
          <dt>To</dt>
          <dd>{draft.to.map((r) => r.address).join(', ') || '(no recipient)'}</dd>
        </div>
        {draft.cc.length > 0 ? (
          <div className="draft__field">
            <dt>Cc</dt>
            <dd>{draft.cc.map((r) => r.address).join(', ')}</dd>
          </div>
        ) : null}
      </dl>

      <label className="field__label" htmlFor="draft-subject">
        Subject
      </label>
      <input
        id="draft-subject"
        className="input"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
      />

      <label className="field__label" htmlFor="draft-body" style={{ marginTop: 'var(--s-3)' }}>
        Message
      </label>
      <textarea
        id="draft-body"
        className="input draft__body"
        rows={10}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />

      <div className="draft__actions">
        <button className="btn btn--ghost" onClick={onDiscard} disabled={busy}>
          Discard
        </button>
        <button
          className="btn btn--primary"
          onClick={() => void reviewAndSend()}
          disabled={busy || draft.to.length === 0}
        >
          Review &amp; Send
        </button>
      </div>

      <p className="draft__note">
        Review &amp; Send does not send. It shows you the final email and asks you to approve it.
      </p>

      {error ? <p className="error-text">{error}</p> : null}
      {draft.disclosure ? <Disclosure disclosure={draft.disclosure} /> : null}
    </div>
  )
}
