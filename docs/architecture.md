---
title: "Architecture"
summary: "The intended harness core: system boundaries, module ownership, roots, and dependency direction"
read_when:
  - Deciding where future implementation belongs
  - Evaluating whether a capability belongs in the reusable harness core
  - Tracing which module should own a behavior or boundary
---

# Architecture

> **Status:** Intended architecture. Module names and filesystem layout remain
> proposals until implementation begins.

Pi Harness Template is a local-first harness core for Pi-based products. The
harness core is responsible for lifecycle, trust, continuity, and automation
primitives, and every module doubles as a demonstration a product can copy. The
product using the harness owns user experience, domain workflows, and any public
surface beyond the explicitly chosen harness interfaces. The template's own
chosen surface is self-description: the
[documentation interface](docs-interface.md) and the read-only
[database query surface](state-and-sessions.md#read-only-query-surface).

## System boundary

```text
human · coding agent · product client
                  │
        CLI / authenticated Gateway
                  │
     daemon: composition + process lifecycle
                  │
  ┌───────────────┼───────────────┐
state          scheduler       Pi runtime
durable truth  time + runs      agent sessions
```

The daemon is a process boundary and composition root, not a domain layer. The
Gateway is a transport adapter, not a second application core. Product-specific
interfaces may use the Gateway client without moving their behavior into the
harness core.

## Runtime roots

Code and mutable agent state have different owners:

| Root | Intended responsibility |
|---|---|
| Install root | Executable code and bundled prompts, tools, skills, and extensions |
| Harness home | Configuration, credentials, durable state, transcripts, logs, and daemon files |
| Agent workspace | Persistent owner instructions, memory, artifacts, and workspace skills |
| Task working directory | Files and commands targeted by one interactive or scheduled run |

Entry points may create missing harness-owned files, but must not overwrite
owner-authored workspace content.

## Module ownership

These are conceptual seams, not approved package paths:

| Module | Owns | Does not own |
|---|---|---|
| Contracts | Shared types, pure rules, wire shapes, configuration boundaries | Database, network, timers, processes, model calls |
| State | Durable schema, transactions, migrations, projections, post-commit events | Timers, transport, model calls |
| Pi runtime | Explicit resource loading, agent sessions, tools, skills, permissions integration | Global timers, direct durable-state writes |
| Scheduler | Trigger evaluation, execution policy, isolated runs, run history through State | Gateway transport, private database access |
| Gateway | Authenticated loopback protocol and client translation | Durable ownership, child processes, timers, model behavior |
| Daemon | Composition, readiness, discovery, process and shutdown lifecycle | Product decisions or duplicated domain rules |
| CLI | Human- and agent-facing commands over stable contracts | Durable state, privileged runtime access, or product behavior |

Dependencies point toward contracts and owning seams, following the layering
proven in Owner Operator:

```text
contracts ← state ← {Pi runtime, scheduler, Gateway server} ← daemon
contracts ← Gateway client ← {CLI, product clients}
```

State is the one concrete module other application modules may import; the
scheduler and Pi runtime persist through the typed State interface rather than
private database access. The Gateway server receives module interfaces from the
daemon at composition time and does not import scheduler, state, or Pi-runtime
implementations. The daemon selects and supplies concrete adapters at the
composition root.

## Durable truth and events

State is the only production writer of durable harness truth. A successful
transaction may publish a typed, fail-isolated event after commit. Events tell
consumers what class of truth changed; consumers refetch the current projection
instead of treating event payloads as another database.

The concrete store is SQLite through Node's built-in `node:sqlite`, converging
on Owner Operator's choice: zero external dependency, transactional, and
single-file. The adapter must preserve transactions, migrations, recovery, and
single-writer semantics. What the template's database demonstratively stores
remains an open decision. See [State and sessions](state-and-sessions.md).

## Trust boundary

Onboarding must complete before headless or model-driven work is permitted.
Capabilities, approvals, protected data, and operating-system enforcement are
separate controls. Pi resources are loaded from an explicit ordered catalog;
ambient project resources are not automatically trusted. See
[Security](security.md) and [Onboarding](onboarding.md).

## Source map

`packages/contracts` is implemented; the `src/` modules are planned and land in
[porting](porting.md) order.

```text
packages/
  contracts/   stable types, pure rules, wire shapes, config readers (implemented)
src/
  state/       durable store adapter and events (planned)
  agent/       owned Pi runtime and bundled resources (planned)
  scheduler/   triggers, queue, and isolated execution (planned)
  gateway/     authenticated protocol and client (planned)
  daemon/      composition and lifecycle (planned)
  cli/         selected public commands (planned)
```

## Harness-core exclusions

- Product UI, widgets, channel bridges, monitoring views, and business workflows.
- A second plugin runtime beside Pi extensions.
- A requirement to expose all internal state or behavior publicly.
- Publishing bundled extensions as independent packages. Private extraction may
  be considered after a real second local consumer exists; external publication
  is a separate product decision outside the template.

## Adopted by convergence

Decisions already proven in Owner Operator and OpenClaw are adopted rather than
reopened:

- Pi lineage: the `@earendil-works` Pi toolkit (`pi-ai`, `pi-coding-agent`,
  `pi-tui`) plus the `@gotgenes/pi-permission-system`, pinned at port time.
- Durable store: SQLite via Node's built-in `node:sqlite`.
- Gateway transport: loopback (`127.0.0.1`) HTTP + SSE with timing-safe
  bearer-token authentication, as in Owner Operator's gateway and following
  OpenClaw's authenticated-loopback-gateway posture.
- Scheduler seam: one typed service facade shared by the Gateway and tests, in
  the style of OpenClaw's `CronServiceContract`; calendar math via Croner.
- Run history: durable run records live in SQLite through State (Owner
  Operator's pattern), rejecting OpenClaw's separate JSONL run log to preserve
  the single-durable-writer rule.
- Docs catalog: a deterministic frontmatter parser in the OpenClaw
  `docs-list` style (see [Self-documentation](self-documentation.md)).

## Decided

- Naming: executable `pi-template`, packages `@pi-template/*`, harness home
  `~/.pi-template/`.
- Every CLI command traverses the Gateway; there is no direct-filesystem CLI
  path. Model-free docs routes are served before onboarding completes under the
  fail-closed rule's diagnostics exception.
- The database stores harness bookkeeping plus one deliberately trivial
  `notes` worked example (see
  [State and sessions](state-and-sessions.md#worked-example-notes)).
- OS sandbox enforcement adopts `@anthropic-ai/sandbox-runtime` behind the
  replaceable adapter (see [Security](security.md#sandbox-adapter-boundary)).

## Open decisions

- Initial global concurrency, queue fairness, and retention defaults
  (owned by [Scheduler](scheduler.md)).
- Event delivery guarantees across Gateway clients
  (owned by [State and sessions](state-and-sessions.md)).

## Design references

This design was distilled from the current
[Owner Operator architecture](https://github.com/lhotwll217/owner-operator/blob/0d314721831d2c760c77feb67124859626ddbd47/docs/architecture.md)
and Pi integration practices. It adopts ownership patterns, not Owner Operator's
product behavior or source code. Scheduler-specific provenance lives with the
[scheduler contract](scheduler.md#design-references).
