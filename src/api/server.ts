import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { resolveWithinWorkspace } from '../tools/workspace-read/index.js';

/** Only formats the workspace can hold, so nothing is guessed from bytes. */
const CONTENT_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};
import { z } from 'zod';
import { EFFORT_PROFILES } from '../core/domain/contracts.js';
import type { App } from '../bootstrap.js';

const SubmitBody = z.object({
  objective: z.string().trim().min(1, 'An objective is required').max(4000),
  projectId: z.string().trim().min(1).optional(),
});

const ProjectBody = z.object({
  name: z.string().trim().min(1, 'A project name is required').max(120),
  brief: z.string().trim().max(4000).default(''),
  accent: z.enum(['blue', 'violet', 'emerald', 'amber', 'rose', 'slate']).default('blue'),
});

const MemoryBody = z.object({
  content: z.string().trim().min(1, 'Memory content is required').max(2000),
  projectId: z.string().trim().min(1).optional(),
  sourceMissionId: z.string().trim().min(1).optional(),
});

const SettingsBody = z.object({
  model: z.string().trim().min(1).optional(),
  effort: z.enum(['instant', 'balanced', 'careful', 'deep']).optional(),
});

const HEARTBEAT_MS = 25_000;
const STARTED_AT = new Date().toISOString();
const STARTED_MS = Date.now();

interface LoadedModel {
  model: string;
  sizeGb: string;
}

