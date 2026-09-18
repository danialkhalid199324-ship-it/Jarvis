import type { CalendarEvent } from '../../shared/communication'

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function formatDay(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  })
}

/** One meeting, always showing which calendar it came from. */
export function EventCard({
  event,
  showDay = false
}: {
  event: CalendarEvent
  showDay?: boolean
}): React.JSX.Element {
  const attendees = event.attendees.filter((a) => a.address !== event.organizer?.address)

  return (
    <div className="result event">
      <div className="event__time">
        {showDay ? <span className="event__day">{formatDay(event.start)}</span> : null}
        <span className="event__hours">
          {event.isAllDay ? 'All day' : `${formatTime(event.start)} – ${formatTime(event.end)}`}
        </span>
      </div>

      <div className="event__body">
        <div className="result__head">
          <span className="result__name">{event.subject}</span>
          <span className="result__type">{event.accountLabel}</span>
        </div>

        <div className="result__meta">
          {event.location ? <span>{event.location}</span> : null}
          {attendees.length > 0 ? (
            <span>
              {attendees.length} {attendees.length === 1 ? 'attendee' : 'attendees'}
            </span>
          ) : null}
          {event.organizer ? <span>Organiser: {event.organizer.name ?? event.organizer.address}</span> : null}
        </div>

        {event.onlineMeetingUrl ? (
          <div className="result__actions">
            <a className="btn btn--sm btn--ghost" href={event.onlineMeetingUrl} target="_blank" rel="noreferrer">
              Join online
            </a>
          </div>
        ) : null}
      </div>
    </div>
  )
}
