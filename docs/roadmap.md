# Roadmap

> **Status: proposed.** Sequence, not schedule — milestones are ordered by
> dependency, with no dates attached. Scope comes from [vision.md](vision.md);
> the technical design each milestone builds against is in
> [architecture.md](architecture.md).

## How this roadmap works

Four rules shaped the ordering:

1. **Every milestone ends in something runnable.** There are no
   infrastructure-only milestones. Substrate is built as the milestone that
   needs it requires it.
2. **Each milestone has a falsifiable exit criterion** — something that can be
   demonstrated, not a judgement call about whether the work "feels done".
3. **Ordered by dependency, not by appetite.** A capability appears as early as
   the thing that makes it meaningful, and no earlier.
4. **Each milestone states what it deliberately does not do**, so scope stays
   contained.

## Current position

**Phase 0 — Documentation: complete** (2026-08-15).

**M1 Command to result — complete.** Verified end to end on a local model with
no API key: objective in, recommendation out, every transition persisted,
history intact across a restart.

**M2 Multiple agents — complete.** A planner decomposes the objective and
assigns each task to a worker; four agents (planner, analyst, maker,
synthesiser) are registered and selected by declared purpose.

**M3 Task graph — partial.** Dependency-aware scheduling with bounded
parallelism, failure propagation (dependents are skipped, not stranded), and
**retry with backoff** are built and tested. One stated build item remains
missing: resumption after a restart. An interrupted mission is marked *failed*
and its completed work is not reused, so M3's exit criterion — "killing the
process mid-run then restarting resumes it without losing completed work" — is
**still not met**.

**M4 Tools — complete, and now past its stated scope.** The contract,
registry, permission policy and four sandboxed `read` tools are implemented and
tested, and agents invoke them autonomously through a two-phase tool-use loop
(gather, then answer under schema constraint — the two cannot be combined,
because schema-constrained decoding prevents the model emitting a tool call at
all).

Verified end to end: a mission asking which refrigerants domestic air-source
heat pumps use returned R-410A/R-32/R-744 with correct GWP figures retrieved
from live sources. The same mission before tool use produced R-22 and described
R-410A as low-GWP — it is ~2088, among the highest in common use.

**A `write` tool shipped ahead of M10** (2026-08-23), which this roadmap
previously said would not happen. `workspace.write` and a **maker** agent turn
a mission into a file — an SVG, a document, a script — rather than a
description of one, and produced artifacts are listed and previewed in the
mission view. The default policy now allows `read` and `write`.

The justification is containment, not a change of mind about approvals: the
write tool reuses the read tool's lexical and `realpath` checks, so its blast
radius is one operator-owned folder, nothing is overwritten without an explicit
flag, and nothing written is executed. `consequential` tools have no comparable
boundary and remain denied — they still wait on M10.

**The maker was unreliable; it is now measured working (2026-09-05).** It had
run at 55% — six of eleven tasks — while every other agent sat at 100% over far
more runs (analyst 48, planner 27, synthesiser 26). Two causes, both found by
reproducing against the real model rather than reading the code:

The **research gate starved it**. `deferUntilLookupAttempted` withheld the write
tool until a lookup had been attempted, which was right when the maker
researched and drew in one go. Once the planner began handing the research to an
analyst, the maker arrived with the findings already in context and every
offered tool saying "go and research" — and in that position the model returns
nothing whatsoever, four times out of four, killing the task before any loop
logic runs. The gate now lifts when upstream research is present.

**Nothing then required the file to be written.** Gathering ended the moment the
model stopped calling tools, and the schema-constrained answer phase cannot emit
a tool call, so the deliverable was already unreachable — and the model went on
to describe a file it never wrote. `requireTool` refuses that ending; if
research eats every round, one final turn offers the write tool and nothing else.

Measured on the artifact eval: **0 of 6 missions produced a file → 6 of 6**,
coverage 50%/100% → 100% on every run, artifact scores 57–90% (76% average on
the latest pass), at comparable wall time.

It looked solid before because it was judged at mission level. Synthesis runs on
partial results by design, so a mission whose maker task died still reported
*completed* and returned a confident recommendation with nothing attached — four
badge missions in a row looked like success. The synthesiser is now told what
failed (`ContextBundle.missing`) and lowers its confidence accordingly; measured
overconfidence on these cases went from 1 to 0.

