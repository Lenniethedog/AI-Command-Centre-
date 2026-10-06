# Development

## Running

```bash
npm install
brew services start ollama
ollama pull qwen3:8b
npm run dev
```

`npm run dev` starts the API on `127.0.0.1:8787` and the interface on
`127.0.0.1:5173`. No API key, no account, no spend.

| Command | What it does |
| --- | --- |
| `npm run dev` | API + interface, both in watch mode |
| `npm run dev:api` | API only |
| `npm run dev:web` | Interface only (proxies `/api` to the API) |
| `npm test` | Full suite — no model runtime or network needed |
| `npm run typecheck` | `tsc --noEmit` over server, tests and web |
| `npm run eval` | Score real missions across models and effort levels |
| `npm run build` | Compile the API and bundle the interface |
| `npm start` | Run the compiled API |

## How a mission runs

```
objective
   │
   ▼
[planner]  ── one model call ──► validated task graph
   │
   ▼
[scheduler] ── waves of runnable tasks, bounded concurrency
   │              each task: agent + routed model + permitted tools
   ▼
[synthesiser] ── one model call over completed findings
   │
   ▼
recommendation
```

Deterministic code owns every transition. Models are called at three defined
points and each returns schema-validated data. Every stage is a real task row,
so the whole pipeline is visible and timed.

## Adding things

**A model provider.** Implement `ModelProvider` in `src/providers/<name>/`,
register it in `src/bootstrap.ts`. Nothing in `src/core/**` may import it — a
test enforces this. Declare capabilities honestly: descriptors report the
context the runtime will actually serve, and reasoning tiers stay
cloud-anchored (`basic` = small local model, `strong` = large local or mid-tier
cloud, `frontier` = top-tier cloud).

**An agent.** Implement `Agent` in `src/agents/<name>/`, register it, and add it
to the planner's roster in `bootstrap.ts` if the planner should be able to
assign work to it. Use `completeStructured()` from `src/agents/shared.ts` so
output validation happens in one place.

**A tool.** Implement `Tool` in `src/tools/<name>/` with a Zod input schema and
an honest `sideEffect`. Register it in `bootstrap.ts`. Anything above `read` is
denied by the default policy until an approval mechanism exists.

**A schema change.** Add a new numbered file in `migrations/`. Never edit an
applied migration.

## Testing

`node:test`, no framework dependency. The suite runs without a model runtime:
`tests/stub-provider.ts` scripts replies per stage, and
`tests/local-provider.test.ts` stubs `fetch` to exercise the Ollama adapter.

`tests/boundaries.test.ts` is the architectural guard — it resolves every
relative import in `src/core/**` and fails if one lands outside core. That is
what keeps "add a provider without touching core" true rather than aspirational.

## Conventions

- TypeScript strict, `noUncheckedIndexedAccess` on. No `any` in core.
- Explicit `.js` extensions on relative imports (NodeNext resolution).
- British spelling in prose and identifiers (`synthesiser`, `behaviour`).
- Prefer the platform over a dependency. Every dependency needs a decision-log
  entry in `architecture.md`.

## Measuring changes

```bash
npm run eval -- --models qwen3:8b,qwen3:14b --efforts balanced
npm run eval -- --cases heat-pump-barriers --efforts balanced,careful
```

Each run is a real local mission, so a full matrix takes minutes and costs £0.
Scoring is deterministic: topic coverage against hand-written lists in
`evals/cases.json`, plus a calibration check that flags a run claiming high
confidence while missing most of the ground.

**Coverage rewards breadth, not correctness.** Nothing in the harness verifies
that a claim is true — that needs critics (M6). Treat it as a regression guard
for prompt and routing changes, not as a quality score.

## Known gaps

- **No linter configured.** TypeScript strict mode carries most of the load;
  ESLint would add genuine value and several dev dependencies.
- **Agents cannot call tools.** The machinery is built and tested; the tool-use
  loop is not.
- **No verification.** Findings are synthesised, not checked.
