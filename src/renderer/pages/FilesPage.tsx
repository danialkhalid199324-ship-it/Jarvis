import { useEffect, useMemo, useState } from 'react'
import type { DocumentMeta, JarvisSettings } from '../../shared/types'
import { formatBytes, formatDate, shortenPath } from '../lib/format'

/**
 * Everything Jarvis has indexed, and nothing else. This is a view onto real
 * state — if the list is empty, it is because nothing has been indexed yet.
 */
export function FilesPage({ settings }: { settings: JarvisSettings | null }): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [folderId, setFolderId] = useState('')
  const [documents, setDocuments] = useState<DocumentMeta[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    // Debounced so typing does not fire a request per keystroke.
    const timer = setTimeout(() => {
      void window.jarvis.documents
        .list({
          ...(search.trim() ? { search: search.trim() } : {}),
          ...(folderId ? { folderId } : {}),
          limit: 300
        })
        .then((result) => {
          if (cancelled) return
          setDocuments(result.documents)
          setTotal(result.total)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 180)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [search, folderId])

  const folders = settings?.folders ?? []

  const subtitle = useMemo(() => {
    if (loading) return 'Loading…'
    if (total === 0) return 'Nothing indexed yet.'
    return `${total.toLocaleString()} ${total === 1 ? 'file' : 'files'} indexed${
      documents.length < total ? `, showing the ${documents.length} most recent` : ''
    }.`
  }, [loading, total, documents.length])

  return (
    <>
      <header className="page-header">
        <h1 className="page-header__title">Files</h1>
        <p className="page-header__subtitle">{subtitle}</p>
      </header>

      <div style={{ display: 'flex', gap: 'var(--s-3)', marginBottom: 'var(--s-5)' }}>
        <input
          className="input"
          placeholder="Filter by file or folder name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {folders.length > 1 ? (
          <select
            className="select"
            style={{ maxWidth: 220 }}
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
          >
            <option value="">All folders</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.label}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {!loading && documents.length === 0 ? (
        <div className="empty">
          {total === 0 && !search
            ? 'Jarvis has not indexed anything yet. Authorise a folder in Settings → Data & Permissions, then run Index now.'
            : 'No files match that filter.'}
        </div>
      ) : (
        <div className="results">
          {documents.map((doc) => (
            <div className="result" key={doc.id}>
              <div className="result__head">
                <span className="result__name">{doc.fileName}</span>
                <span className="result__type">{doc.fileType}</span>
              </div>
              <div className="result__meta">
                <span className="result__path" title={doc.path}>
                  {shortenPath(doc.directory)}
                </span>
                <span>Modified {formatDate(doc.modifiedAt)}</span>
                <span>{formatBytes(doc.size)}</span>
                <span>
                  {doc.chunkCount} {doc.chunkCount === 1 ? 'passage' : 'passages'}
                </span>
              </div>
              {doc.extractionError ? (
                <p className="result__warning">Not searchable: {doc.extractionError}</p>
              ) : null}
              <div className="result__actions">
                <button className="btn btn--sm" onClick={() => void window.jarvis.documents.open(doc.id)}>
                  Open file
                </button>
                <button
                  className="btn btn--sm btn--ghost"
                  onClick={() => void window.jarvis.documents.reveal(doc.id)}
                >
                  Show in Finder
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
