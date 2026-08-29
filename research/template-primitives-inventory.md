# Template primitives inventory — what exists vs. what a GTM specialty must add

Wayfinder research resolved by local reading of this repository (2026-08-29).
Every claim below is cited as `path:line`. "Implemented" means verified in
source under `src/` or `packages/contracts`; "documented intention" means the
docs describe it but no code backs it yet.

## Summary

The template is a genuinely running MVP, not an outline: state (SQLite +
migrations + post-commit events), a Croner-backed scheduler with durable run
records, a 9-stage fail-closed onboarding machine, four-layer security
(permissions, protected paths, sandbox adapter with verification probe,
headless approval denial), an authenticated loopback Gateway with SSE, a
deterministic docs catalog, and a CLI that traverses the Gateway
(README.md:3-7, docs/porting.md:39-52 — all 12 work packages "Landed"). Two
primitives are thinner than the docs' vocabulary suggests: session lifecycle
(create/resume/fork) and durable provenance records are explicitly still
planned (docs/state-and-sessions.md:13-15), and live state is an
invalidation-only SSE stream, not a data feed. The extension seams a GTM
specialty needs — system prompt, tools, skills, extensions via one explicit
agent definition; record families via the State module — exist and are
demonstrated by the `notes` worked example, but they are all **new code in the
bundle**, not configuration. There is no seam at all for outbound third-party
API integration, third-party secrets, inbound webhooks, or non-loopback
exposure; the sandbox and security posture actively assume a local-only,
network-denied world.

---

## 1. Harness primitives: implemented, and to what depth

### Durable state + sessions — state implemented; sessions/provenance records planned

- **Implemented.** Single-writer `State` class over SQLite (`node:sqlite`),
  ordered migrations with prefix verification, startup recovery that marks
  interrupted runs (src/state/state.ts:48-64, src/state/database.ts:16-25,
  151-183). Schema v1 holds exactly `notes`, `schedules`, `schedule_runs`,
  `schema_migrations` (src/state/database.ts:27-60).
- **Post-commit events**: typed `DomainEvent`s published only after commit via
  an in-process best-effort bus (src/state/state.ts:74, src/state/event-bus.ts:7-14;
  contract in packages/contracts/src/events.ts via packages/contracts/src/index.ts:80-83).
- **Read-only query surface**: `query_database` tool with progressive
  disclosure (list tables → describe → bounded SELECT), read-only enforced by
  the connection, descriptions served from the git-tracked schema-docs module
  (src/state/schema-docs.ts:1-13, src/state/query.ts, src/agent/tools/query-database.ts;
  contract docs/state-and-sessions.md:36-52).
- **Not implemented**: a `sessions` record family, session create/resume/fork
  vocabulary, and durable provenance rows. docs/state-and-sessions.md:13-15
  states "Session lifecycle and provenance records remain planned." Provenance
  for scheduled runs exists but lives in the Pi transcript as a custom entry
  and in the immutable run snapshot, not as a queryable table
  (src/agent/prompt-runner.ts:23-35, 90-91; `payload_snapshot_json` in
  src/state/database.ts:54-60).

### Scheduler — implemented

- Typed facade (start/stop/status/list/add/update/remove/manual run) with
  injected clock, timer, and prompt runner (docs/scheduler.md:11-24,
  src/scheduler/scheduler.ts, src/scheduler/schedule.ts). Croner pinned at
  10.0.1 (package.json:33).
- Triggers `at | every | cron` and payloads `prompt | exact-argv command` are
  in the durable schema with CHECK constraints, optimistic-concurrency
  `revision`, soft delete, and a due-index (src/state/database.ts:34-52).
- Run records carry trigger context, immutable payload snapshot, cwd, and
  bounded 32 KiB output tails (src/state/database.ts:54-60,
  src/state/state.ts:18, 40-46).
- Each prompt occurrence gets a fresh, headless, capability-narrowed Pi
  session with provenance stamped into the transcript
  (src/agent/prompt-runner.ts:129, 86-104).

### Onboarding — implemented

