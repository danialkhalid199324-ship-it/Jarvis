/**
 * Renders Jarvis's answer, styling the bracketed citation markers it was asked
 * to produce so the user can see at a glance which claim came from where.
 */
export function AnswerText({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(/(\[\d+(?:\s*,\s*\d+)*\])/g)
  return (
    <div className="answer">
      {parts.map((part, i) => {
        const match = /^\[(\d+(?:\s*,\s*\d+)*)\]$/.exec(part)
        if (!match) return <span key={i}>{part}</span>
        return (
          <span key={i} className="answer__cite">
            {match[1]!.replace(/\s+/g, '')}
          </span>
        )
      })}
    </div>
  )
}
