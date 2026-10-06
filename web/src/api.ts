import type {
  Health,
  Settings,
  UsageReport,
  MemoryEntry,
  Mission,
  MissionDetail,
  Project,
  RunEvent,
} from './types';

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const getHealth = async (): Promise<Health> => json<Health>(await fetch('/api/health'));

export const listProjects = async (): Promise<Project[]> =>
  (await json<{ projects: Project[] }>(await fetch('/api/projects'))).projects;

export const createProject = async (
  name: string,
  brief: string,
  accent: string,
): Promise<Project> =>
  (await json<{ project: Project }>(await post('/api/projects', { name, brief, accent }))).project;

export const listMissions = async (projectId?: string): Promise<Mission[]> => {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return (await json<{ missions: Mission[] }>(await fetch(`/api/missions${query}`))).missions;
};

export const getMission = async (id: string): Promise<MissionDetail> =>
  json<MissionDetail>(await fetch(`/api/missions/${id}`));

export const submitMission = async (objective: string, projectId?: string): Promise<Mission> =>
  (await json<{ mission: Mission }>(await post('/api/missions', { objective, projectId }))).mission;

export const listActivity = async (): Promise<RunEvent[]> =>
  (await json<{ events: RunEvent[] }>(await fetch('/api/activity'))).events;

export const listMemory = async (projectId?: string): Promise<MemoryEntry[]> => {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return (await json<{ memory: MemoryEntry[] }>(await fetch(`/api/memory${query}`))).memory;
};

export const addMemory = async (
  content: string,
  projectId?: string,
  sourceMissionId?: string,
): Promise<MemoryEntry> =>
  (
    await json<{ entry: MemoryEntry }>(
      await post('/api/memory', { content, projectId, sourceMissionId }),
    )
  ).entry;

export const deleteMemory = async (id: string): Promise<void> => {
  await fetch(`/api/memory/${id}`, { method: 'DELETE' });
};

export const pinMemory = async (id: string, pinned: boolean): Promise<void> => {
  await fetch(`/api/memory/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
};

/** Live activity stream. Returns an unsubscribe function. */
export function subscribeToEvents(onEvent: (event: RunEvent) => void): () => void {
  const source = new EventSource('/api/stream');
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as RunEvent);
    } catch {
      // Ignore malformed frames; the store remains the source of truth.
    }
  };
  return () => source.close();
}

export const getSettings = async (): Promise<Settings> =>
  json<Settings>(await fetch('/api/settings'));

export const saveSettings = async (next: {
  model?: string;
  effort?: string;
}): Promise<{ model: string; effort: string }> =>
  json<{ model: string; effort: string }>(
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    }),
  );

export const getUsage = async (): Promise<UsageReport> =>
  json<UsageReport>(await fetch('/api/usage'));

export const cancelMission = async (id: string): Promise<void> => {
  await json<{ ok: boolean }>(await post(`/api/missions/${id}/cancel`, {}));
};

export const deleteMission = async (id: string): Promise<void> => {
  await json<{ ok: boolean }>(await fetch(`/api/missions/${id}`, { method: 'DELETE' }));
};
