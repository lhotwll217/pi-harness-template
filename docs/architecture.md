---
title: "Architecture"
summary: "The intended harness kernel: system boundaries, module ownership, roots, and dependency direction"
read_when:
  - Deciding where future implementation belongs
  - Evaluating whether a capability belongs in the reusable kernel
  - Tracing which module should own a behavior or boundary
---

# Architecture

> **Status:** Intended architecture. Module names and filesystem layout remain
> proposals until implementation begins.

Pi Harness Template is a local-first kernel for Pi-based products. The intended
kernel is responsible for lifecycle, trust, continuity, and automation
primitives. The product using the kernel owns user experience, domain workflows,
and any public surface beyond the explicitly chosen harness interfaces.

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
kernel.

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

Dependencies point toward contracts and owning seams. The daemon supplies
implementations to modules at composition time. Gateway code should receive
interfaces rather than import scheduler, state, or Pi-runtime implementations.

```text
contracts ← {state, Pi runtime, scheduler, Gateway server, Gateway client}
Gateway client ← {CLI, product clients}
{state, Pi runtime, scheduler, Gateway server} ← daemon
```

Scheduler and Gateway depend on injected contracts, not concrete State or
Pi-runtime implementations. The daemon selects and supplies those
implementations at the composition root.

## Durable truth and events

State is the only production writer of durable harness truth. A successful
transaction may publish a typed, fail-isolated event after commit. Events tell
consumers what class of truth changed; consumers refetch the current projection
instead of treating event payloads as another database.

The concrete store is intentionally undecided. Whatever adapter is selected
must preserve transactions, migrations, recovery, and single-writer semantics.
See [State and sessions](state-and-sessions.md).

## Trust boundary

Onboarding must complete before headless or model-driven work is permitted.
Capabilities, approvals, protected data, and operating-system enforcement are
separate controls. Pi resources are loaded from an explicit ordered catalog;
ambient project resources are not automatically trusted. See
[Security](security.md) and [Onboarding](onboarding.md).

## Proposed source map

This map records likely ownership only. It is not an instruction to create empty
directories or a commitment to one package layout.

```text
src/
  contracts/   stable types and pure rules
  state/       durable store adapter and events
  agent/       owned Pi runtime and bundled resources
  scheduler/   triggers, queue, and isolated execution
  gateway/     authenticated protocol and client
  daemon/      composition and lifecycle
  cli/         selected public commands
```

## Kernel exclusions

- Product UI, widgets, channel bridges, monitoring views, and business workflows.
- A second plugin runtime beside Pi extensions.
- A requirement to expose all internal state or behavior publicly.
- Publishing bundled extensions as independent packages. Private extraction may
  be considered after a real second local consumer exists; external publication
  is a separate product decision outside the template.

## Open decisions

- Which Pi lineage and exact version policy the first implementation will use.
- Which durable-store adapter satisfies the state contract with the least local code.
- Which existing sandbox implementation can enforce the required OS boundary.
- Whether the first CLI reads a local catalog directly or always traverses the Gateway.
- The final executable and command names.

## Design references

This design was distilled from the current
[Owner Operator architecture](https://github.com/lhotwll217/owner-operator/blob/0d314721831d2c760c77feb67124859626ddbd47/docs/architecture.md)
and Pi integration practices. It adopts ownership patterns, not Owner Operator's
product behavior or source code. Scheduler-specific provenance lives with the
[scheduler contract](scheduler.md#design-references).
