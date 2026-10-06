import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addMemory,
  cancelMission,
  deleteMission,
  getUsage,
  createProject,
  deleteMemory,
  getHealth,
  getMission,
  getSettings,
  listActivity,
  listMemory,
  listMissions,
  listProjects,
  pinMemory,
  saveSettings,
  submitMission,
  subscribeToEvents,
} from './api';
import { ActivityFeed } from './components/ActivityFeed';
import { Composer } from './components/Composer';
import { MissionPanel } from './components/MissionPanel';
import { UsageView } from './components/UsageView';
import { Block, EmptyState, Fact, Pill, relative } from './components/primitives';
import { BrandMark, MoonIcon, PlusIcon, SidebarIcon, SunIcon, TrashIcon } from './components/icons';
import { useTheme } from './theme';
import type {
  Health,
  UsageReport,
  MemoryEntry,
  Mission,
  MissionDetail,
  Project,
  RunEvent,
  Settings,
} from './types';

type View = 'command' | 'activity' | 'usage' | 'memory' | 'settings';

const TABS: { id: View; label: string }[] = [
  { id: 'command', label: 'Command' },
  { id: 'activity', label: 'Activity' },
  { id: 'usage', label: 'Usage' },
  { id: 'memory', label: 'Memory' },
  { id: 'settings', label: 'Settings' },
];

const PLACEHOLDER = 'What should the Command Centre work on?';

/** Timeline buckets, newest first. */
function groupByDay(missions: Mission[]): { label: string; items: Mission[] }[] {
  const startOfDay = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOfDay(new Date());
  const day = 86_400_000;

  const buckets: { label: string; items: Mission[] }[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Older', items: [] },
  ];

  for (const mission of missions) {
    const age = Math.round((today - startOfDay(new Date(mission.createdAt))) / day);
    const index = age <= 0 ? 0 : age === 1 ? 1 : age <= 7 ? 2 : 3;
    buckets[index]!.items.push(mission);
  }

  return buckets.filter((b) => b.items.length > 0);
}