**Not yet:** `consequential` tools. A succeeded-but-irrelevant lookup still lets
the model fall back on recall; that is a critic's job (M6), not the loop's.

**M7 Synthesis — partial.** Missions end with a grounded recommendation carrying
confidence, key points and uncertainties. It is explicitly *not* verified;
that is M6 and the interface says so rather than implying confidence the system
has not earned.

**M8 Projects — partial.** Projects exist as real context boundaries: missions
belong to one, and the project brief plus kept memory are assembled into every
agent's context. Archiving and richer project views are not built.

**M9 Memory — partial.** Operator-controlled memory works: findings are kept
only when promoted, can be pinned or forgotten, and are supplied to agents in
that project. Completed missions also retain a short interest trail plus key
points automatically (capped, deduplicated, forgettable). Retrieval is
recency-ordered; there is no semantic search.

**M5 Multi-model orchestration — mostly complete.** Three local models across
two families are routable. `config/models.json` is an allowlist that also
assigns roles: a named `reasoning` model serves any request needing a reasoning
pass, so raising effort always reaches a model that can honour it. The operator
can pick a model per mission; the choice is recorded on the mission. Cost stays
£0 because every provider in play is local. Not built: automatic per-agent model
selection (planning still uses the same model as analysis unless effort differs).

**`web.fetch` was dead until 2026-09-05.** It had never been called once — not
in thirty-one tool calls across twenty-seven missions — so every conclusion the
system had reached rested on a search-engine snippet rather than a source.
`web.search` results now carry a line saying what they are, and the analyst
began opening pages immediately: nine fetches in the first mission after the
change, including the club's own crest page and brand guidelines.

**Evaluation harness — new, not previously on this roadmap.** `npm run eval`
runs real missions across a model/effort matrix and scores topic coverage,
confidence calibration and — for cases whose deliverable is a file — the
artifact on disk, all deterministically. It exists because model and effort
choices were otherwise being made on single anecdotes.

**Not started:** M6 (critics),
M10 (approvals), M11 (monitoring), M12–M14 (automation, integrations, autonomy).

## Running cost applies to every milestone

**£0 is a constraint on the whole roadmap, not a property of M1.** Every
milestone below must be completable on local models at zero ongoing cost. Where
a paid cloud model would raise quality — most visibly at M6 (critics) and M7
(synthesis), where reasoning quality *is* the deliverable — it is an opt-in the
operator enables deliberately for specific model requirements. No milestone may
introduce a cloud provider as a prerequisite.

---

## Phase A — The spine

### M1 — Command to result

**Proves the core loop end to end:**

```
COMMAND → MISSION → TASK → AGENT → AI MODEL → RESULT
```

This is the walking skeleton. Every later milestone widens this path; none
replaces it.

**Build:**

- Project scaffolding, SQLite store, migration runner
- Domain entities: `mission`, `task`, `run_event`, `model_call`
- Append-only event log written in the same transaction as state changes
- One `ModelProvider` implementation: **LocalProvider**, running an open-weight
  model on the operator's machine at £0. Cloud adapters stay optional and
  unregistered unless credentials are configured
- One `Agent` implementation, doing one thing
- Orchestrator: accept objective → create mission → create a single task →
  execute → persist result
- Minimal API + SPA: a command box, a live mission view, a result panel
- SSE stream from the event log to the interface

**Exit criteria:** the operator types an objective, watches the mission, task,
agent, model and result appear live, and the full record survives a process
restart — **with no API key configured and no paid API call made**.

**Not yet:** multiple tasks, tools, routing, verification, approval, projects.

---

## Phase B — Orchestration

### M2 — Multiple agents

**Proves:** the planner can decompose an objective and choose the right worker
for each piece.

**Build:**

- Planner stage: objective → validated multi-task plan, with a rationale per task
- Agent registry; agents declare `purpose` and their model requirement
- Planner selects agents by declared purpose
- A second and third agent type with genuinely different jobs
- Interface shows the task list and which agent owns each task

**Exit criteria:** one objective produces several tasks handled by different
agents, executed in sequence, each visible with the reason it was created.

**Not yet:** parallelism, dependencies between tasks.

### M3 — Task graph: dependencies and parallel execution

**Proves:** the scheduler is a real dependency-aware state machine.

Dependencies and parallelism are two halves of one component and are built
together — parallel execution without a dependency graph is just "run
everything at once", which is not the thing that needs proving.

