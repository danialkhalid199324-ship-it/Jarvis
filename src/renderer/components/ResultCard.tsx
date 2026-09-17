import type { SearchHit } from '../../shared/types'
import { formatBytes, formatDate, shortenPath } from '../lib/format'

interface Props {
  hit: SearchHit
  onOpen: (documentId: string) => void
  onReveal: (documentId: string) => void
  /** Scope the conversation to this document. */
  onSelect?: (hit: SearchHit) => void
  /** True when this document is the one currently selected. */
  selected?: boolean
}

/**
 * One file result. Shows everything needed to judge it without opening it:
 * name, type, location, when it last changed, and why Jarvis thinks it matters.
 */
export function ResultCard({ hit, onOpen, onReveal, onSelect, selected }: Props): React.JSX.Element {
  const { document: doc } = hit
  const snippet = hit.snippets[0]
  // A document with no readable text cannot be discussed, so selecting it
  // would promise something Jarvis cannot deliver.
  const canDiscuss = doc.chunkCount > 0

  return (
    <div className={selected ? 'result result--selected' : 'result'}>
      <div className="result__head">
        <span className="result__name">{doc.fileName}</span>
        <span className="result__badges">
          {selected ? <span className="result__selected">Selected</span> : null}
          <span className="result__type">{doc.fileType}</span>
        </span>
      </div>

      <div className="result__meta">
        <span title={doc.path} className="result__path">
          {shortenPath(doc.directory)}
        </span>
        <span>Modified {formatDate(doc.modifiedAt)}</span>
        <span>{formatBytes(doc.size)}</span>
      </div>

      <p className="result__reason">{hit.reason}</p>

      {snippet ? (
        <div className="result__snippet">
          {snippet.locator ? <strong>{snippet.locator}: </strong> : null}
          {snippet.text.slice(0, 320)}
          {snippet.text.length > 320 ? '…' : ''}
        </div>
      ) : null}

      {doc.extractionError ? (
        <p className="result__warning">Jarvis could not read this file: {doc.extractionError}</p>
      ) : null}

      <div className="result__actions">
        {onSelect && canDiscuss ? (
          <button
            className={selected ? 'btn btn--sm btn--primary' : 'btn btn--sm'}
            onClick={() => onSelect(hit)}
            title="Ask Jarvis questions about this document specifically"
          >
            {selected ? 'Asking about this' : 'Ask about this'}
          </button>
        ) : null}
        <button className="btn btn--sm btn--ghost" onClick={() => onOpen(doc.id)}>
          Open file
        </button>
        <button className="btn btn--sm btn--ghost" onClick={() => onReveal(doc.id)}>
          Show in Finder
        </button>
      </div>
    </div>
  )
}
