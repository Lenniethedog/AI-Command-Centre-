/**
 * Inline icons — no icon library, no network request, and they inherit
 * `currentColor` so they theme themselves.
 */

const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  viewBox: '0 0 24 24',
  'aria-hidden': true,
};

export const SidebarIcon = (): React.JSX.Element => (
  <svg {...base}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M9.5 4v16" />
  </svg>
);

export const PlusIcon = (): React.JSX.Element => (
  <svg {...base}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const SendIcon = (): React.JSX.Element => (
  <svg {...base} strokeWidth={2}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);

export const SunIcon = (): React.JSX.Element => (
  <svg {...base}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);

export const MoonIcon = (): React.JSX.Element => (
  <svg {...base}>
    <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
  </svg>
);

export const StopIcon = (): React.JSX.Element => (
  <svg {...base}>
    <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
  </svg>
);

export const TrashIcon = (): React.JSX.Element => (
  <svg {...base}>
    <path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>
);
