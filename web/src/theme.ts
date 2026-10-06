import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'acc.theme';

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function read(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  // First visit lands on dark — the designed surface for a command plane.
  // Explicit "system" or "light" choices are still honoured once set.
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'dark';
}

/**
 * Applies the theme by attribute.
 *
 * `system` removes the attribute entirely rather than resolving it here, so the
 * stylesheet's `prefers-color-scheme` query stays in charge and the theme
 * follows the OS live — including when it changes while the app is open.
 */
function apply(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

export function useTheme(): {
  theme: Theme;
  resolved: 'light' | 'dark';
  setTheme: (next: Theme) => void;
  cycle: () => void;
} {
  const [theme, setThemeState] = useState<Theme>(() => read());
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark());

  useEffect(() => {
    apply(theme);
  }, [theme]);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  const resolved: 'light' | 'dark' =
    theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

  const cycle = useCallback(() => {
    setTheme(resolved === 'dark' ? 'light' : 'dark');
  }, [resolved, setTheme]);

  return { theme, resolved, setTheme, cycle };
}