**Build:**

- `depends_on` edges in the plan; scheduler marks tasks `ready` when
  dependencies complete
- Bounded concurrent execution of ready tasks
- Failure propagation: dependents `skipped`, independent branches continue
- Retry with backoff for transient failures
- Resumability: unfinished missions restored and re-queued on restart
- Interface renders the task tree with live per-task status

**Exit criteria:** a mission with a diamond-shaped dependency graph runs its
independent branches concurrently, and killing the process mid-run then
restarting resumes it without losing completed work.

**Not yet:** tools, second provider.

---

## Phase C — Capability and judgement

> **Ordering note.** Tools are brought forward here, ahead of critic agents and
> synthesis. Until agents can reach real sources, they can only draw on model
> priors — which makes verification hollow (a critic with no independent sources
> can check consistency but not truth) and synthesis a summary of guesses. Tools
> are what make Phase C worth building at all.

### M4 — Tools

**Proves:** agents can act on the world through typed, declared capabilities.

**Build:**

- `Tool` contract: input/output schemas, declared side-effect class
- Executor validates tool I/O and enforces the permitted tool set per agent
- Four `read` tools: `workspace.read`, `wiki.search`, `web.search`, `web.fetch`
- `artifact` entity with mandatory provenance (`source_url`, `retrieved_at`)
- `tool_call` logging surfaced live in the interface
- Retrieved web content framed as untrusted data in agent prompts

**Exit criteria:** a research task returns findings that cite real sources with
retrieval dates, and every tool call is visible in the activity log.

**Not yet:** `consequential` tools. (`workspace.write` was subsequently added
here rather than at M13 — see *Current position* for why the containment
argument made that defensible ahead of approvals.)

### M5 — Multi-model orchestration

**Proves:** no provider assumption has leaked into the core — and that the £0
default holds even once a paid option exists.

**Build:**

- A second **local** model of a different family, registered alongside the first
- Routing policy config: preferred model per capability tier, fallback order
- **Optional** cloud adapter (Anthropic) enabled only by configuring a key, to
  prove the opt-in path works without becoming a requirement
- Per-call token accounting aggregated to task and mission; cost shown only for
  providers that actually charge, so a purely local run reports £0
- Interface shows which model each task used

**Exit criteria:** tasks within one mission run on two different models chosen
by declared capability rather than by name; changing which model serves a tier
is a config edit; and **removing every API key leaves the system fully
functional**.

**Not yet:** verification.

### M6 — Critic agents

**Proves:** the system checks itself before it advises.

**Build:**

