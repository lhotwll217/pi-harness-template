---
title: "State and sessions"
summary: "The intended durable truth, session continuity, provenance, transactions, events, and read-only query surface"
read_when:
  - Designing persistence or session lifecycle behavior
  - Deciding what may write durable harness state
  - Tracing resume, fork, recovery, or provenance requirements
  - Working on the query_database tool or schema documentation
---

# State and sessions

> **Status:** Planned behavioral contract. The store is decided; the schema and
> the database's demonstrative function are not.

The harness needs one durable source of truth for configuration state,
onboarding, sessions, schedules, run history, and provenance. State owns that
truth through transactions and migrations; clients and modules do not maintain
competing durable projections.

## State boundary

- One production writer owns the durable store.
- Other modules use a typed State interface rather than private database access.
- Multi-record changes commit atomically when partial success would violate an invariant.
- Schema and contract changes are versioned and migratable.
- Recovery is explicit; startup never silently discards or recreates durable truth.
- Read projections may be cached in memory, but the store remains authoritative.

The concrete store is SQLite through Node's built-in `node:sqlite`, converging
on Owner Operator's choice: zero external dependency, transactional, and a
single file under the harness home. What the template's database
demonstratively stores beyond harness bookkeeping is an open decision.

## Read-only query surface

State also owns a read-only query surface, demonstrated as a `query_database`
agent tool with progressive disclosure, converging on Owner Operator's pattern:

1. **List tables** — names, row counts, and one-line descriptions.
2. **Describe one table** — columns with types, constraints, and descriptions.
3. **Run a bounded `SELECT`** — results capped at a fixed row limit, with an
   explicit truncation flag telling the caller to narrow the query.

Read-only is enforced by the connection itself — the database opens read-only
and any write statement fails — not by statement inspection. Table and column
descriptions come from a git-tracked schema-docs module versioned with the
writers, never from the database file, so the documentation is a reviewed
prompt surface and drift between code and store is visible as an undocumented
column. Alongside the [documentation interface](docs-interface.md), this is one
of the template's two demonstrative self-description primitives.

## Session concepts

The stable vocabulary should support:

- **Create:** start a new Pi session with its own durable identity and transcript.
- **Resume:** continue an existing session without losing its provenance or ordering.
- **Fork:** create a new session whose lineage points to prior context without
  making two writers compete for one transcript.
- **Complete/retain:** close active work while preserving the audit ledger under
  an explicit retention policy.

Operations for one session are serialized. Separate sessions may run
concurrently within global policy.

## Provenance

Every session records its origin: interactive caller, external harness,
scheduled prompt, or another approved surface. Scheduled work also records job
and run identity. Provenance is immutable context attached at session creation
and propagated to tool and command boundaries.

## Events

State publishes typed events only after successful commit. Subscribers treat an
event as an invalidation and refetch current truth. Delivery may be
fail-isolated and best effort because restart reconciliation uses the durable
store, not the event stream, to recover.

## Record families

The database stores the harness's own bookkeeping — configuration/onboarding,
sessions and lineage, schedules, schedule runs, and migration metadata — plus
one worked example. The harness's operational truth is itself the primary
demonstration: querying your own runs and sessions through the read-only
surface is genuinely useful. Columns and indexes belong with the executable
schema and its schema-docs module.

## Worked example: notes

`notes` is a deliberately trivial record family (id, body, timestamps) that
exists to demonstrate the full write-to-read pattern without resembling a
product feature. It has exactly two writers, and they share one State method:

- the `pi-template notes` CLI commands, traversing the Gateway, and
- a `save_note` agent tool in the owned Pi runtime.

Two surfaces, one durable owner. The example shows a State transaction, the
post-commit event, schema-docs entries, and visibility through the read-only
query surface end to end. A product copies this pattern for its real record
families and deletes `notes`.

## Open decisions

- Migration approach on top of `node:sqlite` (must land with the first State
  implementation; recovery is unimplementable without it).
- Transcript format, location, and retention defaults.
- Event delivery guarantees inside one process and across Gateway clients.
