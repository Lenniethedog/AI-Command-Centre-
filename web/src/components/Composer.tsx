import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { ComposerControls } from './ComposerControls';
import { SendIcon, StopIcon } from './icons';
import type { Settings } from '../types';

/**
 * The floating composer.
 *
 * The textarea grows with its content up to roughly six lines and then scrolls,
 * so short objectives get a compact bar and long ones stay fully visible
 * without the layout jumping.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  busy,
  running,
  onStop,
  settings,
  onSettingsChange,
  placeholder,
  contextLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  busy: boolean;
  /** A mission is in flight — the send control becomes a stop control. */
  running: boolean;
  onStop: () => void;
  settings: Settings | null;
  onSettingsChange: (next: { model?: string; effort?: string }) => void;
  placeholder: string;
  contextLabel: string;
}): React.JSX.Element {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const dock = useRef<HTMLDivElement>(null);

  /**
   * Size the box to its content.
   *
   * An empty composer is never measured, because there is nothing to measure —
   * it is one row, and the inline height comes off so the stylesheet decides.
   * Measuring it was the bug: `scrollHeight` counts the *placeholder*, and
   * before the stylesheet applied the box was near zero-width, so the
   * placeholder wrapped to one character per line and an empty input reported
   * 815px. `max-height` clipped that to 216px and an untouched composer's value
   * never changes, so nothing recomputed it — half the mission reading area
   * went to an empty text box. Reset to auto first so a box with real text can
   * shrink again when that text is deleted, not only grow.
   */
  const measure = useCallback(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.value.length > 0) el.style.height = `${el.scrollHeight}px`;

    // Publish the dock's resulting height in the same pass. The scrolling
    // column reserves exactly this much space beneath its content, and reading
    // it here — rather than only from an observer — means the reservation is
    // right on the first frame and after every keystroke, whether or not
    // anything is watching. A fixed reservation used to strand the tail of a
    // long result behind a composer that grows past 300px.
    const container = dock.current;
    if (container) {
      document.documentElement.style.setProperty('--dock-h', `${container.offsetHeight}px`);
    }
  }, []);

  useLayoutEffect(measure, [measure, value, running]);

  /**
   * Re-measure when the box's width changes, not only its content: a wrapped
   * objective needs a different height once the rail collapses or the window
   * resizes. Both used to leave it mismeasured until the next keystroke.
   */
  useEffect(() => {
    const el = textarea.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  // Nothing outside the composer should be left holding a dock height for a
  // composer that no longer exists.
  useEffect(() => {
    return () => {
      document.documentElement.style.removeProperty('--dock-h');
    };
  }, []);

  const canSend = value.trim().length > 0 && !busy;

  return (
    <div className="dock" ref={dock}>
      <div className="dock__inner">
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSend) onSubmit();
          }}
        >
          <label className="sr-only" htmlFor="command-input">
            Objective for {contextLabel}
          </label>
          <textarea
            id="command-input"
            ref={textarea}
            rows={1}
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (canSend) onSubmit();
              }
            }}
          />

          {running ? (
            <button
              type="button"
              className="composer__send composer__send--stop"
              onClick={onStop}
              aria-label="Stop the running mission"
              title="Stop"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="submit"
              className="composer__send"
              disabled={!canSend}
              aria-label={busy ? 'Submitting' : 'Start mission'}
            >
              <SendIcon />
            </button>
          )}

          <div className="composer__tools">
            {settings && (
              <ComposerControls
                settings={settings}
                onChange={onSettingsChange}
                disabled={busy}
              />
            )}
          </div>
        </form>

        <p className="dock__hint">
          {running
            ? 'Running locally — stop any time, completed steps are kept'
            : 'Instant by default · runs locally · £0 · ⏎ to start, ⇧⏎ for a new line'}
        </p>
      </div>
    </div>
  );
}
