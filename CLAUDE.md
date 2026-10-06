# AI Command Centre

Guidance for Claude Code when working in this repository.

## What this project is

A personal Universal AI Command Centre: one interface that acts as the control
plane for the operator's digital environment. The operator states a high-level
objective; the system creates a mission, breaks it into tasks, selects agents
and models, executes, verifies, synthesises, and presents a recommendation.

It is **local-first**: inference runs on the operator's own machine at £0
ongoing cost, and paid cloud providers are optional adapters behind the same
contract.

[docs/vision.md](docs/vision.md) is the source of truth for scope,
[docs/architecture.md](docs/architecture.md) for design, and
[docs/roadmap.md](docs/roadmap.md) for sequencing.

## Project status

**Implemented and verified:** projects, mission planning, dependency-aware task
graph with bounded parallelism and retries, four agents (planner, analyst,
maker, synthesiser), grounded synthesis, operator-controlled memory, activity
log, permission-aware tool infrastructure, **agent-invoked tool use** over four
`read` tools (`workspace.read`, `wiki.search`, `web.search`, `web.fetch`) and
one `write` tool (`workspace.write`), **produced artifacts** written to the
sandboxed workspace and rendered in the interface, mission stop and delete,
usage reporting, an evaluation harness, and local-first inference at £0 across
three models in two families.

**Deliberately not built:** critics/verification, approvals, monitoring,
automation, external integrations, authentication. `consequential` tools stay
denied by the default policy until approvals exist.

**The maker was unreliable and is now measured working (2026-09-05).** It ran
at 55% — six of eleven tasks — while every other agent sat at 100%. Two causes,
both found by reproducing against the real model rather than reasoning about
the code:

1. **The research gate starved it.** `deferUntilLookupAttempted` withheld
   `workspace.write` until a lookup had been attempted. Once the planner began
   giving the research to an analyst, the maker arrived with the findings
   already in context and every offered tool saying "go and research". In that
   position qwen3:14b returns *nothing at all* — no text, no tool call — four
   times out of four, and the task died on `Local model returned an empty
   response` before any loop logic ran. The gate now lifts when upstream
   research is present: its purpose is to stop a model building on facts it
   invented, and an upstream task has already supplied them.
2. **Nothing required the file to be written.** Gathering ended the moment the
   model stopped calling tools, and phase two cannot emit a tool call, so the
   deliverable became unreachable and the model described a file it never
   wrote. `requireTool` refuses that ending, and when research eats every
   round, one final turn offers the write tool and nothing else.

Measured on the artifact eval, before → after: **0 of 6 missions produced a
file → 6 of 6**; coverage 50%/100% → 100% on every run; artifact scores 57–90%
(76% average on the latest pass), at comparable wall time. Overconfident runs
went from 1 to 0. Run `npm run eval -- --cases arsenal-badge` before and
after any change here.

A failed maker task still does not fail its mission — synthesis runs on partial
results by design — but the synthesiser is now told what died
(`ContextBundle.missing`) and rates its confidence accordingly.

**Known gap:** the tool loop tells the model when a lookup *failed*, but not
when one *succeeded and returned nothing relevant*. A search that comes back
empty-handed still lets the model answer from recall at unearned confidence.
Closing this properly is what critics (M6) are for.

`docs/roadmap.md` is the authority on what is complete, partial and planned.
Keep it accurate — a milestone marked done that isn't is worse than one marked
partial.

**Do not create placeholder or fake versions of unbuilt features.** An empty
dashboard or a stubbed critic is worse than its absence. If something is
partially built, say so in the interface as well as the docs.

## Architectural principles

These are load-bearing. Do not weaken them for convenience.

0. **Local-first, £0 by default.** The default model provider runs on this
   machine. Core orchestration must never require, import, or silently acquire
   a paid cloud provider. Cloud adapters are optional modules registered only
   when the operator has configured credentials. If a mission cannot complete
   without a cloud key, that is a defect. **Never add an API key, never suggest
   buying credits, and never make a paid API call.**
1. **Deterministic application code owns state.** An LLM never holds the state
   machine. Models are called at defined boundaries and return data.
2. **Model output is validated structured data.** Every model response is parsed
   and validated with Zod at the boundary. Unvalidated model output never
   reaches the store.
3. **Every state transition is persisted to SQLite**, together with an
   append-only event log entry, in the same transaction.
4. **The UI reads persisted state.** It holds no authoritative state of its own.
   A refresh must be indistinguishable from a live session.
5. **Core must not depend on edge implementations.** `src/core/**` may not
   import from `src/providers/**`, `src/agents/**`, `src/tools/**`, or
   `src/api/**`. Wiring happens only in `src/bootstrap.ts`.
