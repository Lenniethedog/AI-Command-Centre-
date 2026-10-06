import type { ReactNode } from 'react';

export function Pill({ status }: { status: string }): React.JSX.Element {
  return <span className={`pill pill--${status}`}>{status}</span>;
}

export function Confidence({ level }: { level: string }): React.JSX.Element {
  return <span className={`confidence confidence--${level}`}>{level} confidence</span>;
}

export function Fact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="fact">
      <span className="fact__label">{label}</span>
      <span className="fact__value">{children}</span>
    </div>
  );
}

/** A titled section of content. Spacing does the work, not borders. */
export function Block({
  label,
  actions,
  children,
}: {
  label?: string;
  actions?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <section className="block">
      {(label ?? actions) && (
        <header className="block__label">
          <span>{label}</span>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function EmptyState({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}): React.JSX.Element {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {hint && <p className="empty__hint">{hint}</p>}
    </div>
  );
}

export function clock(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
}

export function duration(from: string | null, to: string | null): string {
  if (!from || !to) return '—';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Timestamps in the mission list.
 *
 * Older entries carry the time as well as the date. Several runs of the same
 * objective on the same day are otherwise identical rows — same title, same
 * date, same status — with nothing to say which is which.
 */
export function relative(iso: string): string {
  const date = new Date(iso);
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
