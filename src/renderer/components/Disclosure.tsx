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

  // V0.1 sent document excerpts; V0.2 can also send email. The wording follows
  // whichever it actually was, so the statement is always literally true.
  const labels = disclosure.itemLabels ?? fileNames
  const noun =
    disclosure.itemKind === 'emails'
      ? labels.length === 1
        ? 'email'
        : 'emails'
      : disclosure.itemKind === 'calendar'
        ? 'calendar entries'
        : labels.length === 1
          ? 'file'
          : 'files'
  const where =
    disclosure.accountLabels && disclosure.accountLabels.length > 0
      ? ` from your ${disclosure.accountLabels.join(' and ')} ${
          disclosure.accountLabels.length === 1 ? 'account' : 'accounts'
        }`
      : ''

  return (
    <div className="disclosure">
      {local ? (
        <>
          <strong>Stayed on this Mac.</strong> Answered by {providerLabel} ({model}) running locally,
          using {excerptCount} {excerptCount === 1 ? 'excerpt' : 'excerpts'} from {labels.length}{' '}
          {noun}. Nothing was sent over the internet.
        </>
      ) : (
        <>
          <strong>Sent to {providerLabel}.</strong> {excerptCount}{' '}
          {excerptCount === 1 ? 'excerpt' : 'excerpts'} (about {approxWords.toLocaleString()} words)
          from {labels.length} {noun}
          {where} {labels.length === 1 ? 'was' : 'were'} sent to {model} to produce this answer.
          {labels.length > 0 ? ` (${labels.join(', ')}.)` : ''} Nothing else was included.
        </>
      )}
    </div>
  )
}
