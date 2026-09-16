import { useCallback, useEffect, useState } from 'react'
import type { BootstrapInfo } from '../../shared/ipc'
import type {
  IndexStats,
  IndexStatus,
  JarvisSettings,
  LogEntry,
  ProviderDescriptor
} from '../../shared/types'
import { formatBytes, formatDateTime } from '../lib/format'

interface Props {
  bootstrap: BootstrapInfo
  settings: JarvisSettings
  indexStatus: IndexStatus | null
  onSettingsChanged: () => Promise<void>
}

export function SettingsPage({
  bootstrap,
  settings,
  indexStatus,
  onSettingsChanged
}: Props): React.JSX.Element {
  return (
    <>
      <header className="page-header">
        <h1 className="page-header__title">Settings</h1>
        <p className="page-header__subtitle">
          Jarvis reads only what you authorise here, and never modifies your files.
        </p>
      </header>

      <DataAndPermissions
        settings={settings}
        bootstrap={bootstrap}
        indexStatus={indexStatus}
        onSettingsChanged={onSettingsChanged}
      />
      <AIProvider settings={settings} bootstrap={bootstrap} onSettingsChanged={onSettingsChanged} />
      <Personal settings={settings} onSettingsChanged={onSettingsChanged} />
      <Activity bootstrap={bootstrap} />
    </>
  )
}

// ---------------------------------------------------------------------------
// Data & Permissions
// ---------------------------------------------------------------------------