- Verifier as a distinct orchestrator stage, not a prompt instruction
- Material claims flagged during research
- **`mustDifferFromModel`** routing constraint (added alongside
  `mustDifferFromProvider` during M5's router work), so the critic runs on a
  different local model *family* from the one that produced the claim.
  Independence comes from different training data and different failure modes,
  not from a different billing relationship — which is what makes critics work
  in a single-provider, £0 system
- Verification outcomes: confirmed, contradicted, unverifiable — each an
  artifact with its own sources
- Contradictions surfaced prominently rather than averaged away

**Exit criteria:** a deliberately planted false claim is caught and marked
contradicted, with the checking source shown, by a **different model family**
than the one that produced it — running entirely locally, at £0.

### M7 — Synthesis

**Proves the original thesis: objective in, decision-grade recommendation out.**

**Build:**

- Synthesiser stage over verified artifacts
- Recommendation structure: answer, confidence, citations, key uncertainties,
  and what would change the conclusion
- Unverified and contradicted material explicitly marked in the output
- Recommendation view in the interface

**Exit criteria:** the first proving mission — *"Research whether I should build
an AI lead-generation business for heating companies"* — runs end to end and
returns a recommendation the operator would genuinely act on, with every step,
source and cost inspectable.

**This is the point where the system becomes useful rather than promising.**

---

## Phase D — Knowledge and context

### M8 — Projects

**Proves:** work happens inside a context, not in a vacuum.

**Build:**

- `project` entity with a brief; every mission belongs to one
- `ContextAssembler`: deterministic bundle from project brief plus completed
  task outputs, with an explicit token budget
- Project switching and per-project mission history in the interface
- Initial projects seeded from the six focus areas in `vision.md`

**Exit criteria:** the same objective run under two different projects produces
visibly different plans, and what any agent saw is reconstructable after the
fact.

### M9 — Memory

**Proves:** the system does not re-learn what it already knows.

**Build:**

- Artifact retrieval across missions within a project, keyword and recency based
- Provenance-aware staleness: aged findings flagged, not silently reused
- Planner consults memory before proposing tasks; re-derivation is a choice
- Memory view: what the system knows about a project, and when it learned it

**Exit criteria:** a second mission covering overlapping ground reuses prior
findings, cites their original date, and demonstrably skips work it has already
done.

**Not yet:** semantic/vector retrieval — the assembler interface is the seam
where that plugs in later.

---

## Phase E — Control

### M10 — Approvals

**Proves:** the operator stays the decision maker.

The mechanism is cheap and could be pulled earlier if mission spend becomes
uncomfortable before this point.

**Build:**

- `approval` entity; genuine blocking state that survives restart
- Mandatory plan-approval gate before execution spends anything
- Automatic gating of any `consequential` tool call
- Approve, edit, or reject a plan from the interface
- Independent branches continue while one branch waits

**Exit criteria:** a mission pauses at its plan, waits indefinitely, survives a
restart still pending, and proceeds along the operator's edited plan.

### M11 — Monitoring

**Proves the visibility promise in full** — the nine questions in `vision.md`,
answerable at a glance.

**Build:**

- Command Centre dashboard across all missions, not one at a time
- Live view: running missions, working agents, models in use, tools being
  accessed
- Failure surface: what broke, where, and why
- Cost and token tracking per mission, project, and period
- **"What needs me"** queue — pending approvals and blocked work
- **"What next"** — system-proposed next actions from completed missions

**Exit criteria:** every one of the nine operator questions in `vision.md` is
answerable from a single screen without a database query.

---

## Phase F — Autonomy and reach

### M12 — Automations

**Proves:** the `Trigger` contract was the right seam — no core change needed.

**Build:**

- Scheduler process and `cron` trigger emitting the same objective shape the
  manual UI emits
- Standing objectives that run on a schedule against a project
- Unattended-run policy: what an automation may do without a human present
- Notification when an unattended mission needs the operator

**Exit criteria:** a scheduled mission runs overnight without supervision,
parks safely at anything consequential, and is waiting in the approvals queue
in the morning.

### M13 — External integrations

**Proves:** the system reaches beyond research into the operator's real
environment.

**Build:**

- First `consequential` tools, gated by the M10 machinery (the first `write`
  tool, `workspace.write`, landed early at M4 — it is sandboxed to the
  workspace, which nothing here will be)
- Market and crypto data sources for focus area 1
- Python analysis service attached as a tool behind an HTTP boundary
- Integration with the AI investment terminal (focus area 2)
- Credential handling reviewed before anything writes or spends

**Exit criteria:** a mission uses live external data and completes an action
with real-world consequence, having asked first.

### M14 — Increasing autonomy

**Proves the long-term objective:** one person with the leverage of an
AI-powered organisation.

**Build:**

- Autonomy policy levels per project and per tool class — what proceeds without
  asking, what always asks
- Self-directed follow-up: missions proposing successor missions
- Continuous monitoring missions that raise objectives when conditions change
- Operator review loop: periodic digest of what ran, what it cost, what it found

**Exit criteria:** the system proposes work the operator had not thought to ask
for, and that work is good enough to approve.

**This phase is deliberately last.** Autonomy is only safe once approval,
monitoring, verification, and memory are all proven — every one of them is a
control that autonomy depends on.

---

## Capability coverage

Every capability requested, mapped to where it lands:

| Capability | Milestone |
| --- | --- |
| Command → Mission → Task → Agent → Model → Result | M1 |
| Multiple agents | M2 |
| Task dependencies | M3 |
| Parallel execution | M3 |
| Tools | M4 |
| Multi-model orchestration | M5 |
| Critic agents | M6 |
| Synthesis | M7 |
| Projects | M8 |
| Memory | M9 |
| Approvals | M10 |
| Monitoring | M11 |
| Automations | M12 |
| External integrations | M13 |
| Increasing autonomy | M14 |

## Two checkpoints worth naming

- **M1** — the architecture is either right or wrong, and this is where that
  becomes apparent. Cheap to change now.
- **M7** — the system produces its first real decision. Everything before is
  investment; everything after is expansion.

---

Last updated: 2026-09-05
