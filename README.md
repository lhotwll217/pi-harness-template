# Pi Harness Template

> **Status:** Architecture and documentation scaffold. No runtime implementation exists yet.

Pi Harness Template is a reusable, self-documenting foundation for building a
local-first application harness around the [Pi agent ecosystem](https://pi.dev/).
It captures the parts that every serious Pi-based product would otherwise need
to rediscover: daemon lifecycle, an authenticated Gateway, onboarding,
permissions and sandboxing, durable state and sessions, scheduling, and
verification.

It is also meant to teach. A coding agent entering the repository should be able
to discover the design progressively, identify the owner of each behavior, and
see which decisions remain open before implementation begins.

## Goals

- Provide a small, production-oriented harness kernel around Pi.
- Keep product behavior outside the kernel.
- Separate stable contracts from replaceable adapters.
- Make trust boundaries explicit and fail closed before onboarding completes.
- Preserve durable state, sessions, provenance, and scheduled-run history.
- Make architectural knowledge discoverable by humans and agents.
- Demonstrate one machine-readable public primitive through documentation
  discovery.

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

The intended kernel has a few hard boundaries:

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

The planned example public interface is:

```text
harness docs list
harness docs read <id>
harness docs query <question>
```

These commands are not implemented. They demonstrate how this harness could
make one of its own primitives available to another harness or coding agent.
Surfacing harness primitives through a command-line interface for external
agents can be valuable, but **doing this is a product decision**.

## Documentation

- [Architecture](docs/architecture.md) — system boundaries and ownership.
- [Onboarding](docs/onboarding.md) — versioned, resumable setup.
- [Security](docs/security.md) — capabilities, approvals, privacy, and sandboxing.
- [State and sessions](docs/state-and-sessions.md) — durable truth and continuity.
- [Scheduler](docs/scheduler.md) — durable isolated prompt and command runs.
- [Extensibility](docs/extensibility.md) — Pi-native extension seams.
- [Self-documentation](docs/self-documentation.md) — how the repository teaches itself.
- [Documentation interface](docs/docs-interface.md) — the planned public docs surface.
- [Testing](docs/testing.md) — intended verification tiers and contracts.

## Implementation status

This repository currently records intent and architectural constraints only.
The documentation labels proposed details and open decisions explicitly. Runtime
work should begin only after the relevant open decisions are resolved and the
documentation is revised to describe the chosen contract.
