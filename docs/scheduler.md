---
title: "Scheduler"
summary: "The planned durable scheduler for isolated prompts and exact-argument commands"
read_when:
  - Designing schedule triggers, execution, concurrency, or recovery
  - Connecting scheduled work to State, the daemon, or the Pi runtime
  - Defining deterministic scheduler tests
---

# Scheduler

> **Status:** Implemented (`src/scheduler`) behind the typed facade, with an
> injected clock, timer, and prompt runner. The real Pi prompt runner arrives
> with the agent module.

Scheduling is a harness-core primitive because time, durable state, permissions,
process cleanup, and crash recovery are difficult to retrofit safely. State owns
schedule and run records. The scheduler owns time and execution. The daemon owns
lifecycle. The Gateway exposes only the selected protocol surface.

The scheduler presents one typed service facade — start, stop, status, list,
add, update, remove, and manual run — consumed by the Gateway and by tests, in
the style of OpenClaw's pinned `CronServiceContract`. Callers never reach past
the facade into timers, the queue, or State. Calendar evaluation uses Croner,
converging on Owner Operator's scheduler.

## Vocabulary

- **Trigger:** one-time `at`, interval `every`, or timezone-aware `cron`.
- **Payload:** a Pi prompt or an exact argument-vector command.
- **Run context:** absolute task directory, timeout, immutable schedule snapshot,
  trigger occurrence, capability selection, and provenance.
- **Run record:** durable lifecycle, timestamps, outcome, bounded output, error,
  and missed-run context.

A direct command executes exact arguments without an implicit shell. A caller
that deliberately wants shell semantics must request a shell executable and its
arguments explicitly.

## Prompt isolation

Each prompt occurrence creates a fresh Pi session and transcript. Scheduled
runs do not resume an interactive session implicitly. The immutable run snapshot
records the prompt, model/resource selection, task directory, timeout, and tool
allowlist used for that occurrence.

## Execution policy

- Global concurrency begins conservatively and remains configurable.
- The same job never overlaps itself.
- One-time jobs that become overdue run at most once.
- Recurring jobs skip backlog and record the chosen missed-run policy.
- Trigger advancement and creation of the running record commit before external work starts.
- Manual triggers create ordinary durable runs and obey the same policy.
- Timeouts and cancellation abort prompt work and terminate command process groups.
- Daemon shutdown stops new dispatch, cancels or drains according to policy, and
  closes State only after active ownership is resolved.
- Startup marks previously running work interrupted and does not retry it blindly.
- Disabling or deleting a schedule prevents future occurrences but does not
  silently redefine an already-running snapshot.

## Permissions

Scheduled prompts are headless. Their tool set is explicitly narrowed,
and any operation that needs interactive approval is denied unless onboarding
established a separate reviewed headless rule. The task directory may supply
trusted task policy subject to the global security contract.

## Determinism

Calendar evaluation and wakeups receive an injected clock. Queue and executor
boundaries are injectable so tests can prove daylight-saving behavior,
concurrency, timeout, shutdown, and crash recovery without waiting on wall time
or calling a model.

Prompt and exact-argument command payloads both ship in the first
implementation: command runs are what exercise the demonstrative process
hygiene — timeouts, process-group termination, and no implicit shell.

## Decided

- Global concurrency defaults to 1 and is configurable.
- Missed-run policy defaults to skip, with missed timing and count durably
  recorded on the run.
- Shutdown defaults to drain.

## Open decisions

- Run-record retention.

## Design references

The intended seam follows OpenClaw's small, explicit
[cron service contract](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/cron/service-contract.ts#L27-L45),
[timezone-aware schedule adapter](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/cron/schedule.ts#L13-L55),
and rule that each isolated scheduled prompt receives a
[fresh session](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/docs/automation/cron-jobs.md#L203-L220).
These are adopted design patterns, not copied product behavior or code. Run
records persist through State in SQLite (Owner Operator's pattern) rather than
OpenClaw's separate JSONL run log, preserving the single durable writer.
