---
title: "Porting"
summary: "The active plan, work packages, and rules for porting Owner Operator modules to the pi-template MVP"
read_when:
  - Executing or reviewing a port work package
  - Deciding what an in-flight module may and may not touch
  - Checking the definition of done for a ported module
---

# Porting

> **Status:** Active work plan. This page owns port process only; behavior
> contracts live with their owning pages and win on any conflict.

The MVP ports proven modules from the local Owner Operator checkout at
`~/Development/owner-operator` (OO) into this repository, renamed and pruned.
OpenClaw patterns arrive already embedded in that code or via the pinned
references on the owning pages.

## MVP acceptance

On a fresh machine: clone → onboard (all ten stages) → daemon up → schedule a
prompt → the run executes in a fresh Pi session and lands as a durable run
record in SQLite → interrogate the harness through `pi-template docs
list/read/query` and the `query_database` tool, over the Gateway. Declared done
per the [testing MVP gate](testing.md#mvp-gate).

## Fixed identity

- Executable `pi-template`, packages `@pi-template/*`, home `~/.pi-template/`.
- Pi lineage, store, transport, scheduler seam: see
  [architecture — adopted by convergence](architecture.md#adopted-by-convergence).

## Port order and work packages

Gateway-first: modules land behind their real authenticated transport.

| # | Package | Ports from OO | Key contract | Status |
|---|---|---|---|---|
| 1 | Scaffold + contracts | `packages/core`, pruned | [Architecture](architecture.md) | Landed |
| 2 | Daemon + Gateway skeleton | `src/daemon`, `src/gateway` (auth + readiness routes only) | [Architecture](architecture.md) | Landed |
| 3 | Docs catalog + routes + drift checks | `scripts/docs-list.mjs`, new catalog + `docs` routes | [Documentation interface](docs-interface.md), [Self-documentation](self-documentation.md) | Landed (routes with WP7) |
| 4 | State | `src/state` machinery; new `notes` example; migrations | [State and sessions](state-and-sessions.md) | Landed |
| 5 | Scheduler | `src/scheduler` | [Scheduler](scheduler.md) | Landed |
| 6 | Agent | `src/agent` (runtime, onboarding, doctor, `query_database`, new `save_note`), sandbox adapter | [Onboarding](onboarding.md), [Security](security.md) | Landed |
| 7 | CLI + composition | `src/cli`, `src/daemon` completion | [Architecture](architecture.md) | Landed |
| 8 | Acceptance e2e + live smoke | new | [Testing](testing.md) | Acceptance landed; live smoke awaits the owner |

Packages 2, 3, and 4 may run in parallel once 1 lands; 5 needs 4; 6 needs 4 and
5; 7 ties the seams; 8 gates the whole.

## Pruning rules

- No product behavior: OO's session-monitor, widget, session-search vendor,
  thread/enrichment record families and schema docs, and the `session_state`
  tool do not port. OO's `schedule_prompt` tool is deferred, not ported.
- No product vocabulary may survive in `@pi-template/*` — `thread`,
  `enrichment`, and other chief-of-staff terms are a CI grep failure in
  contracts.
- Every `@owner-operator` identifier, `oo` binary reference, and
  `~/.owner-operator` path is renamed at port time, not in a later pass.

## Definition of done (per package)

1. Tests green in every tier the package touches; deterministic and model-free
   by default.
2. The owning docs page is updated in the same change: status flipped from
   planned to implemented for exactly what landed, nothing more.
3. Zero TODO/FIXME/stub markers; no placeholder routes (a Gateway route lands
   only with its owning module).
4. Boundary tests port with their module (e.g. OO's
   `gateway.boundaries.test.ts`).
5. Reviewed and merged by the integrator; work-package agents never merge.

## Execution protocol for work-package agents

- Work in the assigned git worktree and branch only; never commit to `main`.
- Read this page, then the key contract pages for the package, before writing
  code. Contracts win over ported code on conflict.
- Do not widen scope: no new tools, routes, dependencies, or record families
  beyond the package table. Propose instead.
- Preserve OO's test style and comment density; port tests alongside code.
- If a contract page and OO's code disagree and the resolution is not obvious,
  stop and report rather than guessing.
