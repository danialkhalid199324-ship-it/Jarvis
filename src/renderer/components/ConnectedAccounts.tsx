import { useCallback, useEffect, useState } from 'react'
import type { MicrosoftStatus } from '../../shared/ipc'
import { formatDateTime } from '../lib/format'

/**
 * Settings → Connected Accounts.
 *
 * Shows each Microsoft account's identity and health, and nothing else. There
 * is no token here to display because the renderer is never given one.
 */
export function ConnectedAccounts(): React.JSX.Element {
  const [status, setStatus] = useState<MicrosoftStatus | null>(null)
  const [clientId, setClientId] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showScopes, setShowScopes] = useState(false)

  const refresh = useCallback(async () => {
    const next = await window.jarvis.microsoft.status()
    setStatus(next)
    setClientId(next.clientId ?? '')
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(label)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  if (!status) return <section className="panel">Loading…</section>

  return (
    <section className="panel">
      <h2 className="panel__title">Connected Accounts</h2>
      <p className="panel__desc">
        Jarvis signs in as you, in your own browser, and can only reach what you can reach. It never
        sends without your approval and never changes your calendar without your approval.
      </p>

      <div className="field">
        <label className="field__label" htmlFor="ms-client-id">
          Microsoft 365
        </label>
        <p className="field__help">
          Jarvis needs your own Azure application (client) ID. Register a free app at
          portal.azure.com → App registrations, choose <strong>Public client / native</strong>, and
          add the redirect URI <code>http://localhost</code>. There is no secret to create — Jarvis
          is a public client and stores none.
        </p>
        <div style={{ display: 'flex', gap: 'var(--s-2)', marginTop: 'var(--s-2)' }}>
          <input
            id="ms-client-id"
            className="input input--mono"
            placeholder="00000000-0000-0000-0000-000000000000"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
          <button
            className="btn"
            disabled={busy !== null || !clientId.trim() || clientId.trim() === status.clientId}
            onClick={() => void run('clientId', () => window.jarvis.microsoft.setClientId(clientId))}
          >
            Save
          </button>
        </div>
      </div>

      {status.accounts.length === 0 ? (
        <div className="empty">No Microsoft accounts connected yet.</div>
      ) : (
        <div>
          {status.accounts.map((account) => (
            <div className="account" key={account.id}>
              <div className="account__identity">
                <div className="account__label">{account.label}</div>
                <div className="account__email">{account.username}</div>
                <div className="status-line" style={{ marginTop: 'var(--s-2)' }}>
                  <span
                    className={`dot ${
                      account.status === 'connected'
                        ? 'dot--ok'
                        : account.status === 'needs_reauth'
                          ? 'dot--warn'
                          : 'dot--warn'
                    }`}
                  />
                  <span>
                    {account.status === 'connected'
                      ? `Connected · Last synced ${formatDateTime(account.lastSyncAt)}`
                      : (account.statusDetail ?? 'Needs attention')}
                  </span>
                </div>
              </div>
              <div className="account__actions">
                <button
                  className="btn btn--sm"
                  disabled={busy !== null}
                  onClick={() => void run(account.id, () => window.jarvis.microsoft.sync(account.id))}
                >
                  {busy === account.id ? 'Syncing…' : 'Sync'}
                </button>
                <button
                  className="btn btn--sm btn--danger"
                  disabled={busy !== null}
                  onClick={() => void run(account.id, () => window.jarvis.microsoft.disconnect(account.id))}
                >
                  Disconnect
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="panel__actions">
        <button
          className="btn btn--primary"
          disabled={busy !== null || !status.configured}
          onClick={() => void run('connect', () => window.jarvis.microsoft.connect())}
          title={status.configured ? undefined : 'Add your Azure application ID first'}
        >
          {busy === 'connect' ? 'Waiting for your browser…' : 'Connect Microsoft Account'}
        </button>
        <button className="btn btn--ghost" onClick={() => setShowScopes((v) => !v)}>
          {showScopes ? 'Hide permissions' : 'What permissions does this ask for?'}
        </button>
      </div>

      {busy === 'connect' ? (
        <p className="field__help" style={{ marginTop: 'var(--s-3)' }}>
          Your browser has opened for sign-in. Jarvis is waiting — come back once Microsoft says you
          are connected.
        </p>
      ) : null}

      {error ? <p className="error-text">{error}</p> : null}

      {showScopes ? (
        <div style={{ marginTop: 'var(--s-4)' }}>
          <div className="section-label" style={{ marginTop: 0 }}>
            Delegated permissions requested
          </div>
          {status.scopes.map((scope) => (
            <div className="folder" key={scope.scope}>
              <div style={{ minWidth: 0 }}>
                <div className="folder__label">{scope.scope}</div>
                <div className="field__help">{scope.neededFor}</div>
              </div>
              {scope.requiresAdminConsent ? (
                <span className="badge badge--high" style={{ flexShrink: 0 }}>
                  Admin consent
                </span>
              ) : null}
            </div>
          ))}
          <p className="field__help" style={{ marginTop: 'var(--s-3)' }}>
            All of these are delegated permissions: Jarvis acts as you and can never reach another
            person's mailbox. None are organisation-wide. If your workplace has switched off user
            consent, an administrator will need to approve these once for your account.
          </p>
        </div>
      ) : null}
    </section>
  )
}
