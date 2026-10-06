# AI Command Centre

A personal control plane for AI work. State a high-level objective; the system
creates a mission, breaks it into tasks, assigns agents, selects models,
executes, and reports back — with every step persisted and visible.

**Local-first and free to run.** Inference happens on your own machine using
open-weight models, so ongoing cost is **£0** and your research never leaves the
computer. Cloud providers are optional adapters you can switch on later; the
system never requires one.

## What it does today

You state an objective. The system:

1. Creates a **mission** inside a **project**.
2. A **planner** agent decomposes it into a small task graph.
3. The **scheduler** runs those tasks — in parallel where they are independent,
   in order where they are not.
4. Each task is handled by an **agent**, on a **model** the router picks by
   declared capability, returning Zod-validated structured output. Agents call
   **tools** as they work — Wikipedia, web search, the workspace — and a
   **maker** agent writes real files rather than describing them.
5. A **synthesiser** combines the completed findings into a recommendation with
   confidence, key points and uncertainties, alongside any **artifacts**
   produced.
6. Every state transition is persisted to SQLite and streamed live to the
   interface.
7. You keep what is worth keeping in **project memory**, which is fed back into
   later missions.

A real run looks like: *plan (5s) → three analysts (9–20s, two concurrent) →
synthesis (9s)*, about 40 seconds and 3,600 tokens end to end on an 8B local
model, for £0.

### Honestly not built yet

- **Nothing is verified.** The synthesiser combines findings; it does not check
  them. Independent critics are a later milestone, and the interface says so.
  Relatedly, a lookup that succeeds but finds nothing relevant still lets the
  model answer from recall at unearned confidence.
- **No approvals.** `read` and `write` tools run without asking. `write` is
  admitted only because the one write tool cannot escape the workspace
  directory; `consequential` tools — sending, publishing, spending — are
  refused outright until the approval machinery exists.
- **Missions do not resume.** Kill the process mid-run and the mission is
  marked failed; its completed work is not reused.

See [docs/roadmap.md](docs/roadmap.md) for exactly what is complete, partial and
planned.

## Requirements

- Node 22 or newer
- [Ollama](https://ollama.com) — the local model runtime
- Roughly 6 GB of disk for the default model
- **No API key. No account. No spend.**

## Setup

```bash
npm install
```

Install the local runtime and pull the default model (see
[docs/architecture.md](docs/architecture.md) for why Ollama and why this model):

```bash
brew install ollama
```

```bash
ollama serve
```

```bash
ollama pull qwen3:8b
```

That is the whole setup. There is nothing to configure and nothing to pay for.

### Optional: enabling a cloud provider

Cloud models are **never required**. If you later want one for a specific kind
of work, copy `.env.example` to `.env` and set a key:

```bash
cp .env.example .env
```

The relevant adapter is then registered at startup and becomes available to the
router; with no key set, it simply is not registered and the system runs
entirely locally. Keys are read from the environment, never written to the
database, and redacted at the store boundary so they cannot reach the event log.

## Run

**From the desktop.** Double-click **AI Command Centre** on your Desktop. It
starts the model runtime if it is not already up, starts the API and interface,
and opens the browser. Running it again reuses whatever is already running
rather than starting duplicates.

To rebuild the shortcut after moving the project:

```bash
npm run make-launcher
```

**From the terminal.**

```bash
npm run dev
```

Open <http://127.0.0.1:5173>.

For a compiled run:

```bash
npm run build && npm start
```

That starts the API from `dist/`. The interface is served separately by Vite
(`npm run dev:web`, or `npm run preview` after a build) — M1 has no static-file
serving, because it needs none.

## Test

```bash
npm test
```

The suite exercises the full orchestration pipeline against a stub model
provider, so it runs without a model runtime, without an API key and without
network access.

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/vision.md](docs/vision.md) | The problem, the operating model, goals and non-goals |
| [docs/architecture.md](docs/architecture.md) | System design, extension contracts, decision log |
| [docs/roadmap.md](docs/roadmap.md) | 14 milestones across 6 phases |
| [CLAUDE.md](CLAUDE.md) | Working agreements and principles for Claude Code |

## Project layout

```
.
├── CLAUDE.md
├── README.md
├── config/                 model + routing configuration
├── docs/
│   ├── vision.md
│   ├── architecture.md
│   └── roadmap.md
├── migrations/             plain SQL, applied in order
├── src/
│   ├── core/               domain · store · registry · routing · orchestrator
│   │                       · scheduler · context · tools (permissions)
│   ├── providers/          local (default) · anthropic (optional)
│   ├── agents/             planner · analyst · maker · synthesiser
│   ├── tools/              workspace-read · workspace-write (sandboxed)
│   │                       wiki-search · web-search · web-fetch
│   ├── triggers/           manual
│   ├── api/                fastify routes + SSE
│   └── bootstrap.ts        the only place edge modules are wired to core
├── tests/
├── web/                    react + vite interface
└── workspace/              the only directory tools may read or write
```

## Cost and privacy

**Default spend is £0 and default data egress is none.** Inference runs locally,
so no request leaves the machine and nothing is metered. A paid provider becomes
involved only when you set a key for one — and if the system ever cannot
complete a mission without a cloud provider, that is a defect, not a
configuration step.

## Security posture

v1 binds to `127.0.0.1` only, with no public network exposure and no
multi-user authentication. This is a deliberate temporary decision for a
single-operator local tool, recorded in
[docs/architecture.md](docs/architecture.md#security-and-secrets), and **must be
revisited before any remote or networked deployment**.

## Licence

TBD.