/** Asks the local runtime which models are resident right now. */
async function loadedModels(baseUrl: string): Promise<LoadedModel[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${baseUrl}/api/ps`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return [];
    const body = (await response.json()) as { models?: { name?: string; size?: number }[] };
    return (body.models ?? []).map((m) => ({
      model: m.name ?? 'unknown',
      sizeGb: ((m.size ?? 0) / 1e9).toFixed(1),
    }));
  } catch {
    return [];
  }
}

/** The allowed models, with the capabilities the runtime actually reports. */
function routableWithCapabilities(app: App): unknown[] {
  return app.routableModels.flatMap((entry) => {
    const provider = app.registry.listProviders().find((p) => p.id === entry.provider);
    const descriptor = provider?.models.find((m) => m.id === entry.model);
    return descriptor
      ? [{ provider: entry.provider, model: entry.model, ...descriptor.capabilities }]
      : [];
  });
}

/** Keeps internals out of client-facing errors while preserving the cause. */
function fail(reply: import('fastify').FastifyReply, status: number, message: string): unknown {
  return reply.code(status).send({ error: message });
}

export function createServer(app: App): FastifyInstance {
  const server = Fastify({ logger: false });

  server.setErrorHandler((error: unknown, _request, reply) => {
    // Log server-side; return something that leaks no internals.
    const err = error as { message?: string; statusCode?: number };
    console.error('[api]', err.message ?? String(error));
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    void reply.code(status).send({
      error:
        status >= 500 ? 'Internal error. Check the server log.' : err.message ?? 'Request failed',
    });
  });

  // Bound to loopback in v1, but still refuse to be casually framed or sniffed.
  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', reply.getHeader('Cache-Control') ?? 'no-store');
    return payload;
  });

  // --- status ---------------------------------------------------------------

  server.get('/api/health', async () => {
    // What the runtime currently holds in memory. Best-effort: an unreachable
    // runtime reports nothing rather than failing the whole health check.
    const loaded = await loadedModels(app.config.local.baseUrl);
    const anyAvailable = app.providerStatus.some((p) => p.available);
    const paidEnabled = app.providerStatus.some((p) => p.paid && p.available);

    return {
      ok: true,
      // Never exposes credentials — only whether an adapter is registered.
      providers: app.providerStatus,
      models: routableWithCapabilities(app),
      enabledModels: app.config.enabledModels,
      agents: app.registry.listAgents().map((a) => ({ id: a.id, purpose: a.purpose })),
      tools: app.tools.list(),
      // Ready only when at least one provider can actually serve a model —
      // registration alone used to flip this true while Ollama was offline.
      inferenceReady: anyAvailable,
      /** True when nothing metered is in play. The default state. */
      zeroCost: !paidEnabled,
      usage: app.store.usageTotals(),
      concurrency: app.config.maxConcurrentTasks,
      contextTokens: app.config.local.contextTokens,
      loaded,
      startedAt: STARTED_AT,
      uptimeSeconds: Math.floor((Date.now() - STARTED_MS) / 1000),
      version: '0.1.0',
    };
  });

  // --- preferences ----------------------------------------------------------

  server.get('/api/settings', async () => {
    const prefs = app.store.getPreferences();
    return {
      ...prefs,
      models: routableWithCapabilities(app),
      // Sent so the interface can explain what each level does and disable the
      // ones the chosen model cannot serve, rather than offering dead settings.
      effortProfiles: EFFORT_PROFILES,
    };
  });

  server.put('/api/settings', async (request, reply) => {
    const parsed = SettingsBody.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message ?? 'Invalid');

    if (parsed.data.model && parsed.data.model !== 'auto') {
      const allowed = app.routableModels.some((m) => m.model === parsed.data.model);
      if (!allowed) {
        return fail(reply, 400, `Model "${parsed.data.model}" is not in the allowed set`);
      }
    }

    if (parsed.data.model !== undefined) app.store.setSetting('model', parsed.data.model);
    if (parsed.data.effort !== undefined) app.store.setSetting('effort', parsed.data.effort);
    return app.store.getPreferences();
  });

  // --- projects -------------------------------------------------------------

  server.get('/api/projects', async () => ({ projects: app.store.listProjects() }));

  server.post('/api/projects', async (request, reply) => {
    const parsed = ProjectBody.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message ?? 'Invalid');
    const project = app.store.createProject(
      parsed.data.name,
      parsed.data.brief,
      parsed.data.accent,
    );
    return reply.code(201).send({ project });
  });

  server.patch<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const parsed = ProjectBody.partial().safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message ?? 'Invalid');
    if (!app.store.getProject(request.params.id)) return fail(reply, 404, 'Project not found');
    app.store.updateProject(request.params.id, parsed.data);
    return { project: app.store.getProject(request.params.id) };
  });

  // --- missions -------------------------------------------------------------

  server.post('/api/missions', async (request, reply) => {
    const parsed = SubmitBody.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message ?? 'Invalid');

    if (!app.providerStatus.some((p) => p.available)) {
      return fail(
        reply,
        503,
        'No model provider is available. Start the local runtime with: brew services start ollama',
      );
    }

    // Objectives enter through the Trigger contract, exactly as a scheduled
    // automation will.
    const mission = await app.manualTrigger.fire({
      objective: parsed.data.objective,
      ...(parsed.data.projectId ? { projectId: parsed.data.projectId } : {}),
    });
    return reply.code(201).send({ mission });
  });

  server.get<{ Querystring: { projectId?: string } }>('/api/missions', async (request) => ({
    missions: app.store.listMissions(request.query.projectId),
  }));

  server.get<{ Params: { id: string } }>('/api/missions/:id', async (request, reply) => {
    const detail = app.store.getMissionDetail(request.params.id);
    if (!detail) return fail(reply, 404, 'Mission not found');
    return detail;
  });

  server.post<{ Params: { id: string } }>('/api/missions/:id/cancel', async (request, reply) => {
    const stopped = app.orchestrator.cancel(request.params.id);
    if (!stopped) return fail(reply, 409, 'That mission has already finished');
    return { ok: true, mission: app.store.getMission(request.params.id) };
  });

  server.delete<{ Params: { id: string } }>('/api/missions/:id', async (request, reply) => {
    // Stop it first: deleting a running mission would leave work in flight
    // writing to rows that no longer exist.
    app.orchestrator.cancel(request.params.id);
    const removed = app.store.deleteMission(request.params.id);
    if (!removed) return fail(reply, 404, 'Mission not found');
    return { ok: true };
  });

  // --- artifacts ------------------------------------------------------------
  // Files the maker produced. Served so the interface can show the actual
  // thing rather than a path to it — a mission that delivers a badge should
  // display the badge.
  //
  // This is the one place a caller-supplied path reaches the filesystem over
  // HTTP, so it reuses the same resolver the tools use: lexical containment
  // plus a realpath check, which together stop `../` and symlink escapes.
  server.get<{ Querystring: { path?: string } }>('/api/artifacts', async (request, reply) => {
    const requested = request.query.path;
    if (!requested) return fail(reply, 400, 'A path is required');

    const root = app.config.workspaceRoot;
    let resolved: string;
    try {
      resolved = await resolveWithinWorkspace(root, requested);
    } catch {
      return fail(reply, 403, 'That path is outside the workspace');
    }

    const content = await readFile(resolved, 'utf8').catch(() => null);
    if (content === null) return fail(reply, 404, 'No such artifact');

    const type = CONTENT_TYPES[extname(resolved).toLowerCase()] ?? 'text/plain; charset=utf-8';
    // Inline SVG is script-capable, and this one was written by a model. The
    // sandbox and a restrictive CSP mean the browser renders the drawing
    // without granting it the page's origin.
    reply.header('Content-Type', type);
    reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    reply.header('X-Content-Type-Options', 'nosniff');
    return content;
  });

  // --- memory ---------------------------------------------------------------
  // Nothing is remembered automatically: the operator promotes a finding.

  server.get<{ Querystring: { projectId?: string } }>('/api/memory', async (request) => ({
    memory: app.store.listMemory(request.query.projectId),
  }));

  server.post('/api/memory', async (request, reply) => {
    const parsed = MemoryBody.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message ?? 'Invalid');
    const entry = app.store.addMemory(
      parsed.data.projectId ?? null,
      parsed.data.content,
      parsed.data.sourceMissionId ?? null,
    );
    return reply.code(201).send({ entry });
  });

  server.patch<{ Params: { id: string }; Body: { pinned?: boolean } }>(
    '/api/memory/:id',
    async (request, reply) => {
      if (!app.store.getMemory(request.params.id)) return fail(reply, 404, 'Memory entry not found');
      app.store.setMemoryPinned(request.params.id, request.body?.pinned === true);
      return { ok: true };
    },
  );

  server.delete<{ Params: { id: string } }>('/api/memory/:id', async (request, reply) => {
    if (!app.store.getMemory(request.params.id)) return fail(reply, 404, 'Memory entry not found');
    app.store.deleteMemory(request.params.id);
    return { ok: true };
  });

  // --- activity -------------------------------------------------------------

  server.get('/api/usage', async () => app.store.usageReport());

  server.get('/api/activity', async () => ({ events: app.store.recentEvents(200) }));

  /**
   * Live activity. Server → client only, so SSE rather than WebSockets.
   * The stream carries committed events; the UI still reads state from the
   * store, so a refresh is indistinguishable from a live session.
   */
  server.get('/api/stream', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('retry: 2000\n\n');

    const unsubscribe = app.bus.subscribe((event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), HEARTBEAT_MS);

    const close = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.on('close', close);
    request.raw.on('error', close);
  });

  return server;
}
