# Vision

> **Status: agreed by the operator, 2026-08-15.** The scope below comes from the
> project owner and is the source of truth for what this project is. The
> questions this document originally left open have been answered — see
> [Decisions taken](#decisions-taken) — and the resulting design is in
> [architecture.md](architecture.md).

## In one sentence

A personal Universal AI Command Centre: one interface that acts as the control
plane for the operator's entire digital environment.

## The problem

Working with AI today means managing the tools by hand. Models live in separate
apps, agents live in separate frameworks, research lives in separate tabs, and
the person in the middle does all the coordination — deciding which tool to
open, re-explaining context each time, stitching outputs together, and keeping
the whole picture in their head.

That coordination work scales badly. It caps how much can be run in parallel,
loses context between sessions, and means the operator spends time being a
router rather than a decision maker.

## The core idea

The operator should give the system a **high-level objective**, not a sequence
of tool instructions.

For example:

> "Research whether I should build an AI lead-generation business for heating
> companies."

From that single objective, the system should:

1. **Understand** the objective
2. **Create a mission** from it
3. **Break it into tasks**
4. **Select appropriate agents** for those tasks
5. **Select appropriate AI models** for each agent's work
6. **Use relevant tools** to gather information and act
7. **Execute** the tasks
8. **Verify** important findings
9. **Synthesise** the results
10. **Present a final recommendation** to the operator

The operator's job is to set the objective, approve what needs approving, and
make the decision at the end.

## The mental model

The system should feel like a **personal AI organisation**.

| Element | Role in the organisation |
| --- | --- |
| **The operator** (owner) | Decision maker — sets objectives, approves, decides |
| **The Command Centre** | Headquarters — where everything is seen and controlled |
| **The orchestrator** | Coordinates the work; turns objectives into missions and tasks |
| **Agents** | Specialised workers that carry out tasks |
| **AI models** | The intelligence the workers think with |
| **Tools** | The capabilities workers act through |
| **Projects** | The context work happens within |
| **Memory** | Organisational knowledge that persists across missions |
| **Automations** | Background work that runs without being asked |

This model is not decoration — it is the intended shape of the architecture.
Each element above should map to a real, separable part of the system.

## What it coordinates

The Command Centre should eventually control and coordinate:

- Multiple AI models
- Multiple AI agents
- Projects
- Research
- Software development
- Investment analysis
- Business research
- Tools
- APIs
- Data
- Automations
- Monitoring
- External services

"Eventually" is load-bearing: this is the target surface area, not the day-one
scope. Sequencing is handled in [roadmap.md](roadmap.md).

## Initial focus areas

The first missions the system needs to serve well:

1. **Investment and crypto research**
2. **AI investment terminal development**
3. **Business idea research and validation**
4. **Heating-industry opportunities**
5. **AI / software development**
6. **General research and automation**

These are the areas that should drive early design decisions. A capability that
serves none of them is not a priority.

## What the operator must be able to see and control

The interface should make the entire operation visible at a glance:

- What missions are running
- Which agents are working
- Which models they are using
- What tasks are being performed
- What tools are being accessed
- What has completed
- What has failed
- What needs the operator's approval
- What the system recommends doing next

The last two matter most. A system that runs work invisibly, or that finishes
and goes quiet, fails at its main job — the operator must always know what needs
them and what to do next.

## Goals

1. **Objective-level control.** State an outcome, not a procedure.
2. **Orchestration over operation.** The system routes work to the right agent,
   model, and tool without being told which to use.
3. **Total visibility.** Everything running, finished, failed, or waiting is
   visible in one place.
4. **Operator in the loop.** Approvals are surfaced clearly; the operator stays
   the decision maker.
5. **Verified output.** Important findings are checked before they reach a
   recommendation, not passed straight through.
6. **Durable knowledge.** Memory carries context across missions, so the same
   ground is not covered twice.
7. **Extensible by design.** New models, agents, tools, and integrations can be
   added without rebuilding the core application.
8. **Zero marginal cost.** The system runs on local, open-weight models by
   default. Using it more costs nothing, so the operator is never rationing
   their own thinking against a meter.
9. **Leverage.** The long-term objective: give one person the leverage of an
   AI-powered organisation.

## Non-goals

- **Not a fully autonomous system.** The operator is the decision maker;
  significant actions route through approval rather than around it.
- **Not a replacement for model providers or agent frameworks.** The Command
  Centre coordinates them; it does not reimplement them.
- **Not a rebuild-per-integration system.** If adding a model or tool requires
  changing the core, the design is wrong.
- **Not dependent on any paid cloud service.** Cloud models are an optional
  upgrade the operator switches on deliberately, never a requirement the system
  acquires by default or by drift.
- **Not a multi-tenant product.** A personal system for one operator. Sharing,
  teams, and permissions are out of scope. Should that ever change, it is a new
  decision with real security consequences, not an incremental feature.
- **Not model training or fine-tuning.** The system consumes model intelligence;
  it does not produce models.

## Constraints

- **£0 ongoing running cost.** This is a first-class requirement, not an
  aspiration. Default spend is zero: inference runs on local, open-weight models
  on the operator's own machine. A paid cloud provider may be enabled
  deliberately, per model requirement, and must never become a hidden
  dependency — if the system cannot complete a mission without one, that is a
  defect.
- **Local-first inference.** Local models are the default provider. Cloud
  adapters (Anthropic, OpenAI, others) are optional modules that sit behind the
  same `ModelProvider` contract and are registered only when the operator
  configures credentials for them.
- **Research stays on the machine.** Objectives, findings and project context
  are not sent to a third party unless the operator has explicitly enabled a
  cloud provider. This matters most for the investment and business-validation
  focus areas.
- **Single operator.** One decision maker, one point of control.
- **Many-model, many-agent from day one.** No single-provider assumptions may
  leak into the core — a design constraint, not a later feature. Enforced by
  capability-based routing and an import boundary around the core.
- **Approval gates.** Actions with real-world consequences (spending, sending,
  publishing, trading) require explicit operator approval. Policy derives from
  each tool's declared side-effect class.
- **Local-only in v1.** Binds to `127.0.0.1`, no public exposure, no multi-user
  authentication — acceptable *because* the surface is local and
  single-operator. A deliberate temporary decision that must be revisited before
  any remote or networked deployment.
- **Credentials.** API keys are read from the environment at startup, never
  written to the database and never included in event-log payloads.
- **Budget.** Default spend is **£0**, enforced structurally: the default
  provider is local and costs nothing to run. Usage is tracked per model call,
  task and mission from M5 so that any optional cloud usage is visible from the
  moment it is switched on.

## What success looks like

- The operator states an objective in plain language and receives a synthesised,
  verified recommendation without opening another AI tool.
- Several missions run in parallel across different focus areas, and their state
  is legible in one view.
- Adding a new model, agent, or tool is a configuration change, not a rewrite.
- The operator's time shifts from routing work to deciding on results.

## Decisions taken

The questions this document originally left open, and how they were resolved.
Reasoning for each is in the [architecture decision log](architecture.md#decision-log).

| Question | Decision |
| --- | --- |
| Interface form factor | Local web application (React + Vite), served by the API |
| Hosting and access | Local-only, bound to `127.0.0.1`, no authentication in v1 |
| Running cost | **£0 by default.** Local open-weight models are the default provider; paid cloud providers are optional and opt-in |
| Local runtime | **Ollama**, over HTTP on `127.0.0.1:11434`. Chosen for native structured outputs (JSON Schema), token counts in its responses, a native Apple Silicon runner, and because it needs no new npm dependency |
| Initial local model | **Qwen3 8B** class, 4-bit — the exact registry tag to be verified before download. Fits comfortably in 24 GB with headroom, supports schema-constrained output |
| Cloud providers | Anthropic and OpenAI remain as optional adapters behind the same `ModelProvider` contract, registered only when credentials are configured |
| Day-one integrations | Local provider at M1; optional cloud provider available from M5; two read-only tools (`web.search`, `web.fetch`) at M4 |
| Memory | Artifact store scoped by project, with mandatory provenance. No vector database; the context-assembler interface is the seam for one later |
| Approval policy | Derived from each tool's declared side-effect class, plus one mandatory plan-approval gate |
| First proving mission | *"Research whether I should build an AI lead-generation business for heating companies"* — the M7 exit criterion |

No open questions remain in this document.

---

Last updated: 2026-08-15