- 9-stage versioned resumable machine: home, auth, model, resources,
  capabilities, protected-paths, sandbox, service, readiness
  (packages/contracts/src/onboarding.ts:7-30); marker written only when every
  stage succeeds, and version mismatch restarts from stage 0
  (packages/contracts/src/onboarding.ts:39-53). Note the docs describe "ten
  stages" (docs/onboarding.md:25-35) — workspace creation is folded into the
  `home` stage in code.
- Entry behavior implemented: bare `pi-template` starts setup on TTY, fails
  closed (`setup-required`, exit 2) non-interactively
  (src/cli/args.ts:41-50, docs/onboarding.md:12-16, 90-116).
- Auth stage: standalone-Pi import (read-only), Pi's built-in provider login,
  manual key fallback, `--no-browser` device-code handoff for agent-driven
  onboarding (docs/onboarding.md:71-81, 103-109; src/agent/onboarding.ts:216-234
  writes to `AuthStorage`).

### Security boundaries — implemented across four separated controls

- Capability posture: `HarnessSettings` with `toolPosture`, `permissionMode`
  (`ask | allow | read-only`, default read-only), `skillPolicy`
  (packages/contracts/src/harness-home.ts:9-27).
- Approval policy: pinned `@gotgenes/pi-permission-system` 20.7.1
  (package.json:34), reconciled from owner settings
  (packages/contracts/src/index.ts:33-41), loaded as an explicit extension in
  the agent definition (src/agent/agent-definition.ts:97-103).
- Privacy: protected paths contract with traversal/symlink/repo-identity
  reasoning (packages/contracts/src/protected-paths.ts, docs/security.md:46-54).
- OS enforcement: `@anthropic-ai/sandbox-runtime` 0.0.65 behind a replaceable
  adapter with a model-free verification probe and a network policy field; no
  stub fallback — onboarding's sandbox stage fails closed
  (src/agent/sandbox/sandbox.ts:16-57, docs/security.md:56-69, package.json:31).
- Headless authority: scheduled prompts run in print mode, so any call
  needing live approval is denied (`approvalPolicy:
  "deny-when-live-approval-is-unavailable"`, src/agent/prompt-runner.ts:34,
  99-102).
- Explicit resource loading: ambient discovery disabled; only the frozen
  `AGENT_DEFINITION` plus explicitly approved workspace skills load
  (src/agent/agent-definition.ts:74-104, src/agent/runtime.ts:50-60,
  docs/security.md:38-44).

### Self-description — implemented (one stale status line)

- Deterministic frontmatter catalog, ranked model-free `docs query`, drift
  tests (src/docs-catalog/, docs/docs-interface.md:12-16). Every docs page
  carries `title`/`summary`/`read_when` routing metadata (e.g.
  docs/architecture.md:1-8).
- Schema self-description via git-tracked `SCHEMA_DOCS` served by the query
  tool (src/state/schema-docs.ts:13).
- Drift note: docs/self-documentation.md:12-14 still says "Runtime transports
  (CLI and Gateway routes) remain planned," contradicted by
  docs/docs-interface.md:12-16 and the implemented routes
  (src/gateway/server.ts:164-181) — stale status, not missing code.

### Public interface — implemented (loopback only)

- Authenticated loopback Gateway: 127.0.0.1 HTTP + SSE, timing-safe bearer
  token (src/gateway/server.ts:70, 99, 139, 239). Routes: health, ready,
  events, doctor, docs list/read/query, notes CRUD, schedules CRUD + run,
  query-database (src/gateway/server.ts:146-229).
- Every data CLI command traverses the Gateway; the CLI auto-starts the
  daemon (docs/docs-interface.md:75-84, src/cli/ensure-daemon.ts). Commands:
  status, doctor, docs, notes, schedule add/list/remove/run, prompt
  (src/cli/args.ts:28-39, 131-145).
- Deliberately scoped: exposing primitives publicly "is a product decision"
  (docs/docs-interface.md:26-31, docs/extensibility.md:94-101).

### Live state for consumers — implemented as invalidation-only SSE

- `GET /events` streams typed Gateway events over `text/event-stream`
  (src/gateway/server.ts:151-162); client subscribes
  (src/gateway/client.ts:119). Contract: events are invalidations — consumers
  refetch current truth; delivery is best-effort and fail-isolated
  (docs/architecture.md:87-91, src/state/event-bus.ts:7,
  docs/state-and-sessions.md:77-80). Cross-client delivery guarantees are an
  open decision (docs/architecture.md:168-170). No app/UI exists; "app" is a
  vocabulary item only (CONTEXT.md "App").

