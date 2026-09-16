interface Props {
  title: string
  version: string
  description: string
  plans: string[]
}

/**
 * The honest placeholder.
 *
 * Sections Jarvis cannot do yet say so, and say when they are planned. There is
 * no mock data anywhere in this app — a screen that looks functional but is not
 * would be worse than an empty one.
 */
export function ComingLater({ title, version, description, plans }: Props): React.JSX.Element {
  return (
    <>
      <header className="page-header">
        <h1 className="page-header__title">{title}</h1>
      </header>
      <div className="later">
        <span className="later__badge">Planned for {version}</span>
        <p className="page-header__subtitle">{description}</p>
        <ul className="later__list">
          {plans.map((plan) => (
            <li key={plan}>{plan}</li>
          ))}
        </ul>
        <p className="field__help" style={{ marginTop: 'var(--s-6)' }}>
          Nothing on this screen is active yet. Jarvis V0.1 does one thing properly: finding and
          answering questions about the documents in the folders you have authorised.
        </p>
      </div>
    </>
  )
}
