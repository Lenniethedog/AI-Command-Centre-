# Architecture

> **Status: proposed, v1.** This document describes the intended technical
> architecture for the first version of AI Command Centre. It is a design, not a
> record of what exists — no application code has been written. Choices are
> recorded with reasoning in the [decision log](#decision-log) at the end.
>
> Scope is set by [vision.md](vision.md); sequencing by [roadmap.md](roadmap.md).

## Contents

1. [Guiding principles](#guiding-principles)
2. [System overview](#system-overview)
3. [Layering and dependency rule](#layering-and-dependency-rule)
4. [The four extension points](#the-four-extension-points)
5. [Domain model](#domain-model)
6. [Mission lifecycle](#mission-lifecycle)
7. [Orchestrator](#orchestrator)
8. [Model routing](#model-routing)
9. [Tools and side effects](#tools-and-side-effects)
10. [Approval](#approval)
11. [Project context and memory](#project-context-and-memory)
12. [Activity logging and observability](#activity-logging-and-observability)
13. [Failure handling and resumability](#failure-handling-and-resumability)
14. [Automation (designed for, not built)](#automation-designed-for-not-built)
15. [Interface and transport](#interface-and-transport)
16. [Technology choices](#technology-choices)
17. [Security and secrets](#security-and-secrets)
18. [Repository layout](#repository-layout)
19. [Explicitly not in v1](#explicitly-not-in-v1)
20. [Decision log](#decision-log)

---

## Guiding principles

These constrain every decision below.

1. **The model plans; the runtime executes.** Model calls return validated
   structured data that deterministic code acts on. An LLM never holds the state
   machine. This is what makes the system debuggable, resumable, and observable.
2. **Observability is the data model.** Every state transition is written to a
   durable store. The interface only ever reads that store. Live view, history,
   cost tracking, crash recovery, and debugging all fall out of this one choice.
3. **Dependencies point inward.** The core knows nothing about Anthropic,
   OpenAI, or any specific tool. Providers, agents, and tools are edge modules
   that implement core-defined contracts.
4. **Capability-based selection, never names.** Core code asks for "a strong
   reasoning model," not for a named model from a named vendor.
5. **Local-first, £0 by default.** The default model provider runs on the
   operator's own machine. Core orchestration must never require a paid cloud
   provider, must never import one, and must never acquire one as a hidden
   dependency. A mission that cannot complete without a cloud key is a defect,
   not a configuration issue.
6. **Declared side effects.** Every tool declares what it can do to the world.
   Approval policy derives from that declaration rather than a hand-maintained
   list.
7. **Clean seams, not a plugin SDK.** Extensibility in v1 means four stable
   contracts and a registry — not a generic plugin framework. The framework gets
   extracted when a third integration makes it necessary, not before.
8. **Boring, low-dependency choices.** Each dependency needs a stated reason.

---

## System overview

```
                        ┌──────────────────────────┐
      operator ────────►│   Web interface (SPA)    │
                        │  missions · approvals    │
                        └────────┬────────▲────────┘
                            HTTP │        │ SSE (live events)
                        ┌────────▼────────┴────────┐
                        │        API layer         │
                        └────────┬────────▲────────┘
                                 │        │
        ┌────────────────────────▼────────┴──────────────────────┐
        │                     CORE                               │
        │                                                        │
        │   Orchestrator     Registry      Store      Context    │
        │   ┌───────────┐   ┌─────────┐  ┌────────┐  ┌────────┐  │
        │   │ planner   │   │ models  │  │ state  │  │ project│  │
        │   │ scheduler │   │ agents  │  │ events │  │ memory │  │
        │   │ executor  │   │ tools   │  │ costs  │  │ bundle │  │
        │   │ verifier  │   │triggers │  └────────┘  └────────┘  │
        │   │synthesiser│   └─────────┘                          │
        │   └───────────┘   Router   Approval queue              │
        └───────▲──────────────▲──────────────▲─────────────────┘
                │              │              │
        implements contracts defined by core (edge modules)
                │              │              │
        ┌───────┴─────┐ ┌──────┴──────┐ ┌─────┴───────┐
        │  Providers  │ │   Agents    │ │    Tools    │
        │  local  ◄── │ │  researcher │ │ web-search  │
        │  anthropic? │ │             │ │ fetch-page  │
        │  openai?    │ │             │ │             │
        └─────────────┘ └─────────────┘ └─────────────┘
                │                              │
     local runtime (default)            external services
     cloud APIs (opt-in only)
```

`◄──` marks the default provider. `?` marks optional adapters, registered only
when the operator has configured credentials for them.

**One process in v1.** The API, orchestrator, and workers run in a single Node
process against a local SQLite database. The orchestrator is written as a
module with no HTTP dependencies so it can be split into its own process later
without touching its logic.

---

## Layering and dependency rule

```
  web/          →  api/  →  core/  ←  providers/
                                   ←  agents/
                                   ←  tools/
```

**The rule:** `core/` must not import from `providers/`, `agents/`, `tools/`,
`api/`, or `web/`. Edge modules import core contracts; core discovers them only
through the registry at startup.

This is the mechanism behind "add a provider without rewriting the core." It
should be enforced by a lint rule (an import-boundary check), not by discipline
alone — an accidental import of a provider SDK inside `core/` is the single
most likely way this architecture rots.

---

## The four extension points

Everything extensible in the system goes through one of four contracts. New
capability means writing an edge module that implements one of these and
registering it. No core change.

### 1. ModelProvider

Wraps one source of model inference — local or remote. Declares what its models
can do.

```
ModelProvider                     (contract, defined in core)
├── LocalProvider                 default · runs on this machine · £0
├── AnthropicProvider             optional · requires ANTHROPIC_API_KEY
├── OpenAIProvider                optional · requires OPENAI_API_KEY
└── future providers              same contract, no core change
```

**LocalProvider is the default and the only one the system requires.** The
cloud adapters are registered at bootstrap only when their credentials are
present; with no keys configured, the Command Centre is fully operational and
spends nothing. Core cannot tell the difference between them — it resolves a
capability requirement and receives a bound model.

```ts
interface ModelProvider {
  id: string;                             // "anthropic"
  models: ModelDescriptor[];              // declared capabilities + pricing
  complete(req: ModelRequest): Promise<ModelResponse>;
}

interface ModelDescriptor {
  id: string;                             // provider-specific model id
  capabilities: {
    reasoning: "basic" | "strong" | "frontier";
    contextTokens: number;
    structuredOutput: boolean;
    vision: boolean;
  };
  cost: { inputPerMTok: number; outputPerMTok: number };
}
```

`ModelResponse` always carries token counts and latency so cost accounting is
automatic rather than opt-in.

### 2. Agent

A specialised worker. Declares what it needs; the runtime supplies it.

```ts
interface Agent {
  id: string;                             // "researcher"
  purpose: string;                        // used by the planner to select it
  modelRequirement: ModelRequirement;     // capabilities, not model names
  tools: string[];                        // tool ids it may use
  run(task: Task, ctx: AgentContext): Promise<TaskResult>;
}
```

`AgentContext` provides the resolved model client, permitted tools, the project
context bundle, and a logger bound to the task. An agent never constructs a
provider client itself.

### 3. Tool

A capability with a typed interface and a declared blast radius.

```ts
interface Tool {
  id: string;                             // "web.search"
  description: string;
  input: ZodSchema;                       // validated before invocation
  output: ZodSchema;                      // validated after
  sideEffect: "read" | "write" | "consequential";
  invoke(input: unknown, ctx: ToolContext): Promise<unknown>;
}
```

### 4. Trigger

The seam for future automation. A trigger produces objectives.

```ts
interface Trigger {
  id: string;                             // "manual" in v1
  start(emit: (objective: ObjectiveRequest) => void): void;
}
```

In v1 the only implementation is `manual` — the operator submitting from the
UI. Scheduled and event-driven automations are later implementations of the
same interface, which is why automation needs no core change to arrive.

---

## Domain model

Persisted in SQLite. Simplified — types shown, not full DDL.

| Entity | Purpose | Key fields |
| --- | --- | --- |
| `project` | Context boundary for work | `id`, `name`, `brief`, `created_at` |
| `mission` | One objective, end to end | `id`, `project_id`, `objective`, `status`, `plan_json`, `created_at` |
| `task` | Unit of work within a mission | `id`, `mission_id`, `parent_id`, `agent_id`, `status`, `input_json`, `output_json`, `depends_on` |
| `approval` | A decision the operator owes | `id`, `mission_id`, `task_id?`, `kind`, `payload_json`, `status`, `decided_at` |
| `model_call` | One call to one model | `id`, `task_id`, `provider_id`, `model_id`, `tokens_in`, `tokens_out`, `cost`, `latency_ms` |
| `tool_call` | One tool invocation | `id`, `task_id`, `tool_id`, `input_json`, `output_json`, `side_effect`, `approval_id?` |
| `artifact` | A durable finding or output | `id`, `mission_id`, `type`, `content`, `source_url`, `retrieved_at`, `confidence` |
| `run_event` | Append-only activity log | `id`, `mission_id`, `task_id?`, `type`, `payload_json`, `at` |

**Everything is a node in one tree:**
`mission → task → (model_call | tool_call) → artifact`.
That tree is simultaneously the execution structure, the UI, and the audit log.

**Provenance is mandatory on artifacts.** `source_url` and `retrieved_at` are
not optional metadata — a research finding without a date is a liability,
particularly for investment work.

### Status values

```
mission:  draft → planning → awaiting_approval → running
                → verifying → synthesising → completed
                                           ↘ failed | cancelled

task:     pending → ready → running → completed
                                    ↘ failed | skipped | blocked_on_approval
```

---

## Mission lifecycle

```
  objective
     │
     ▼
  [1] PLAN        planner model call → structured task graph
     │
     ▼
  [2] APPROVE     ◄── operator reviews / edits / rejects the plan
     │                (the one mandatory gate in v1)
     ▼
  [3] EXECUTE     scheduler runs ready tasks in parallel
     │            each task: agent + routed model + permitted tools
     ▼
  [4] VERIFY      material claims re-checked against independent sources,
     │            using a model from a different provider
     ▼
  [5] SYNTHESISE  findings → recommendation with confidence,
     │            citations, and key uncertainties
     ▼
  completed       operator decides
```

Stages 1, 4, and 5 are single model calls with validated structured output.
Stage 3 is a scheduler loop. Stage 2 is a blocking wait on an `approval` record.

---

## Orchestrator

Five components, each doing one thing:

**Planner** — takes an objective plus the project context bundle, returns a
validated task graph: tasks, their dependencies, the agent chosen for each, and
a one-line rationale per task. Rationale is required because it is what the
operator reads at the approval gate.

**Scheduler** — maintains the task graph. A task becomes `ready` when its
dependencies are `completed`. Runs ready tasks concurrently up to a configured
limit. Pure state machine, no model calls.

**Executor** — runs one task: resolves the agent from the registry, routes a
model, assembles the permitted tool set, invokes `agent.run()`, validates and
persists the result. All I/O for a task funnels through here, which is why
logging and cost capture need no cooperation from agent authors.

**Verifier** — a distinct stage, not a prompt instruction. Takes artifacts
flagged material by the research stage and re-checks each against at least one
independent source, using a model constrained to a *different provider* than
the one that produced the claim. Emits verification artifacts with an outcome:
confirmed, contradicted, or unverifiable.

**Synthesiser** — takes verified artifacts and produces the recommendation:
answer, confidence, supporting citations, key uncertainties, and what would
change the conclusion.

---

## Model routing

Tasks and agents declare **requirements**; the router resolves them to a
concrete model against the registry and a policy file.

```ts
interface ModelRequirement {
  reasoning: "basic" | "strong" | "frontier";
  minContextTokens?: number;
  structuredOutput?: boolean;
  costSensitivity?: "low" | "normal" | "high";
  mustDifferFromProvider?: string;    // independence: different vendor
  mustDifferFromModel?: string;       // independence: different model family
}
```

**Two independence constraints, because local-first removes the first one's
teeth.** `mustDifferFromProvider` gives a critic a different vendor — but a
£0 system has one provider, so under local-first that constraint can never be
satisfied. `mustDifferFromModel` is the local equivalent: a critic runs on a
*different local model family* (say a Gemma-class model checking a Qwen-class
one), which is where the actual independence comes from — different training
data and different failure modes, not a different billing relationship.

Both are first-class routing constraints rather than verifier-specific logic, so
M6 can express "check this with something that is not what produced it" whether
the operator is running purely local or has enabled a cloud provider.

**Reasoning tiers are cloud-anchored and honest.** `frontier` means a top-tier
cloud model; `strong` a large local model or mid-tier cloud model; `basic` a
small local model. A provider must not inflate its descriptors to win routing —
an agent that declares `frontier` and gets a local 8B has been lied to, and the
router is the only thing standing between an agent and the wrong model.

**Descriptors report configured capability, not theoretical maximums.** A local
model's `contextTokens` is the context the runtime is actually configured to
serve, not the largest the architecture supports. Routing on advertised numbers
the deployment cannot honour is routing on a lie.

Routing policy lives in a config file (preferred model per capability tier,
fallback order), so changing which model does what is a config edit.

---

## Tools and side effects

Every tool declares one of three classes:

| Class | Meaning | Approval |
| --- | --- | --- |
| `read` | Fetches information, changes nothing | Never |
| `write` | Changes state the system owns (files, its own DB) | Configurable |
| `consequential` | Spends, sends, publishes, trades, or is otherwise irreversible outside the system | **Always** |

The executor checks the class before invocation and raises an approval instead
of calling when required. Approval policy is therefore derived from declarations
rather than maintained as a growing list of special cases.

v1 ships five tools: four `read` — `workspace.read`, `wiki.search`,
`web.search` (registered only when SearXNG is configured) and `web.fetch` — and
one `write`, `workspace.write`, sandboxed to the workspace directory. The
default policy allows `read` and `write`; `consequential` is denied until
approvals exist.

---

## Approval

An approval is a first-class record and a genuine blocking state — not a UI
prompt.

1. The runtime writes an `approval` row and marks the mission or task blocked.
2. A `run_event` is emitted; the UI receives it over SSE and surfaces it.
3. The runtime does not advance that branch. Other independent branches continue.
4. The operator approves, edits, or rejects.
5. The decision is recorded with a timestamp, and the runtime resumes.

Because approvals are persisted, a pending approval survives a restart. v1 has
exactly one mandatory gate — plan approval — plus automatic gating of any
`consequential` tool.

---

## Project context and memory

**Project** is the context boundary. A mission belongs to exactly one project.

**Context assembly** builds a `ContextBundle` for each task from: the project
brief, relevant prior artifacts from the same project, and the current mission's
completed task outputs. The bundle has an explicit token budget; assembly is
deterministic code, so what an agent saw is always reconstructable.

**Memory in v1 is the artifact store, scoped by project, with provenance.** No
vector database, no semantic memory layer. Retrieval is keyword and recency
based over artifacts. This is deliberately modest: a semantic memory system is
its own project and would swallow the first version. The `ContextAssembler`
interface is the seam where a better retrieval strategy plugs in later.

---

## Activity logging and observability

The `run_event` table is the spine of the visibility requirement. Every state
transition — mission created, plan proposed, approval raised, task started,
model called, tool invoked, task failed, mission completed — is appended.

**Current-state tables plus an append-only event log**, written in the same
transaction. This is a hybrid rather than pure event sourcing: current state is
queried directly (simple, fast) while the event log gives history, audit, and
live streaming. The tradeoff is that state and log could theoretically diverge;
writing both in one transaction with a single writer process prevents it.

The nine things the vision requires the operator to see all map to queries over
these tables:

| Operator question | Source |
| --- | --- |
| What missions are running | `mission.status` |
| Which agents are working | `task` where `status = running` |
| Which models they are using | `model_call` joined to running tasks |
| What tasks are being performed | `task` tree per mission |
| What tools are being accessed | `tool_call` recent |
| What has completed / failed | `mission.status`, `task.status` |
| What needs approval | `approval` where `status = pending` |
| What the system recommends next | synthesis artifact + pending approvals |

---

## Failure handling and resumability

- **Transient failures** (network, rate limit): retry with exponential backoff,
  bounded attempts, each attempt logged.
- **Task failure**: marked `failed` with the error captured; dependent tasks
  become `skipped`; independent branches continue.
- **Mission failure**: if the objective can no longer be met, the mission is
  marked `failed` — but every artifact produced so far is retained. A failed
  mission that gathered useful research is still worth reading.
- **Process restart**: on boot the orchestrator reads unfinished missions from
  the store, restores the task graph, and resumes. Tasks that were `running` at
  crash time are re-queued. This works only because state lives in the database
  rather than in memory — principle 2 paying for itself.

---

## Automation (designed for, not built)

Automation is not a v1 feature, but the architecture must not have to change to
accept it. It does not, because:

- **Objectives already arrive through the `Trigger` contract.** A scheduled
  automation is a `cron` trigger emitting the same `ObjectiveRequest` the manual
  UI emits. The orchestrator cannot tell the difference and needs no change.
- **Missions are already durable and resumable**, so long-running or background
  work needs no separate mechanism.
- **Approval is already a blocking, persisted state**, so an unattended
  automation that hits a consequential action parks safely and waits rather than
  proceeding or crashing.

The only genuinely new component automation will need is a scheduler process and
a policy for what an unattended mission may do without a human — a policy
question, not a structural one.

---

## Interface and transport

- **Web SPA**, served locally. Chosen over terminal (caps the live view) and
  desktop (packaging overhead, no benefit at this stage).
- **HTTP + JSON** for commands: create mission, approve, cancel.
- **Server-Sent Events** for live updates. One-directional server → client is
  all the visibility requirement needs; SSE is plain HTTP, auto-reconnects, and
  avoids WebSocket infrastructure for a feature nobody needs yet.
- **The UI holds no authoritative state.** It renders a projection of the store,
  updated by events. A refresh must be indistinguishable from a live session.

Two screens in v1: a mission view (live task tree, status, running cost) and a
history list.

---

## Technology choices

| Layer | Choice | Reason |
| --- | --- | --- |
| Language | **TypeScript** (Node 22+) | One language and one set of types across orchestrator, API, and UI; strong SDKs for both target providers; structured-output validation fits naturally |
| Storage | **SQLite** (`better-sqlite3`, WAL) | Local-first, zero-ops, transactional, genuinely queryable. Single operator means no concurrency pressure. Postgres migration path exists if ever needed |
| Migrations | Plain SQL files applied in order | ~40 lines of runner; avoids an ORM dependency for a schema this size |
| Validation | **Zod** | Model output and tool I/O must be validated at the boundary. Non-negotiable given principle 1 |
| API | **Fastify** | First-class TypeScript, built-in schema validation that pairs with the above |
| UI | **React + Vite** | Boring, well-understood, fast local dev |
| Local inference | **Ollama**, HTTP on `127.0.0.1:11434` | The default provider. Native JSON-Schema structured outputs, token counts in its responses, native Apple Silicon runner, model management built in. Reached with `fetch`, so it adds **no npm dependency** |
| Local model | **Qwen3 8B** class, 4-bit | Fits well within 24 GB with headroom for the rest of the system, native tool-calling and reliable schema-constrained output. Exact registry tag verified before download |
| Cloud providers (optional) | `@anthropic-ai/sdk`, `openai` | Optional adapters, installed and registered only if the operator opts in. Never required to run |
| Search | One HTTP search API via `fetch` | No SDK dependency needed |

Ollama is a **runtime dependency of the operator's machine, not of this
codebase**: nothing in `package.json` refers to it, and the adapter that talks
to it is one edge module reachable only through the `ModelProvider` contract.
Swapping Ollama for llama.cpp, LM Studio or MLX later means writing a different
edge module, not changing the core.

**On Python:** investment and crypto analysis (focus areas 1 and 2) lean on the
Python data ecosystem. That is not a reason to write the core in Python — the
Command Centre orchestrates analysis, it does not perform it. A Python analysis
service attaches later as a `Tool` behind an HTTP boundary, which is exactly
what the tool contract is for.

---

## Security and secrets

- **No credentials are required to run.** The default configuration has no API
  keys because the default provider is local. This is the strongest form of
  secret management available: there is nothing to leak.
- **Inference data does not leave the machine by default.** Objectives,
  findings, and project context are sent to a third party only if the operator
  has deliberately enabled a cloud provider. Any future feature that would send
  operator data off-machine must be opt-in and must say so plainly.
- **API keys live in the environment** when a cloud provider *is* enabled,
  loaded at startup, never written to the database and never included in
  `run_event` payloads. Log redaction is applied at the store boundary so it
  cannot be forgotten by a caller.
- **Bind to `127.0.0.1` only.** No authentication in v1 is acceptable *because*
  the surface is local and single-operator. This assumption must be revisited
  before the service is ever exposed to a network — recorded here so it is a
  decision rather than an oversight.
- **Tool inputs are validated** against their schema before invocation.
- **Content fetched from the web is data, never instruction.** Agent prompts
  must frame retrieved page content as untrusted material. Prompt injection via
  a fetched page is the most realistic attack on a research system.

---

## Repository layout

```
src/
  core/
    domain/          entities, status machines, pure types
    orchestrator/    planner, scheduler, executor, verifier, synthesiser
    registry/        provider, agent, tool, trigger registries
    routing/         model router + policy
    store/           sqlite access, migrations, event log
    context/         project context assembly, memory retrieval
    approval/        approval queue                          (planned, M10)
  providers/
    local/           default — talks to the local runtime over HTTP
    anthropic/       optional
    openai/          optional                                (planned)
  agents/
    planner/  analyst/  maker/  synthesiser/
  tools/
    workspace-read/  workspace-write/
    wiki-search/  web-search/  web-fetch/
  api/               fastify routes + SSE stream
  triggers/
    manual/
web/                 react + vite SPA
config/              routing policy, registry manifest
```

The shape of `src/` is the architecture. If a new provider requires edits
outside `providers/` and `config/`, something has gone wrong.

---

## Explicitly not in v1

Deferred deliberately, and none of it requires structural change to add:
multiple agent types, scheduled automations, cross-mission semantic memory,
external service monitoring, code execution, market data feeds, notifications,
budget enforcement (spend is tracked, not capped), multi-user access.

---

## Decision log

| Date | Decision | Reasoning | Alternatives considered |
| --- | --- | --- | --- |
| 2026-08-15 | Document the project before writing code | Scope was undefined; building first would lock in wrong assumptions | Prototype first, document after |
| 2026-08-15 | No stack chosen (superseded below) | Was blocked on `vision.md` | — |
| 2026-08-15 | Deterministic runtime, models only at defined stages | An LLM holding the state machine forfeits debuggability, resumability, and observability — the core promises of the product | Agent-framework-driven control flow |
| 2026-08-15 | Current-state tables + append-only event log | Visibility, history, cost tracking and crash recovery all derive from one persistence decision | In-memory state with logs bolted on; pure event sourcing |
| 2026-08-15 | Four extension contracts + registry, no plugin SDK | Generalising before three real integrations exist produces the wrong abstraction | Full plugin framework up front |
| 2026-08-15 | Core may not import edge modules; enforced by lint | "Add a provider without touching core" is only true if mechanically enforced | Convention and code review |
| 2026-08-15 | Capability-based model routing | Naming models in core code makes multi-provider support cosmetic | Named-model config per task |
| 2026-08-15 | Verification routed to a different provider | Gives real independence and continuously proves the multi-provider abstraction at near-zero extra cost | Same model self-checks |
| 2026-08-15 | Side-effect class declared per tool | Derives approval policy structurally instead of maintaining a rules list | Per-tool approval configuration |
| 2026-08-15 | TypeScript, Node, SQLite, React | One language across the stack; local-first storage with no operational burden; smallest defensible dependency set | Python + FastAPI (stronger data ecosystem, but the core orchestrates rather than analyses); Postgres (needless ops for one user) |
| 2026-08-15 | Single process for v1, orchestrator kept transport-free | Simplest thing that works, without foreclosing a split later | Separate worker process from the start |
| 2026-08-15 | SSE over WebSockets | Updates are server→client only; SSE is plain HTTP with automatic reconnect | WebSockets; polling |
| 2026-08-15 | Memory = artifact store with provenance | A semantic memory layer is its own project and would swallow v1; the assembler interface is the seam for it later | Vector database from the start |
| 2026-08-15 | Local bind, no auth in v1 | Acceptable only because the surface is local and single-operator; must be revisited before any network exposure | Auth from day one |
| 2026-08-15 | **Local-first: open-weight models are the default provider; £0 ongoing cost is a requirement** | Metered inference makes the operator ration their own thinking, which defeats the leverage the product exists to create. Zero marginal cost also keeps research data on the machine | Cloud-default with a local fallback; local as an optional mode |
| 2026-08-15 | **Ollama as the initial local runtime** | Native JSON-Schema structured outputs preserve the validated-output principle; its responses carry token counts so usage accounting is unchanged; native Apple Silicon runner; reached over HTTP with `fetch`, so no new npm dependency | llama.cpp direct (more control, more setup); MLX/`mlx-lm` (~10–25% faster but puts Python in the inference path); LM Studio (GUI-first, poor fit for a headless service) |
| 2026-08-15 | **Qwen3 8B class, 4-bit, as the initial local model** | Leaves ample headroom in 24 GB of *unified* memory, native tool-calling, reliable schema-constrained output. Larger 27–30B models fit only by crowding out the rest of the system | A 27–30B model for quality (too tight on shared memory); a smaller model for speed (weaker structured output) |
| 2026-08-15 | **Reasoning tiers stay cloud-anchored; descriptors report configured, not theoretical, capability** | An inflated descriptor makes the router hand an agent a model that cannot do the job — silently. Honest descriptors mean a mismatch fails loudly at routing instead | Re-scaling tiers relative to whatever is installed (hides the local/cloud quality gap) |
| 2026-08-15 | **Add `mustDifferFromModel` alongside `mustDifferFromProvider`** | Under local-first there is one provider, so the provider constraint can never be satisfied and M6's critics would have no independence. Independence actually comes from a different model family — different training data, different failure modes | Provider-only independence (unsatisfiable when local); dropping the independence guarantee |
| 2026-08-15 | **Every pipeline stage is a real task row — planning and synthesis included** | Hiding planning inside the orchestrator would make the most consequential model call invisible and untimed. As tasks they are attributable, costed and inspectable like any other work | Orchestrator-internal stages (invisible); a separate "stage" concept (a second vocabulary for the same thing) |
| 2026-08-15 | **The orchestrator re-validates and repairs planner output** | A plan is model output, so it is untrusted even though the planner agent already validated it. Unknown agent ids fall back to a real agent and impossible dependency edges are dropped, because a malformed graph would deadlock rather than fail | Trusting the agent's own validation; failing the mission on any imperfection |
| 2026-08-15 | **Wave-based scheduling rather than continuous dispatch** | A wave can leave a slot idle while a long task finishes; in exchange the loop is simple enough to audit and its failure propagation is obvious. Throughput is not the bottleneck when one local model serves every slot | Continuous work-stealing scheduler (more throughput, materially more complexity) |
| 2026-08-15 | **Missions synthesise from partial results when some tasks fail** | A mission that loses one of three analysts still holds useful evidence; discarding it would waste real work. The operator is told the answer rests on partial evidence | All-or-nothing (throws away good findings); silent partial synthesis (hides the gap) |
| 2026-08-15 | **Default tool policy permits only `read`; `write` and `consequential` are denied** (superseded 2026-08-23 for `write`) | There is no approval mechanism yet, so refusing is the honest position — running consequential tools ungated would be worse than not offering them | Allowing writes by default; gating per tool name rather than by declared class |
| 2026-08-21 | **Effort maps to reasoning-on/off plus token budget — no graded depth dial** | Measured: the installed models accept `think: "low"/"high"` but do not honour it (`"low"` produced *more* reasoning than `"high"`). A depth slider would be a control that does nothing | A five-notch depth slider mirroring cloud `effort`; no effort control at all |
| 2026-08-21 | **Preferences are captured onto the mission at submit time** | A mission's record should say what it actually ran on. Reading preferences live during execution would let a later settings change rewrite history | Read live per call (simpler, but history becomes unreliable) |
| 2026-08-21 | **Every installed model is routable; config sets the default order only** | Offering a model in the interface that the router cannot select produces a silent fallback — the operator picks a model and gets a different one with no visible reason | Config-only allowlist (interface must then hide uninstalled-but-configured models, and vice versa) |
| 2026-08-21 | **The mission graph is drawn from real `dependsOn` edges** | A decorative network would look the same but tell the operator nothing. Deriving layout from dependency depth means parallelism and the critical path are readable facts | Ambient/decorative network visual; no visualisation |
| 2026-08-22 | **A named `reasoning` model serves every request needing a reasoning pass, overriding the operator's general preference** | Effort levels are only meaningful if raising them reaches a model that can actually reason. Letting a general preference win would make "Careful" silently identical to "Balanced" on a non-reasoning model | Filter by capability only (any thinking-capable model); let the preference win (makes effort a no-op) |
| 2026-08-22 | **Retry failed tasks up to three times, with growing backoff** | Small local models emit invalid structured output often enough that a single attempt loses missions that would have succeeded. Cancellations and configuration faults are excluded — they will never succeed on a retry | No retries (documented in M3 but never built); unlimited retries (masks real faults) |
| 2026-08-22 | **Evaluation scores deterministically; no model judges another** | On 8B-class models a judge is as unreliable as the thing being judged. Topic coverage and calibration are computable from the run, so the numbers mean the same thing every time | LLM-as-judge (nuanced but unreliable at this model size); no evaluation (decisions stay anecdotal) |
| 2026-08-21 | **Usage reports throughput, effort cost and time distribution rather than totals** | Token counts alone drive no decision. Which model is fast *on this machine*, and whether higher effort earns its time, do | Standard totals dashboard |
| 2026-08-23 | **SearXNG, self-hosted, as the web-search backend** | Brave/Tavily/Exa all need an account, a key and a quota — a metered dependency wearing a free badge, which is the exact drift the £0 guarantee exists to prevent. A local instance has no key, no quota, and no third party learning what the operator searches for | Brave/Tavily/Exa free tiers (metered, key-bound); scraping a search engine directly (brittle and hostile); Wikipedia only (measurably insufficient — see below) |
| 2026-08-23 | **SearXNG installed from source into a venv, not Docker** | The machine had no container runtime, and adding Docker Desktop or a Lima VM to run one Python service is a large, permanently-running cost for no benefit. `python@3.13` was already present and SearXNG declares `>=3.10` | Docker Desktop (~600 MB plus a background VM); Colima/podman (lighter, still a VM); no web search |
| 2026-08-23 | **SearXNG's bot limiter is disabled on this instance** | The limiter is bot detection designed for public instances: it rejects any client that does not look like a browser, including ours, with an opaque 403. On a loopback instance serving one person there is nothing to protect against | Leaving it on and spoofing browser headers (fighting our own infrastructure); running a public instance (not the deployment model) |
| 2026-08-23 | **Web search is optional; its absence degrades rather than blocks** | A tool registered but non-functional is worse than one that does not exist — the model reaches for it and fails. With `SEARXNG_URL` unset the tool is never registered and the system runs on Wikipedia alone | Registering it always and failing at call time; making it a startup precondition (breaks the £0/zero-setup promise) |
| 2026-08-23 | **Wikipedia lookups select passages by query relevance, not the lead paragraph** | Measured: asked which refrigerants heat pumps use, `exintro` returned an overview naming none of them, and the model answered from priors — wrongly, at high confidence. The fact usually sits well below the lead | Intro extracts only (what failed); returning whole articles (evicts everything else from the context window) |
| 2026-08-23 | **The tool loop counts successful and failed lookups separately** | Treating any tool turn as grounding let a mission whose retrieval had collapsed — four failures of five — still report high confidence on facts the model supplied from memory. The model is now told what retrieval actually achieved | Any-tool-turn-means-grounded (what failed); failing the task when a tool fails (loses partial evidence) |
| 2026-08-23 | **`qwen3:14b` becomes the default model** | The eval harness reversed a recommendation made on a single anecdote: 95% vs 83% across four cases, with the 8B scoring 50% on factual recall. Slower per task, and worth it | `qwen3:8b` for speed (measurably weaker); routing per task type (no evidence yet that it helps) |
| 2026-08-23 | **The default policy admits `write`, ahead of M10's approvals** | Containment, not trust: `workspace.write` reuses the read tool's lexical and `realpath` checks, so the blast radius is one operator-owned folder, nothing is overwritten without an explicit flag, and nothing written is executed. A `consequential` tool — sending, publishing, spending, deleting — has no comparable boundary, which is why it stays denied. Without this the system could only ever describe work, never do it | Waiting for M10 (leaves every mission draining into prose for several milestones); a per-tool allowlist (the special-case list the side-effect declaration exists to avoid) |
| 2026-08-23 | **`workspace.write` accepts text formats only** | Not a security boundary — the containment check is what protects the filesystem — but a correctness one. The model hands us a UTF-8 string; letting it claim that string is a `.png` produces a file no viewer opens and a result that looks successful | Any extension (silently broken binaries); a single fixed format (too narrow for documents, code and data) |
| 2026-08-23 | **A `maker` agent, separate from the analyst** | The analyst answers questions; a system whose every output is prose is a chatbot with extra steps. The split also lets the prompt carry two rules the analyst does not need — write rather than describe, and look the facts up first (asked for an Arsenal badge, the model asserted red-and-black and an invented motto from memory while holding search it never reached for) | Giving the analyst the write tool (one prompt serving two incompatible instincts); a post-processing step that renders analyst prose into files |
| 2026-08-24 | **Artifact cases are scored against the file on disk, never the model's account of it** | The maker agent shipped on the strength of one badge, which is the anecdote footing the harness exists to replace. Scoring the summary would let a model describe a crest it never wrote and score full marks; reading the bytes back makes "produced nothing" the zero it should be | Scoring the agent's own reported `artifacts` (self-reported, and the thing most likely to be wrong); a model judging the output (unreliable at this size, and the reason nothing else here uses one) |
| 2026-08-24 | **A failed `produced` check zeroes the whole artifact score** | Every remaining check is vacuous on a file that does not exist: it contains no falsehoods and no lookup informed it. The first version scored 40% for writing nothing at all — caught by a test, not by inspection | Averaging the checks that can still be evaluated (rewards absence); scoring only `produced` (loses all gradation between a poor file and a good one) |
| 2026-08-24 | **The workspace root is configuration, not a constant** | Evaluation already gets a scratch database so it cannot pollute mission history; without the same treatment for the workspace it wrote into the operator's real folder, and the second run of a case met its own output — the write tool refuses to overwrite, so a scheduling artefact scored as a failure to produce | Cleaning up known paths afterwards (misses whatever the model named differently); letting eval share the real workspace (measures the wrong thing) |
| 2026-09-05 | **An agent may declare a tool the gathering phase cannot end without** (`requireTool`) | Phase two applies the output schema, and schema-constrained decoding cannot emit a tool call, so the instant gathering ends the deliverable can no longer be produced. For the maker that made "the model stopped calling tools" indistinguishable from "the model decided not to build anything" — it went on to describe, fluently, a file it had never written. Three of the maker's four recorded failures are this exact shape | A third phase that writes after the answer (the content would be the model's summary, not its work); trusting the prompt to insist (already tried — the comment above `deferUntilLookupAttempted` records that instructing the model to research first did nothing until the tool was withheld); failing the task immediately (loses a mission that one more round would have completed) |
| 2026-09-05 | **A tool call that already failed is answered from the loop, not re-sent** | Told only that a tool failed, the model reissues the identical call. One mission spent all four of its rounds sending the same Wikipedia query to a host that was not answering and reached synthesis with nothing. The round is better spent telling it precisely what it is repeating than spending it on a network call whose answer is known | Retrying with backoff inside the tool (hides a dead host as latency, and the model still learns nothing); allowing the repeat (what happened); failing the task on a repeat (a transient outage should degrade the answer, not lose it) |
| 2026-09-05 | **Agents are told what did *not* finish, not only what did** (`ContextBundle.missing`) | Synthesis depends only on the tasks that completed, so the synthesiser could not tell a mission that went to plan from one that had lost half its evidence — and rated both the same. A mission whose maker died returned a confident recommendation describing a file that did not exist. Naming the gap is what lets confidence account for it | Leaving it to the interface (the operator sees a warning, but the recommendation text still overclaims); failing any mission with a dead task (throws away real findings, which the partial-synthesis decision above deliberately keeps) |
| 2026-09-05 | **`web.search` results carry a line saying they are summaries, not sources** | `web.fetch` had never been called once — not in thirty-one tool calls across twenty-seven missions — so every conclusion the system had ever reached rested on a search snippet. Snippets arrive looking like findings: a title, a plausible sentence, an air of having been checked. The correction belongs in the tool result, which is in front of the model at the moment it chooses what to do next, rather than in a system prompt it read long before | A prompt rule in the analyst (the same class of instruction that failed for research-before-build); requiring a fetch (many briefs are genuinely answered by an encyclopedia extract, and a forced fetch would waste a round); dropping snippets from the result (leaves the model unable to choose which result is worth opening) |
| 2026-08-15 | **Memory is never written automatically** | Auto-retention silently shapes later reasoning with material the operator never chose. Promotion is one click, and what is kept is visible and removable | Auto-summarise every mission into memory; no memory at all |

---

Last updated: 2026-09-05
