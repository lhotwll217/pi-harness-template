# Pi Harness Template

> **Status:** MVP. All modules are implemented, all four test tiers are green
> including the end-to-end acceptance loop, and the live-model smoke has run on
> a real machine: onboarding, a scheduled prompt through a fresh isolated Pi
> session, and interrogation of the resulting durable truth
> ([porting](docs/porting.md)).

A **micro harness** is a specialized agent together with the harness built for
it — a system prompt, skills, tools, and a domain data model — shared across
external consumers and shown to its user
through purpose-built apps.

This repository is a running example of one, built on the
[Pi agent ecosystem](https://pi.dev/). Its specialty is teaching how to build a
micro harness by being one: start it, ask how a harness works, and it answers
by routing you through its own code and documentation. Every part exists to be
read, run, and copied.

## Concepts

An **agent** is the autonomous actor and the identity a **user** deals with. A
**harness** is the infrastructure, context system, and environment purpose-built
to enable it. What makes an agent a specialist is its **system prompt**,
**specialized skills**, **specialized tools**, and **domain data model** — its
**specialty**. What makes a specialty dependable is the harness beneath it.

Everything outside the micro harness is an **external consumer** — a person at
a terminal, a script, an **app**, another agent, another **harness** — and each
reaches the harness through its **public interface**. No consumer gets a
privileged path in, including the harness's own agent.

Pinned definitions live in [`CONTEXT.md`](CONTEXT.md).

## Why build one

Most agent work does not need a micro harness. A general harness with a
dedicated workspace folder and a few local skills is often enough, and costs
almost nothing to set up.

Reach for a micro harness when that is not enough:

- **You need a durable system of record with depth** — state that can be
  queried and audited reliably, not reconstructed from files and transcripts.
- **You want the agent to perform specialized actions** — operations that are
  complex and may have side effects, like updating the system of record.
- **You want the agent always on** — ready to be triggered by an event or a
  schedule to perform specialized actions with no one present.
- **You want external consumers** — a custom app or UI, a script, another
  agent — interacting with the system of record or using the specialized
  actions.

## Using it

```bash
pi-template                     # interactive; starts setup when needed
pi-template status              # harness state, no model call
pi-template docs list           # every page with summary and read-when hints
pi-template docs query "..."    # ranked pages and a bounded reading plan
pi-template notes add "..."     # durable state; see docs/state-and-sessions.md
pi-template schedule add ...    # durable schedules; see docs/scheduler.md
```

The same operations back every consumer, and a read-only `query_database` tool
gives an agent progressive access to durable state — list tables, describe one,
run a bounded `SELECT` — without opening the database file.

## Architecture

The daemon composes modules and owns process lifecycle, not product behavior.
State has one durable production writer. The authenticated loopback Gateway
translates transport and owns no durable state, process execution, or model
behavior. Pi resources are loaded explicitly instead of being trusted
ambiently.

The complete ownership map and dependency direction live in
[Architecture](docs/architecture.md).

## Documentation

Each page owns one surface and carries routing metadata, so people and agents
can decide what to read without loading the whole repository.

- [Architecture](docs/architecture.md) — system boundaries and ownership.
- [Onboarding](docs/onboarding.md) — versioned, resumable setup.
- [Security](docs/security.md) — capabilities, approvals, privacy, and sandboxing.
- [State and sessions](docs/state-and-sessions.md) — durable truth and continuity.
- [Scheduler](docs/scheduler.md) — durable isolated prompt and command runs.
- [Extensibility](docs/extensibility.md) — Pi-native extension seams.
- [Workspace](docs/workspace.md) — bundled capability versus owner-authored opinion.
- [Self-documentation](docs/self-documentation.md) — how the repository teaches itself.
- [Documentation interface](docs/docs-interface.md) — the public docs surface.
- [Testing](docs/testing.md) — verification tiers and contracts.

Ported from proven
[Owner Operator](https://github.com/lhotwll217/owner-operator) modules and
OpenClaw patterns. The port plan, decision ledger, and work-package history
live in [Porting](docs/porting.md).
