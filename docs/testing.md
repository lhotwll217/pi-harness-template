---
title: "Testing"
summary: "The intended deterministic verification tiers for harness boundaries, recovery, security, and documentation"
read_when:
  - Planning or adding a test
  - Defining acceptance checks for an implementation milestone
  - Verifying architecture and documentation contracts
---

# Testing

> **Status:** The tiered runner (`test/run.mjs`) and default suites are active
> for the implemented modules. The MVP gate below is not yet met.

Default verification must be deterministic, model-free, and isolated from the
owner's real harness home, credentials, sessions, and network. Live paid-model
behavior is opt-in and never part of the default suite.

## Intended tiers

| Tier | Boundary | Default suite |
|---|---|---|
| Documentation | Routing metadata, links, identifiers, generated-catalog drift | Yes |
| Unit | Pure rules and one module contract in isolation | Yes |
| Integration | Several modules with temporary roots and real local adapters | Yes |
| End to end | Daemon, authenticated Gateway, and CLI through ephemeral resources | Yes |
| Smoke | Explicit checks against the developer's live machine | No |
| Live model | Paid provider behavior and qualitative agent checks | No |

## Contract coverage

Future tests should prove:

- Onboarding is resumable, versioned, and fails closed before completion.
- Install, harness-home, workspace, and task roots remain separate.
- State is the only durable production writer and events publish after commit.
- Session create, resume, fork, serialization, provenance, and restart behavior.
- Gateway authentication, transport boundaries, and absence of private module ownership.
- Capability, approval, privacy, and OS sandbox layers fail independently and visibly.
- Scheduler calendar behavior with an injected clock, including time zones and missed runs.
- Global concurrency, same-job no-overlap, timeout, cancellation, process-group cleanup, and crash recovery.
- Scheduled prompts receive fresh sessions and immutable run snapshots.
- Explicit resource loading rejects unintended ambient prompts, skills, or extensions.
- The read-only query surface rejects every write statement, caps result rows,
  and reports schema descriptions from the git-tracked docs, not the database file.
- The documentation interface returns stable identifiers and equivalent JSON
  over either transport.

## Documentation checks

The documentation-only stage can already verify:

- Every durable page has `title`, a one-line `summary`, and nonempty `read_when`.
- Every relative Markdown link resolves.
- Every command or source path is labeled planned unless it exists.
- README routes to the owning page and does not create a conflicting contract.
- Proposed details and open decisions are visibly distinguished from invariants.
- No runtime scaffold, dependency manifest, or generated artifact implies false progress.

## Fixtures and isolation

Integration and end-to-end tests should create fresh temporary harness homes and
workspaces, bind ephemeral ports, inject clocks and executors, and tear down all
processes. Committed fixtures must be sanitized. Promote an inline fixture to a
shared fixture only after more than one test needs it.

## MVP gate

The first implementation is declared done only when all four default tiers are
green, the full acceptance loop passes as an end-to-end test — fresh temporary
harness home, non-interactive onboarding against a fake provider, daemon,
scheduled prompt with a stubbed model, durable run record, then interrogation
through the docs interface and the read-only query surface over the Gateway —
and an opt-in live-model smoke run succeeds on the owner's machine.

## Decided

- Language and runner converge with the port: TypeScript on Node's built-in
  test runner, using Owner Operator's tiered `test/run.mjs` convention.

## Open decisions

- Supported operating systems beyond macOS and their sandbox test strategy.
- Which live behavior deserves a separately gated evaluation suite.
