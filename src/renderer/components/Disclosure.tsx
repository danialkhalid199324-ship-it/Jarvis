import type { ExternalCallDisclosure } from '../../shared/types'

/**
 * States plainly what left the machine to produce an answer.
 *
 * This is shown on every AI-generated answer, not hidden behind a setting. It
 * is the counterpart to the promise that Jarvis never uploads whole folders.
 */
export function Disclosure({ disclosure }: { disclosure: ExternalCallDisclosure }): React.JSX.Element {
  const { local, providerLabel, model, excerptCount, charsSent, fileNames } = disclosure
  const approxWords = Math.round(charsSent / 5)

  return (
    <div className="disclosure">
      {local ? (
        <>
          <strong>Stayed on this Mac.</strong> Answered by {providerLabel} ({model}) running locally,
          using {excerptCount} {excerptCount === 1 ? 'excerpt' : 'excerpts'} from{' '}
          {fileNames.length} {fileNames.length === 1 ? 'file' : 'files'}. Nothing was sent over the
          internet.
        </>
      ) : (
        <>
          <strong>Sent to {providerLabel}.</strong> {excerptCount}{' '}
          {excerptCount === 1 ? 'excerpt' : 'excerpts'} (about {approxWords.toLocaleString()} words)
          from {fileNames.join(', ')} were sent to {model} to produce this answer. The full files
          were not sent, and no other file in your folders was included.
        </>
      )}
    </div>
  )
}
