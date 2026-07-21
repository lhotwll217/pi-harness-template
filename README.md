# Pi Harness Template

> **Status:** MVP. All modules are implemented, all four test tiers are green
> including the end-to-end acceptance loop, and the live-model smoke has run on
> a real machine: onboarding, a scheduled prompt through a fresh isolated Pi
> session, and interrogation of the resulting durable truth
> ([porting](docs/porting.md)).

Pi Harness Template is a **running, demonstrative template**: a functional,
self-documenting local-first harness built around the
[Pi agent ecosystem](https://pi.dev/). It captures the parts that every serious
Pi-based product would otherwise need to rediscover: daemon lifecycle, an
authenticated Gateway, onboarding, permissions and sandboxing, durable state and
sessions, scheduling, and verification.

Being demonstrative is the point. Every primitive exists to be read, run, and
copied. The harness documents itself with code and can document itself at
runtime: start it and ask how to build a harness, and it answers by routing you
through its own code and documentation — for example through the docs CLI or
the read-only database query tool. A coding agent entering the repository should
be able to discover the design progressively, identify the owner of each
behavior, and see which decisions remain open.

## Goals

- Provide a small, production-oriented, working harness around Pi.
- Demonstrate every primitive with running code that a product can copy.
- Keep product behavior outside the harness core.
- Separate stable contracts from replaceable adapters.
- Make trust boundaries explicit and fail closed before onboarding completes.
- Preserve durable state, sessions, provenance, and scheduled-run history.
- Make architectural knowledge discoverable by humans and agents — from the
  repository and from the running harness itself.
- Demonstrate machine-readable self-description through documentation discovery
  and a read-only database query tool.

## Non-goals

- Building a second plugin system alongside Pi extensions.
- Publishing bundled extensions as independent packages. Private extraction may
  be considered after a real second local consumer exists; external publication
  is a separate product decision outside the template.
- Prescribing a web UI, widget, channel bridge, or product-specific workflow.
- Automatically exposing every internal primitive through a public CLI.
- Reimplementing maintained Pi or open-source capabilities without a documented
  reason.

## Architecture at a glance

```text
human · coding agent · future product surface
                    │
          CLI / Gateway boundary
                    │
        daemon: composition + lifecycle
                    │
       ┌────────────┼────────────┐
     state       scheduler     Pi runtime
       │              │            │
 sessions +       isolated      tools, skills,
 provenance         runs        extensions
```

The intended harness core has a few hard boundaries:

- The daemon composes modules and owns process lifecycle, not product behavior.
- The authenticated loopback Gateway translates transport; it owns no durable
  state, process execution, or model behavior.
- State has one durable production writer. Post-commit events wake consumers;
  they are not a second source of truth.
- Pi resources are loaded explicitly instead of being trusted ambiently.
- Security separates capabilities, approvals, privacy policy, and operating
  system enforcement.
- Each scheduled prompt run receives a fresh isolated session and a durable run
  record.

The complete ownership map and dependency direction live in
[Architecture](docs/architecture.md).

## Self-documenting template

Durable behavior knowledge lives under [`docs/`](docs/). Each page owns one
surface and carries routing metadata so people and agents can decide what to
read without loading the whole repository.

The template's own demonstrative surface is self-description, in two planned
machine-readable primitives:

```text
pi-template docs list
pi-template docs read <id>
pi-template docs query <question>
```

plus a read-only `query_database` agent tool with progressive disclosure
(list tables → describe one → run a bounded `SELECT`). Together they let a
coding agent inspect the harness's documentation and durable state without
loading the whole repository or opening the database file.

Which primitives to expose publicly is a **product decision** — the template
decides it for itself as a demonstration; a product built on this harness makes
its own call. See [Documentation interface](docs/docs-interface.md) and
[State and sessions](docs/state-and-sessions.md).

## Documentation

- [Architecture](docs/architecture.md) — system boundaries and ownership.
- [Onboarding](docs/onboarding.md) — versioned, resumable setup.
- [Security](docs/security.md) — capabilities, approvals, privacy, and sandboxing.
- [State and sessions](docs/state-and-sessions.md) — durable truth and continuity.
- [Scheduler](docs/scheduler.md) — durable isolated prompt and command runs.
- [Extensibility](docs/extensibility.md) — Pi-native extension seams.
- [Workspace](docs/workspace.md) — bundled capability versus owner-authored opinion.
- [Self-documentation](docs/self-documentation.md) — how the repository teaches itself.
- [Documentation interface](docs/docs-interface.md) — the planned public docs surface.
- [Testing](docs/testing.md) — intended verification tiers and contracts.

## Implementation status

All modules are implemented — contracts, State, scheduler, agent (Pi runtime,
onboarding, sandbox adapter, tools), Gateway, daemon, docs catalog, and the
`pi-template` CLI — ported from proven
[Owner Operator](https://github.com/lhotwll217/owner-operator) modules and
OpenClaw patterns, with all four default test tiers green including the
end-to-end acceptance loop. Declaring MVP awaits the opt-in live-model smoke
run on the owner's machine. The port plan, decision ledger, and work-package
history live in [Porting](docs/porting.md).
