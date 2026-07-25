# Pi Harness Template

> **Status:** MVP. All modules are implemented, all four test tiers are green
> including the end-to-end acceptance loop, and the live-model smoke has run on
> a real machine: onboarding, a scheduled prompt through a fresh isolated Pi
> session, and interrogation of the resulting durable truth
> ([porting](docs/porting.md)).

A **micro harness** is a specialized agent together with the harness built for
it — a system prompt, skills, tools, and a domain data model on a core of
harness primitives — shared across external consumers and shown to its user
through purpose-built apps.

This repository is a running example of one, built on the
[Pi agent ecosystem](https://pi.dev/). Its specialty is teaching how to build a
micro harness by being one: start it, ask how a harness works, and it answers
by routing you through its own code and documentation. Every primitive exists
to be read, run, and copied.

## Concepts

An **agent** is the autonomous actor and the identity a **user** deals with. A
**harness** is the infrastructure, context system, and environment purpose-built
to enable it. What makes an agent a specialist is its **system prompt**,
**specialized skills**, **specialized tools**, and **domain data model** — its
**specialty**. What makes a specialty dependable is the **harness primitives**
beneath it.

Everything outside the micro harness is an **external consumer** — a person at
a terminal, a script, an **app**, another agent, another **harness** — and each
reaches the harness through its **public interface**. No consumer gets a
privileged path in, including the harness's own agent.

Pinned definitions live in [`CONTEXT.md`](CONTEXT.md).

## Why build one

Most agent work does not need a micro harness. A normal harness with a
workspace folder and a few local skills is often enough, and costs almost
nothing to set up.

Reach for a micro harness when one of these holds:

- **The domain needs a real data model.** State with relationships, rules that
  must hold across records, or history that matters — a trip and the
  accommodations under it, each with a status and dates that have to fall
  inside the trip's window. Files and transcripts cannot enforce that; a schema
  can.
- **The work has to be always on.** Something must run when nobody is watching,
  on a schedule or a trigger, and leave a durable record rather than a message
  in a thread someone has to find.

If neither holds, use a folder and some skills. If both do, the primitives here
are the parts you would otherwise rediscover.

## Harness primitives

The capabilities any specialty depends on and none should reinvent:

- **Durable state and sessions**, with provenance.
- **Scheduled runs**, each in a fresh isolated session with a durable run
  record.
- **Onboarding** that is versioned, resumable, and fails closed.
- **Explicit security boundaries** — capabilities, approvals, privacy policy,
  and operating system enforcement kept separate.
- **Self-description**, so the harness can explain itself to a person or an
  agent.
- **A public interface**, so anything outside can discover what the harness
  does and ask it, in whatever form suits the consumer.
- **Live state for consumers**, so an app subscribes to change instead of
  polling and stays current while owning no behavior of its own.

What you write on top is the specialty.

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
