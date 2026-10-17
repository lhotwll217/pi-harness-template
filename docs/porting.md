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

The MVP ports proven modules from a local checkout of
[Owner Operator](https://github.com/lhotwll217/owner-operator) (OO) into this
repository, renamed and pruned.
OpenClaw patterns arrive already embedded in that code or via the pinned
references on the owning pages.

## MVP acceptance

On a fresh machine: clone → onboard (all ten stages) → daemon up → schedule a
prompt → the run executes in a fresh Pi session and lands as a durable run
record in SQLite → interrogate the harness through `pi-template docs
list/read/query` and `pi-template db`, over the Gateway. Declared done
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
| 6 | Agent | `src/agent` (runtime, onboarding, doctor, `query_database`, new `save_note`; both retired by 19), sandbox adapter | [Onboarding](onboarding.md), [Security](security.md) | Landed |
| 7 | CLI + composition | `src/cli`, `src/daemon` completion | [Architecture](architecture.md) | Landed |
| 8 | Acceptance e2e + live smoke | new | [Testing](testing.md) | Landed; live smoke passed on the owner's machine |
| 9 | Onboarding entry + built-in login | drift correction toward OO's `oo.ts` entry; pi-ai OAuth registry | [Onboarding](onboarding.md#entry-behavior) | Landed |
| 10 | Consolidated setup, no OO knowledge | one review surface; standalone-Pi-only import; forbidden-text gate | [Onboarding](onboarding.md#entry-behavior) | Landed |
| 11 | Interactive session | OO's `interactive.ts` front door over the owned runtime | [Onboarding](onboarding.md#entry-behavior) | Landed |
| 12 | Bundled identity prompt | OO's `ownerOperatorPrompt` pattern; agent-definition `kind: prompt` | [Workspace](workspace.md) | Landed |

Packages 2, 3, and 4 may run in parallel once 1 lands; 5 needs 4; 6 needs 4 and
5; 7 ties the seams; 8 gates the whole.

### Alignment with derived harnesses

[Stitcher](https://github.com/lhotwll217/stitcher) and OO were derived from this
template and improved after July 2026. These packages bring the generic
improvements back under [#15](https://github.com/lhotwll217/pi-harness-template/issues/15). Each row names prior art to read, not a design to copy.

| # | Package | Prior art | Key contract | Status |
|---|---|---|---|---|
| 14 | Pi 1.3.0 | Stitcher `738470f`, `08ca36b`, `0cb445f`, `4671f75` | [Architecture](architecture.md) | Landed |
| 15 | Allow by default; sandbox opt-in, off by default | Stitcher `37b827f`, `7ef75b9`, `18ad6af` | [Security](security.md), [Onboarding](onboarding.md) | Landed |
| 16 | AGENTS.md alone; workspace skills by default; vendored harness skills | Stitcher `a00e3fc`, `085921c`; OO `src/agent/skills.ts`, `10fae0d` | [Workspace](workspace.md), [Extensibility](extensibility.md) | Landed |
| 17 | One command registry; JSON output; read-only `db` noun | Stitcher `595ac4d`, `f0ba616`, `914a47b`, `75db0d9`, `1f63ce4`, `81f9189` | [Documentation interface](docs-interface.md), [State and sessions](state-and-sessions.md) | Landed |
| 18 | System prompt generated from the help tree and schema | OO `52fa55f` (PR #187) | [Self-documentation](self-documentation.md) | Landed |
| 19 | The agent uses its own CLI; `query_database` and `save_note` retired | Stitcher `0a261ec`, `37b827f`, ADR 0001; OO `cf8ba7b` | [State and sessions](state-and-sessions.md), [Security](security.md) | Landed |
| 20 | Daemon recovery from stale discovery | OO `039359a`, `643f99d`, `b548896`, `7e1aa60` | [Architecture](architecture.md) | Landed |
| 21 | Chats and workspace files over the Gateway, with live events | Stitcher `3fa5d16`, `224c4fe`, `6eda897`, `07dbb75`, `a31b7f2` | [Architecture](architecture.md), [Workspace](workspace.md) | Landed |
| 22 | Generic web chat app | Stitcher `apps/web`, without pronunciation, assessment, and vocabulary parts | [Web app](web-app.md) | Landed |

14 is first. 15, 17, and 20 need 14. 16 needs 15; 18 needs 17; 19 needs 16 and
18; 21 needs 19; 22 needs 21.

## Pruning rules

- No product behavior: OO's session-monitor, widget, session-search vendor,
  thread/enrichment record families and schema docs, and the `session_state`
  tool do not port. OO's `schedule_prompt` tool is deferred, not ported.
- No product vocabulary may survive in `@pi-template/*` — `thread`,
  `enrichment`, and other chief-of-staff terms are a CI grep failure in
  contracts.
- Every `@owner-operator` identifier, `oo` binary reference, and
  `~/.owner-operator` path is renamed at port time, not in a later pass. No
  exceptions: the running harness knows nothing about Owner Operator — it is
  the porting source, never a runtime dependency or data source. The only
  external installation onboarding may read is the global standalone Pi
  install's own files.

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