6. **Four extension contracts:** `ModelProvider`, `Agent`, `Tool`, `Trigger`.
   New capability means a new edge module plus registration — never a core edit.
7. **Routing is capability-based**, never by provider or model name in core.
   Descriptors must declare *configured* capability, not a model's theoretical
   maximum — an inflated descriptor makes the router hand an agent a model that
   cannot do the job, silently.
8. **Critics must be independent of what they check**, via
   `mustDifferFromProvider` and `mustDifferFromModel` on the model requirement.
   Under local-first there is one provider, so `mustDifferFromModel` — a
   different local model *family* — is what actually delivers independence.
   (Used from M6; the constraints live in the router.)
9. **Tools declare `read` / `write` / `consequential` side effects**, and
   approval policy derives from that declaration rather than a maintained list.
   The default policy allows `read` and `write` and denies `consequential`.
   `write` is admitted on **containment, not trust**: the only write tool is
   confined to the workspace directory by the same lexical and `realpath`
   checks that guard reads, and nothing written there is ever executed. A new
   `write` tool without an equivalent boundary needs approvals (M10) first.

## Measuring before deciding

`npm run eval` scores real missions across a model/effort matrix. Use it before
changing a prompt, a default model, or a routing rule — model and effort choices
were previously made on single anecdotes, which is how a slower, narrower model
ends up as the default. Scoring is deterministic and rewards breadth, not
correctness; nothing verifies a claim is true until critics exist.

Cases come in two kinds. **Prose cases** score coverage of hand-written topic
lists against what the mission said. **Artifact cases** carry an `artifact`
block and are scored against the bytes on disk instead — a summary describing a
badge it failed to write scores zero, and a case that produced no file scores
zero outright rather than collecting marks for falsehoods it did not have the
chance to state. Adding a maker capability without an artifact case puts it
back on the anecdote footing this harness exists to replace.

## Technology

TypeScript · Node 22+ · SQLite (WAL) via `better-sqlite3` · plain SQL
migrations · Zod · Fastify · React · Vite · `fetch` for HTTP APIs · SSE for
server→client updates.

**Local inference: Ollama** on `127.0.0.1:11434`, reached with `fetch`. It is a
dependency of the *machine*, not of `package.json` — nothing in the codebase
imports it, and only one edge module talks to it. Default model: **Qwen3 14B**,
4-bit — chosen on eval results (95% vs 83% for the 8B), not on impressions.
Swapping in llama.cpp, LM Studio or MLX later means writing a different edge
module, not touching core.

**Local web search: SearXNG** at `127.0.0.1:8888`, installed from source into
its own venv at `~/.local/share/searxng` and started by `scripts/launch.sh`.
Like Ollama it is a dependency of the *machine*, not of `package.json`. It is
**optional**: absent, `SEARXNG_URL` is unset, the `web.search` tool is never
registered, and the system runs on Wikipedia alone. It must never become a
precondition for starting.

**Optional cloud SDKs:** `@anthropic-ai/sdk` (installed) and `openai` (not
installed). Both are optional adapters. Never make them required.

Python may be introduced later **only** behind a `Tool`/HTTP boundary for
specialised data analysis. It does not enter the core.

Adding a dependency requires a stated reason and a decision-log entry in
`docs/architecture.md`. **The local-first path must add no npm dependencies.**

## Cost and privacy posture

Default spend is **£0** and no operator data leaves the machine. Do not add an
API key, do not ask the operator to buy credits, and do not introduce a code
path that needs a paid provider to succeed.

## Security posture (v1)

Binds to `127.0.0.1` only. No public network exposure. No multi-user
authentication. This is a **deliberate temporary decision** that must be
revisited before any remote or networked deployment. API keys — only relevant
when an optional cloud provider is enabled — are read from the environment,
never written to the database or event log.

## Commands

```
npm run dev        API + UI in watch mode  (UI on 127.0.0.1:5173)
npm run dev:api    API only (127.0.0.1:8787)
npm run dev:web    UI only (127.0.0.1:5173, proxies /api)
npm test           Test suite (node:test + tsx, no API key needed)
npm run typecheck  tsc --noEmit for server and UI
npm run build      Compile server to dist/ and bundle UI
npm start          Run the compiled API (UI served separately by Vite)
npm run preview    Serve the built UI
```

## Conventions

- TypeScript strict mode; no `any` in core.
- Explicit `.js` extensions on relative imports (NodeNext resolution).
- SQL migrations are append-only — add a new numbered file, never edit an
  applied one.
- Prose uses British spelling ("Centre", "behaviour", "synthesise").

---

Last updated: 2026-09-05