---

## 2. Extension seams for a specialty

The specialty = system prompt + skills + tools + domain data model
(README.md:24-30, CONTEXT.md "Micro harness"). Three seams
(docs/extensibility.md:16-23): Pi resources, application modules behind
contracts, product surfaces.

### System prompt — new bundled file + definition entry

The bundled identity prompt is a `kind: "prompt"` entry in the frozen, ordered
`AGENT_DEFINITION` (src/agent/agent-definition.ts:75-82), read from
src/agent/prompts/pi-template.md and wired into every session surface
(docs/workspace.md:12-16). A GTM harness replaces this file and entry.
Per-owner voice goes in `workspace/AGENTS.md` / `workspace/MEMORY.md` instead
(docs/workspace.md:30-41, packages/contracts/src/harness-home.ts:61-62). The
scheduler can override the system prompt per run
(src/agent/prompt-runner.ts:23 `systemPromptOverride`).

### Tools — new code + definition entry + contract enum

A tool is a factory taking typed dependencies, registered as a `kind: "tool"`
entry (src/agent/agent-definition.ts:83-96) and named in the `AgentToolId`
enum (packages/contracts/src/scheduling.ts via index.ts:56-61). `save_note`
(src/agent/tools/save-note.ts) is the worked pattern: tool → State method →
post-commit event → visible via `query_database`
(docs/state-and-sessions.md:91-103). Adding a GTM tool means: contracts enum,
tool module, `AgentToolDependencies` extension, definition entry, schema-docs
entry — all code changes to the bundle, not configuration.

### Skills — configuration for owner skills; new files for bundled skills

Two channels: bundled `kind: "skill"` definition entries (type exists at
src/agent/agent-definition.ts:37-43; none bundled today) and owner-authored
`workspace/skills/` gated by `skillPolicy` (`bundled` | `all-workspace` |
`allowlist`) — the one genuinely configuration-driven seam
(packages/contracts/src/harness-home.ts:9-13, src/agent/runtime.ts:50-60,
docs/workspace.md:37-45). Pi implements the Agent Skills standard; the
harness must not add a second plugin runtime (docs/extensibility.md:41-55,
docs/architecture.md:126-127). External harnesses are taught by "a small
skill rather than injected tool schemas" (CONTEXT.md "External harness").

### Domain data model — new record family inside State

The prescribed path: copy the `notes` pattern and delete `notes`
(docs/state-and-sessions.md:100-103). Concretely: a migration in `MIGRATIONS`
(src/state/database.ts:23), typed methods on `State` (src/state/state.ts:65+),
a `DomainEventKind`, contracts types (packages/contracts/src/notes.ts as the
model), `SCHEMA_DOCS` entries (src/state/schema-docs.ts), Gateway routes
(src/gateway/server.ts:183-196 pattern) and CLI commands. All new code; the
seam is the layering rule `contracts ← state ← {runtime, scheduler, gateway
server} ← daemon` (docs/architecture.md:74-84), with the daemon as the
composition root choosing adapters (docs/extensibility.md:79-84).

### Configuration vs. new code — the honest split

- **Configuration:** owner workspace (AGENTS.md, MEMORY.md, skills,
  artifacts), skill policy, permission mode, tool posture, protected paths,
  provider/model, sandbox and service choices
  (packages/contracts/src/harness-home.ts:16-27, docs/onboarding.md:110-116).
- **New code (a fork/derivation of the template):** everything that defines
  the specialty — prompt, tools, record families, schema docs, routes, CLI
  verbs, bundled skills. docs/extensibility.md:103-107 lists "How a product
  declares enabled resources without creating another plugin system" as an
  **open decision** — there is no declarative product manifest yet.

### What workspace.md's bundle-vs-workspace split implies for a reusable GTM specialty