export function App(): React.JSX.Element {
  const { resolved, cycle } = useTheme();

  const [view, setView] = useState<View>('command');
  const [railOpen, setRailOpen] = useState(true);
  const [health, setHealth] = useState<Health | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>('prj_general');
  const [missions, setMissions] = useState<Mission[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MissionDetail | null>(null);
  const [activity, setActivity] = useState<RunEvent[]>([]);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [objective, setObjective] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // The SSE handler registers once; refs keep it reading current state.
  const selectedRef = useRef<string | null>(null);
  const viewRef = useRef<View>('command');
  const projectRef = useRef(projectId);
  selectedRef.current = selectedId;
  viewRef.current = view;
  projectRef.current = projectId;

  const notify = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2600);
  }, []);

  const refreshMissions = useCallback((project: string) => {
    listMissions(project).then(setMissions).catch((e: Error) => setError(e.message));
  }, []);
  const refreshDetail = useCallback((id: string) => {
    getMission(id).then(setDetail).catch((e: Error) => setError(e.message));
  }, []);
  const refreshMemory = useCallback((project: string) => {
    listMemory(project).then(setMemory).catch(() => setMemory([]));
  }, []);

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth(null));
    getSettings().then(setSettings).catch(() => setSettings(null));
    listProjects().then(setProjects).catch(() => setProjects([]));

    // Every panel is a projection of persisted state; an event only says
    // "something committed, re-read it".
    return subscribeToEvents((event) => {
      refreshMissions(projectRef.current);
      if (event.missionId === selectedRef.current) refreshDetail(event.missionId);
      if (viewRef.current === 'activity') listActivity().then(setActivity).catch(() => undefined);
      if (event.type === 'mission.completed' || event.type === 'mission.failed') {
        getHealth().then(setHealth).catch(() => undefined);
      }
    });
  }, [refreshMissions, refreshDetail]);

  useEffect(() => {
    refreshMissions(projectId);
    refreshMemory(projectId);
    setSelectedId(null);
    setDetail(null);
  }, [projectId, refreshMissions, refreshMemory]);

  useEffect(() => {
    if (selectedId) refreshDetail(selectedId);
    else setDetail(null);
  }, [selectedId, refreshDetail]);

  useEffect(() => {
    if (view === 'activity') listActivity().then(setActivity).catch(() => undefined);
    if (view === 'usage') getUsage().then(setUsage).catch(() => setUsage(null));
    if (view === 'memory') refreshMemory(projectId);
  }, [view, projectId, refreshMemory]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'k') {
        e.preventDefault();
        setView('command');
        document.getElementById('command-input')?.focus();
      }
      if (e.key === 'b') {
        e.preventDefault();
        setRailOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function onSubmit(): Promise<void> {
    const text = objective.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const mission = await submitMission(text, projectId);
      setObjective('');
      setSelectedId(mission.id);
      setView('command');
      refreshMissions(projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSettingsChange(next: { model?: string; effort?: string }): Promise<void> {
    if (!settings) return;
    // Optimistic, then reconciled with the server so a rejected value cannot
    // linger in the interface.
    setSettings({ ...settings, ...next });
    try {
      const saved = await saveSettings(next);
      setSettings((current) => (current ? { ...current, ...saved } : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      getSettings().then(setSettings).catch(() => undefined);
    }
  }

  async function onStop(missionId: string): Promise<void> {
    try {
      await cancelMission(missionId);
      notify('Mission stopped');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onDelete(mission: Mission): Promise<void> {
    const summary =
      mission.objective.length > 60 ? `${mission.objective.slice(0, 60)}…` : mission.objective;
    if (!window.confirm(`Delete this mission?\n\n“${summary}”\n\nThis cannot be undone. Anything you kept in memory is preserved.`)) {
      return;
    }
    await deleteMission(mission.id);
    if (selectedId === mission.id) setSelectedId(null);
    refreshMissions(projectId);
    notify('Mission deleted');
  }

  async function onRemember(content: string): Promise<void> {
    await addMemory(content, projectId, selectedId ?? undefined);
    refreshMemory(projectId);
    notify('Kept in project memory');
  }

  async function onNewProject(): Promise<void> {
    const name = window.prompt('Project name');
    if (!name?.trim()) return;
    const brief = window.prompt('One-line brief (shared context for every mission)') ?? '';
    const project = await createProject(name.trim(), brief.trim(), 'blue');
    setProjects(await listProjects());
    setProjectId(project.id);
    notify(`Project “${project.name}” created`);
  }

  const activeProject = projects.find((p) => p.id === projectId);
  const ready = health?.inferenceReady ?? false;
  const activeMissionRunning =
    detail !== null && !['completed', 'failed', 'cancelled'].includes(detail.mission.status);

  return (
    <div className="shell">
      <aside className={`sidebar ${railOpen ? '' : 'sidebar--collapsed'}`}>
        <div className="sidebar__top">
          <div className="brand">
            <span className="brand__mark" aria-hidden="true">
              <BrandMark size={28} />
            </span>
            <span className="brand__text">
              <span className="brand__name">Command Centre</span>
              <span className="brand__tag">local · £0</span>
            </span>
          </div>
          <button
            type="button"
            className="iconbtn"
            onClick={() => setRailOpen(false)}
            aria-label="Collapse sidebar"
            title="Collapse sidebar (⌘B)"
          >
            <SidebarIcon />
          </button>
        </div>

        <div className="sidebar__scroll">
          <div className="sidebar__group">
            <h2 className="sidebar__label">
              Projects
              <button type="button" className="iconbtn" onClick={() => void onNewProject()} aria-label="New project">
                <PlusIcon />
              </button>
            </h2>
            <ul className="list">
              {projects.map((project) => (
                <li key={project.id}>
                  <button
                    type="button"
                    className={`row row--project ${project.id === projectId ? 'row--active' : ''}`}
                    onClick={() => setProjectId(project.id)}
                  >
                    <span className="dot-sm" />
                    {project.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {missions.length === 0 ? (
            <p className="sidebar__label">No missions in this project yet</p>
          ) : (
            groupByDay(missions).map((group) => (
              <div key={group.label} className="sidebar__group">
                <h2 className="sidebar__label">{group.label}</h2>
                <ul className="list">
                  {group.items.map((mission) => (
                    <li key={mission.id} className="row-wrap">
                      <button
                        type="button"
                        className={`row ${mission.id === selectedId ? 'row--active' : ''}`}
                        onClick={() => {
                          setView('command');
                          setSelectedId(mission.id);
                        }}
                      >
                        <span className="row__title">{mission.objective}</span>
                        <span className="row__meta">
                          <Pill status={mission.status} />
                          <time>{relative(mission.createdAt)}</time>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="row__delete"
                        onClick={() => void onDelete(mission)}
                        aria-label={`Delete mission: ${mission.objective.slice(0, 40)}`}
                        title="Delete mission"
                      >
                        <TrashIcon />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>

        <footer className="sidebar__foot">
          <span className={`dot ${ready ? 'dot--ok' : 'dot--warn'}`} aria-hidden="true" />
          <div className="engine__text">
            <strong>{ready ? 'Local engine ready' : 'Local engine offline'}</strong>
            <span>
              {health?.loaded && health.loaded.length > 0
                ? `${health.loaded[0]!.model} · ${health.loaded[0]!.sizeGb} GB resident`
                : 'loads on first use'}
            </span>
          </div>
        </footer>
      </aside>

      <main className="main">
        <header className="header">
          {!railOpen && (
            <button
              type="button"
              className="iconbtn"
              onClick={() => setRailOpen(true)}
              aria-label="Open sidebar"
              title="Open sidebar (⌘B)"
            >
              <SidebarIcon />
            </button>
          )}

          <nav className="header__nav" aria-label="Sections">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`tab ${view === tab.id ? 'tab--active' : ''}`}
                onClick={() => setView(tab.id)}
                aria-current={view === tab.id}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <div className="header__right">
            {health?.zeroCost && <span className="chipstat">£0 · local</span>}
            <button
              type="button"
              className="iconbtn"
              onClick={cycle}
              aria-label={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} theme`}
              title={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} theme`}
            >
              {resolved === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
          </div>
        </header>

        <div className="stream">
          <div className={`column ${view === 'settings' || view === 'usage' ? 'column--wide' : ''}`}>
            {!ready && health && (
              <div className="notice">
                <strong>Local inference is unavailable.</strong> Start the runtime with{' '}
                <code>brew services start ollama</code>, then pull a model with{' '}
                <code>ollama pull qwen3:8b</code>. No API key is needed.
              </div>
            )}

            {view === 'command' &&
              (detail ? (
                <MissionPanel detail={detail} onRemember={(c) => void onRemember(c)} />
              ) : (
                <div className="welcome">
                  <div className="welcome__beacon" aria-hidden="true">
                    <span className="welcome__ring" />
                    <BrandMark size={72} />
                  </div>
                  <p className="welcome__eyebrow">AI Command Centre</p>
                  <h1 className="welcome__title">
                    {activeProject && activeProject.id !== 'prj_general'
                      ? activeProject.name
                      : 'State an objective'}
                  </h1>
                  <p className="welcome__sub">
                    {(activeProject && activeProject.id !== 'prj_general'
                      ? activeProject.brief.trim()
                      : '') ||
                      'It becomes a mission — planned, run across agents, and synthesised into one recommendation. Entirely on this machine.'}
                  </p>
                  <div className="welcome__hints">
                    <span className="welcome__hint">⌘K focus</span>
                    <span className="welcome__hint">⌘B rail</span>
                    <span className="welcome__hint">local inference</span>
                    <span className="welcome__hint">artifacts on disk</span>
                  </div>
                </div>
              ))}

            {view === 'activity' && (
              <Block label="Activity across all missions">
                <ActivityFeed events={activity} showMission />
              </Block>
            )}

            {view === 'usage' && usage && <UsageView usage={usage} />}

            {view === 'memory' && (
              <Block label={`Memory — ${activeProject?.name ?? 'General'}`}>
                <p className="muted">
                  Nothing is remembered automatically. Findings appear here only when you keep
                  them, and are given to agents working in this project.
                </p>
                {memory.length === 0 ? (
                  <EmptyState
                    title="No memory kept yet"
                    hint="Use “remember” on a recommendation’s key points."
                  />
                ) : (
                  <ul className="memory">
                    {memory.map((entry) => (
                      <li key={entry.id} className={entry.pinned ? 'memory--pinned' : ''}>
                        <span>{entry.content}</span>
                        <span className="memory__actions">
                          <button
                            type="button"
                            className="link"
                            onClick={() =>
                              void pinMemory(entry.id, !entry.pinned).then(() => refreshMemory(projectId))
                            }
                          >
                            {entry.pinned ? 'unpin' : 'pin'}
                          </button>
                          <button
                            type="button"
                            className="link link--danger"
                            onClick={() => void deleteMemory(entry.id).then(() => refreshMemory(projectId))}
                          >
                            forget
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Block>
            )}

            {view === 'settings' && health && (
              <>
                <Block label="Runtime">
                  <div className="facts">
                    <Fact label="Version">{health.version ?? '0.1.0'}</Fact>
                    <Fact label="Uptime">
                      {typeof health.uptimeSeconds === 'number'
                        ? health.uptimeSeconds < 60
                          ? `${health.uptimeSeconds}s`
                          : `${Math.floor(health.uptimeSeconds / 60)}m`
                        : '—'}
                    </Fact>
                    <Fact label="Concurrency">{health.concurrency}</Fact>
                    <Fact label="Context">{health.contextTokens.toLocaleString('en-GB')} tok</Fact>
                  </div>
                </Block>

                <Block label="Providers">
                  <ul className="statuses">
                    {health.providers.map((provider) => (
                      <li key={provider.id}>
                        <span className={`dot ${provider.available ? 'dot--ok' : 'dot--idle'}`} />
                        <strong>{provider.id}</strong>
                        <span className={`badge ${provider.paid ? 'badge--paid' : 'badge--free'}`}>
                          {provider.paid ? 'paid' : 'free'}
                        </span>
                        <span className="muted">{provider.detail}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="muted">
                    Cloud providers are optional. With none configured the Command Centre runs
                    entirely on local models at £0 and nothing leaves this machine.
                  </p>
                </Block>

                <Block label="Models available">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Model</th>
                        <th>Reasoning</th>
                        <th>Context</th>
                        <th>Reasoning pass</th>
                      </tr>
                    </thead>
                    <tbody>
                      {health.models.map((model) => (
                        <tr key={`${model.provider}/${model.model}`}>
                          <td>{model.model}</td>
                          <td>{model.reasoning}</td>
                          <td>{model.contextTokens.toLocaleString('en-GB')}</td>
                          <td>{model.thinking ? 'yes' : 'no'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Block>

                <Block label="Agents">
                  <ul className="statuses">
                    {health.agents.map((agent) => (
                      <li key={agent.id}>
                        <strong>{agent.id}</strong>
                        <span className="muted">{agent.purpose}</span>
                      </li>
                    ))}
                  </ul>
                </Block>

                <Block label="Tools">
                  <ul className="statuses">
                    {health.tools.map((tool) => (
                      <li key={tool.id}>
                        <strong>{tool.id}</strong>
                        <span className={`badge badge--${tool.sideEffect}`}>{tool.sideEffect}</span>
                        <span className="muted">{tool.description}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="muted">
                    Agents invoke tools through a gather-then-answer loop. <code>read</code> and
                    sandboxed <code>write</code> tools are allowed; <code>consequential</code> tools
                    stay denied until approvals exist.
                  </p>
                </Block>
              </>
            )}

            {error && <p className="error">{error}</p>}
          </div>
        </div>

        {view === 'command' && (
          <Composer
            value={objective}
            onChange={setObjective}
            onSubmit={() => void onSubmit()}
            busy={busy}
            running={activeMissionRunning}
            onStop={() => selectedId && void onStop(selectedId)}
            settings={settings}
            onSettingsChange={(next) => void onSettingsChange(next)}
            placeholder={PLACEHOLDER}
            contextLabel={activeProject?.name ?? 'General'}
          />
        )}
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
