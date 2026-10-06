import type { RunEvent } from '../types';
import { clock } from './primitives';

/** Operational events only — never model reasoning. */
export function ActivityFeed({
  events,
  showMission,
}: {
  events: RunEvent[];
  showMission?: boolean;
}): React.JSX.Element {
  if (events.length === 0) {
    return <p className="muted">Nothing yet.</p>;
  }

  return (
    <ol className="activity">
      {events.map((event) => (
        <li key={event.id} className={`activity__row activity__row--${event.type.split('.')[0]}`}>
          <time>{clock(event.at)}</time>
          <span className="activity__type">{event.type}</span>
          <span className="activity__message">
            {event.message}
            {showMission && (
              <span className="activity__mission"> · {event.missionId.slice(0, 12)}</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