function DataAndPermissions({
  settings,
  bootstrap,
  indexStatus,
  onSettingsChanged
}: {
  settings: JarvisSettings
  bootstrap: BootstrapInfo
  indexStatus: IndexStatus | null
  onSettingsChanged: () => Promise<void>
}): React.JSX.Element {
  const [stats, setStats] = useState<IndexStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const refreshStats = useCallback(async () => {
    setStats(await window.jarvis.index.stats())
  }, [])

  useEffect(() => {
    void refreshStats()
  }, [refreshStats, indexStatus?.phase])

  const indexing = indexStatus ? indexStatus.phase !== 'idle' : false

  async function run(action: () => Promise<unknown>): Promise<void> {
    setError(null)
    try {
      await action()
      await onSettingsChanged()
      await refreshStats()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const progress =
    indexStatus && indexStatus.total > 0
      ? Math.min(
          100,
          Math.round(((indexStatus.processed + indexStatus.skipped) / indexStatus.total) * 100)
        )
      : 0

  return (
    <section className="panel">
      <h2 className="panel__title">Data &amp; Permissions</h2>
      <p className="panel__desc">
        Jarvis can only see folders you add here. It never scans your whole Mac, and it never
        modifies, moves, renames or deletes anything inside these folders — it only reads them.
      </p>

      {settings.folders.length === 0 ? (
        <div className="empty">No folders authorised yet.</div>
      ) : (
        <div>
          {settings.folders.map((folder) => (
            <div className="folder" key={folder.id}>
              <div style={{ minWidth: 0 }}>
                <div className="folder__label">{folder.label}</div>
                <div className="folder__path">{folder.path}</div>
              </div>
              <button
                className="btn btn--sm btn--danger"
                disabled={indexing}
                onClick={() => void run(() => window.jarvis.folders.remove(folder.id))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="panel__actions">
        <button
          className="btn btn--primary"
          disabled={indexing}
          onClick={() => void run(() => window.jarvis.folders.choose())}
        >
          Add folder
        </button>
        <button
          className="btn"
          disabled={indexing || settings.folders.length === 0}
          onClick={() => void run(() => window.jarvis.index.start())}
        >
          Index now
        </button>
        <button
          className="btn"
          disabled={indexing || settings.folders.length === 0}
          onClick={() => void run(() => window.jarvis.index.start({ force: true }))}
          title="Re-read every file, even ones that look unchanged"
        >
          Rebuild from scratch
        </button>
        {indexing ? (
          <button className="btn btn--ghost" onClick={() => void window.jarvis.index.cancel()}>
            Stop
          </button>
        ) : null}
      </div>

      {error ? <p className="error-text">{error}</p> : null}

      {/* Indexing status */}
      <div style={{ marginTop: 'var(--s-5)' }}>
        <div className="section-label" style={{ marginTop: 0 }}>
          Indexing status
        </div>
        {indexing && indexStatus ? (
          <>
            <div className="progress">
              <div className="progress__bar" style={{ width: `${progress}%` }} />
            </div>
            <div className="status-line">
              <span className="dot dot--active" />
              <span className="truncate">
                {indexStatus.phase === 'scanning'
                  ? 'Looking through your authorised folders…'
                  : indexStatus.phase === 'writing'
                    ? 'Saving the index…'
                    : indexStatus.phase === 'cancelling'
                      ? 'Stopping…'
                      : `Reading ${indexStatus.processed + indexStatus.skipped} of ${indexStatus.total}`}
              </span>
            </div>
            {indexStatus.currentFile ? (
              <p className="field__help truncate" style={{ marginTop: 'var(--s-2)' }}>
                {indexStatus.currentFile}
              </p>
            ) : null}
          </>
        ) : (
          <div className="status-line">
            <span className={`dot ${indexStatus?.error ? 'dot--warn' : 'dot--ok'}`} />
            <span>
              {indexStatus?.error
                ? `Last run ended with a problem: ${indexStatus.error}`
                : `Idle. Last indexed ${formatDateTime(stats?.lastIndexedAt ?? null)}.`}
            </span>
          </div>
        )}

        {indexStatus && indexStatus.failed > 0 && !indexing ? (
          <p className="field__help" style={{ marginTop: 'var(--s-2)' }}>
            {indexStatus.failed} {indexStatus.failed === 1 ? 'file' : 'files'} could not be read.
            They are still listed under Files with the reason shown.
          </p>
        ) : null}
      </div>

      {/* What Jarvis holds */}
      <div style={{ marginTop: 'var(--s-6)' }}>
        <div className="section-label" style={{ marginTop: 0 }}>
          What Jarvis has stored
        </div>
        <div className="stats">
          <div>
            <div className="stat__value">{(stats?.documentCount ?? 0).toLocaleString()}</div>
            <div className="stat__label">Files indexed</div>
          </div>
          <div>
            <div className="stat__value">{(stats?.chunkCount ?? 0).toLocaleString()}</div>
            <div className="stat__label">Passages</div>
          </div>
          <div>
            <div className="stat__value">{formatBytes(stats?.indexSizeBytes ?? 0)}</div>
            <div className="stat__label">Index size</div>
          </div>
        </div>

        <p className="field__help">
          This index lives only on this Mac, at {' '}
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
            {'~/Library/Application Support/Jarvis'}
          </code>
          . Deleting it removes everything Jarvis has read and remembered. Your original files are
          not touched.
        </p>

        <div className="panel__actions">
          {confirmingDelete ? (
            <>
              <button
                className="btn btn--danger"
                onClick={() =>
                  void run(async () => {
                    await window.jarvis.index.deleteAll()
                    setConfirmingDelete(false)
                  })
                }
              >
                Yes, delete Jarvis's index
              </button>
              <button className="btn btn--ghost" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn btn--danger" disabled={indexing} onClick={() => setConfirmingDelete(true)}>
              Delete Jarvis's index
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// AI provider
// ---------------------------------------------------------------------------

function AIProvider({
  settings,
  bootstrap,
  onSettingsChanged
}: {
  settings: JarvisSettings
  bootstrap: BootstrapInfo
  onSettingsChanged: () => Promise<void>
}): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderDescriptor[]>([])
  const [apiKey, setApiKey] = useState('')
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const refresh = useCallback(async () => {
    setProviders(await window.jarvis.providers.list())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const active = providers.find((p) => p.id === settings.ai.activeProviderId)

  async function save(patch: Partial<JarvisSettings>): Promise<void> {
    setMessage(null)
    try {
      await window.jarvis.settings.update(patch)
      await onSettingsChanged()
      await refresh()
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <section className="panel">
      <h2 className="panel__title">AI Provider</h2>
      <p className="panel__desc">
        Searching your files happens entirely on this Mac and needs no provider. A provider is only
        used when you ask Jarvis to read, summarise or compare documents — and then only the
        specific excerpts it selected are sent.
      </p>

      <div className="field">
        <label className="field__label" htmlFor="provider">
          Provider
        </label>
        <select
          id="provider"
          className="select"
          value={settings.ai.activeProviderId}
          onChange={(e) => {
            const provider = providers.find((p) => p.id === e.target.value)
            void save({
              ai: {
                ...settings.ai,
                activeProviderId: e.target.value,
                model: provider?.models[0]?.id ?? settings.ai.model
              }
            })
          }}
        >
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
            </option>
          ))}
        </select>
        {active ? <p className="field__help">{active.dataNotice}</p> : null}
      </div>

      <div className="field">
        <label className="field__label" htmlFor="model">
          Model
        </label>
        <input
          id="model"
          className="input input--mono"
          list="model-suggestions"
          value={settings.ai.model}
          onChange={(e) => void save({ ai: { ...settings.ai, model: e.target.value } })}
        />
        <datalist id="model-suggestions">
          {(active?.models ?? []).map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </datalist>
        <p className="field__help">
          {(active?.models ?? []).map((m) => m.label).join(' · ') || 'Enter the model identifier.'}
        </p>
      </div>

      {settings.ai.activeProviderId === 'openai-compatible' ? (
        <div className="field">
          <label className="field__label" htmlFor="baseUrl">
            Endpoint
          </label>
          <input
            id="baseUrl"
            className="input input--mono"
            placeholder="https://api.openai.com/v1"
            value={settings.ai.baseUrl ?? ''}
            onChange={(e) => void save({ ai: { ...settings.ai, baseUrl: e.target.value } })}
          />
          <p className="field__help">
            Point this at <code>http://localhost:11434/v1</code> to use a model running on this Mac
            through Ollama. Nothing then leaves your machine at all.
          </p>
        </div>
      ) : null}

      <div className="field">
        <label className="field__label" htmlFor="apiKey">
          API key
        </label>
        <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
          <input
            id="apiKey"
            className="input input--mono"
            type="password"
            autoComplete="off"
            placeholder={active?.configured ? 'A key is saved' : 'Paste your API key'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button
            className="btn"
            disabled={!apiKey.trim()}
            onClick={() =>
              void (async () => {
                try {
                  await window.jarvis.providers.setApiKey(settings.ai.activeProviderId, apiKey)
                  setApiKey('')
                  setMessage({ kind: 'ok', text: 'Saved to your macOS keychain.' })
                  await refresh()
                } catch (err) {
                  setMessage({
                    kind: 'error',
                    text: err instanceof Error ? err.message : String(err)
                  })
                }
              })()
            }
          >
            Save
          </button>
          {active?.configured ? (
            <button
              className="btn btn--ghost"
              onClick={() =>
                void (async () => {
                  await window.jarvis.providers.clearApiKey(settings.ai.activeProviderId)
                  setMessage({ kind: 'ok', text: 'Key removed.' })
                  await refresh()
                })()
              }
            >
              Remove
            </button>
          ) : null}
        </div>
        <p className="field__help">
          {bootstrap.secureStorageAvailable
            ? 'Keys are encrypted by your macOS keychain and never written to a settings file, a log, or anywhere in Jarvis’s own code.'
            : 'Your keychain is currently unavailable, so Jarvis will not save a key. Unlock it and try again.'}
        </p>
        {message ? (
          <p className={message.kind === 'ok' ? 'ok-text' : 'error-text'}>{message.text}</p>
        ) : null}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Personal
// ---------------------------------------------------------------------------

function Personal({
  settings,
  onSettingsChanged
}: {
  settings: JarvisSettings
  onSettingsChanged: () => Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState(settings.displayName)

  return (
    <section className="panel">
      <h2 className="panel__title">Personal</h2>
      <div className="field">
        <label className="field__label" htmlFor="displayName">
          What Jarvis calls you
        </label>
        <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
          <input
            id="displayName"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            className="btn"
            disabled={name.trim() === '' || name === settings.displayName}
            onClick={() =>
              void (async () => {
                await window.jarvis.settings.update({ displayName: name.trim() })
                await onSettingsChanged()
              })()
            }
          >
            Save
          </button>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

function Activity({ bootstrap }: { bootstrap: BootstrapInfo }): React.JSX.Element {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (expanded) void window.jarvis.diagnostics.activityLog(60).then(setEntries)
  }, [expanded])

  return (
    <section className="panel">
      <h2 className="panel__title">Activity</h2>
      <p className="panel__desc">
        Jarvis writes what it does to a log on this Mac — folders authorised, index runs, and every
        time document text was sent to an AI provider. Nothing is sent anywhere.
      </p>

      <div className="panel__actions">
        <button className="btn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Hide activity' : 'Show recent activity'}
        </button>
        <button className="btn btn--ghost" onClick={() => void window.jarvis.diagnostics.openDataFolder()}>
          Open Jarvis's data folder
        </button>
      </div>

      {expanded ? (
        entries.length === 0 ? (
          <div className="empty" style={{ marginTop: 'var(--s-4)' }}>
            Nothing logged yet.
          </div>
        ) : (
          <div style={{ marginTop: 'var(--s-4)' }}>
            {entries.map((entry, i) => (
              <div className="folder" key={`${entry.at}-${i}`}>
                <div style={{ minWidth: 0 }}>
                  <div className="folder__label">{entry.event}</div>
                  <div className="folder__path">
                    {entry.detail ? JSON.stringify(entry.detail) : '—'}
                  </div>
                </div>
                <span style={{ color: 'var(--text-tertiary)', fontSize: 12, flexShrink: 0 }}>
                  {new Date(entry.at).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        )
      ) : null}

      <p className="field__help" style={{ marginTop: 'var(--s-4)' }}>
        Data folder: <span style={{ fontFamily: 'var(--font-mono)' }}>{bootstrap.dataDir}</span>
      </p>
    </section>
  )
}
