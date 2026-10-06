import { useEffect, useRef, useState } from 'react';
import type { EffortProfile, ModelInfo, Settings } from '../types';

/**
 * Model and effort controls, sitting with the composer rather than buried in a
 * settings page — these are per-run decisions, so they belong where the run
 * starts.
 *
 * Each effort level states what it actually does and roughly how long it takes.
 * Levels a model cannot serve are disabled with the reason shown, so a setting
 * never silently does nothing.
 */
export function ComposerControls({
  settings,
  onChange,
  disabled,
}: {
  settings: Settings;
  onChange: (next: { model?: string; effort?: string }) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState<null | 'model' | 'effort'>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(null);
    };
    const escape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, []);

  const active: ModelInfo | undefined = settings.models.find((m) => m.model === settings.model);
  const canThink = settings.model === 'auto' ? settings.models.some((m) => m.thinking) : active?.thinking ?? false;
  const currentEffort =
    settings.effortProfiles.find((p) => p.id === settings.effort) ?? settings.effortProfiles[1];

  function pickEffort(profile: EffortProfile): void {
    if (profile.thinking && !canThink) return;
    onChange({ effort: profile.id });
    setOpen(null);
  }

  return (
    <div className="controls" ref={root}>
      {/* --- model ------------------------------------------------------- */}
      <div className="controls__group">
        <button
          type="button"
          className="chip"
          onClick={() => setOpen(open === 'model' ? null : 'model')}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open === 'model'}
        >
          <span className="chip__label">Model</span>
          <span className="chip__value">
            {settings.model === 'auto' ? 'Auto' : settings.model}
          </span>
          <span className="chip__caret" aria-hidden="true" />
        </button>

        {open === 'model' && (
          <div className="menu" role="listbox">
            <button
              type="button"
              className={`menu__item ${settings.model === 'auto' ? 'menu__item--on' : ''}`}
              onClick={() => {
                onChange({ model: 'auto' });
                setOpen(null);
              }}
              role="option"
              aria-selected={settings.model === 'auto'}
            >
              <span className="menu__title">Auto</span>
              <span className="menu__detail">
                Let the router pick by what each task needs
              </span>
            </button>

            {settings.models.map((model) => (
              <button
                key={`${model.provider}/${model.model}`}
                type="button"
                className={`menu__item ${settings.model === model.model ? 'menu__item--on' : ''}`}
                onClick={() => {
                  onChange({ model: model.model });
                  setOpen(null);
                }}
                role="option"
                aria-selected={settings.model === model.model}
              >
                <span className="menu__title">
                  {model.model}
                  <span className={`tag tag--${model.provider === 'local' ? 'free' : 'paid'}`}>
                    {model.provider === 'local' ? 'local · free' : model.provider}
                  </span>
                </span>
                <span className="menu__detail">
                  {model.contextTokens.toLocaleString('en-GB')} token context
                  {model.thinking ? ' · can reason' : ' · no reasoning pass'}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* --- effort ------------------------------------------------------ */}
      <div className="controls__group">
        <button
          type="button"
          className="chip"
          onClick={() => setOpen(open === 'effort' ? null : 'effort')}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open === 'effort'}
        >
          <span className="chip__label">Effort</span>
          <span className="chip__value">{currentEffort?.label ?? 'Balanced'}</span>
          <span className="chip__meter" aria-hidden="true">
            {settings.effortProfiles.map((p, i) => (
              <i
                key={p.id}
                className={
                  i <= settings.effortProfiles.findIndex((x) => x.id === settings.effort)
                    ? 'on'
                    : ''
                }
              />
            ))}
          </span>
          <span className="chip__caret" aria-hidden="true" />
        </button>

        {open === 'effort' && (
          <div className="menu menu--wide" role="listbox">
            {settings.effortProfiles.map((profile) => {
              const blocked = profile.thinking && !canThink;
              return (
                <button
                  key={profile.id}
                  type="button"
                  className={`menu__item ${settings.effort === profile.id ? 'menu__item--on' : ''}`}
                  onClick={() => pickEffort(profile)}
                  disabled={blocked}
                  role="option"
                  aria-selected={settings.effort === profile.id}
                >
                  <span className="menu__title">
                    {profile.label}
                    <span className="menu__time">{profile.typicalSeconds}</span>
                  </span>
                  <span className="menu__detail">
                    {blocked
                      ? `${settings.model} has no reasoning pass, so this would behave like Balanced`
                      : profile.description}
                  </span>
                </button>
              );
            })}
            <p className="menu__foot">
              Effort applies to every step of a mission and is recorded on it, so
              past runs keep the setting they used.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