The dividing question — "would every owner of this harness want the agent to
behave this way?" (docs/workspace.md:47-53) — explicitly recurses: a product
built on the template judges resources "against that product's owners."
Therefore a reusable GTM specialty is a **bundle**: the GTM prompt, GTM tools
(CRM writes, outreach drafting), GTM record families, and generic GTM skills
belong in the derived product's agent definition, reviewed at onboarding stage
`resources`. A specific company's ICP, tone, territory rules, and named
accounts are **workspace** content the harness creates but never overwrites
(docs/workspace.md:30-41, docs/architecture.md:53-55). Bundled resources are
also deliberately not published as independent packages until a second
consumer exists (docs/extensibility.md:86-92, docs/architecture.md:128-131) —
so "reusable GTM harness" means a template derivation, not an installable
plugin.

---

## 3. Gaps: GTM needs with no seam in the template

1. **Outbound third-party API integrations (CRM, enrichment, email/sequencer
   APIs).** No HTTP-client module, no integration adapter contract, no
   fetch anywhere in src/ except the Gateway's own loopback client
   (src/gateway/client.ts). The only sanctioned outbound call path is the Pi
   model provider. Closest hook: the "application adapter" rule
   (docs/extensibility.md:79-84) and the sandbox `network` policy field
   (src/agent/sandbox/sandbox.ts:16-19), but network defaults for interactive
   and scheduled work are an open decision (docs/security.md:79-83). A GTM
   harness must design the integration seam itself.
2. **Secrets for third-party services.** The credential store is Pi provider
   auth only (`pi/auth.json`, packages/contracts/src/harness-home.ts:66;
   src/agent/onboarding.ts:216-221). The security contract says secrets stay
   under the harness home and out of logs/events (docs/security.md:52-54)
   but provides no vault, no per-service credential records, no
   redaction-aware config surface for e.g. a CRM API key. Onboarding stages
   are a closed enum (packages/contracts/src/onboarding.ts:9-18), so adding a
   "connect your CRM" stage means editing contracts and bumping
   `ONBOARDING_VERSION`.
3. **Inbound webhooks / lead capture.** The Gateway binds 127.0.0.1 only with
   a locally-shared bearer token (src/gateway/server.ts:70, 239); there is no
   public listener, no unauthenticated route class, no webhook signature
   verification, no ingestion queue. Channel bridges are an explicit
   harness-core exclusion (docs/architecture.md:124-125). Event-driven
   triggers do not exist — triggers are time-only (`at | every | cron`,
   src/state/database.ts:37), so "run when a lead arrives" has no primitive;
   the nearest workaround is a polling `every` schedule or an external
   process calling `POST /schedules/:id/run` (src/gateway/server.ts:205-215).
4. **Sessions and cross-run continuity.** Durable session records,
   resume/fork, and queryable provenance are planned, not built
   (docs/state-and-sessions.md:13-15, 54-73). A GTM workflow that spans runs
   (a nurture thread over weeks) can only lean on durable record families it
   defines itself plus `workspace/MEMORY.md`.
5. **Human-in-the-loop approval for headless actions.** Headless runs deny
   anything needing approval (src/agent/prompt-runner.ts:100-102); the
   "separately reviewed headless policy" that could grant, say, "send email to
   qualified leads" (docs/security.md:32-37, docs/scheduler.md:63-66) has
   no implementation — no approval queue, no draft-for-review primitive.
   GTM's send/don't-send decisions need one.
6. **Apps / product UI.** "App" is vocabulary only (CONTEXT.md); UI, widgets,
   and monitoring views are excluded from the core (docs/architecture.md:124).
   The SSE invalidation stream (src/gateway/server.ts:151-162) is the intended
   substrate, and cross-client delivery guarantees remain open
   (docs/architecture.md:168-170); a GTM pipeline/dashboard view is all new
   product surface.
7. **Multi-user / roles.** The model is one owner, one User (CONTEXT.md
   "User"); a GTM team (SDRs + a manager) has no identity, authorization, or
   audit-per-person concept anywhere.
8. **Deferred conveniences a GTM agent would want:** the `schedule_prompt`
   agent tool is explicitly deferred, not ported (docs/porting.md:60-62) — the
   agent cannot schedule its own follow-ups; run-record retention and
   transcript retention are open decisions (docs/scheduler.md:86-88,
   docs/state-and-sessions.md:105-110); macOS launchd is the only always-on
   service platform so far (docs/onboarding.md:129-131).
