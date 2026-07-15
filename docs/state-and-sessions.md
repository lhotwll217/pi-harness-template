---
title: "State and sessions"
summary: "The intended durable truth, session continuity, provenance, transactions, and event model"
read_when:
  - Designing persistence or session lifecycle behavior
  - Deciding what may write durable harness state
  - Tracing resume, fork, recovery, or provenance requirements
---

# State and sessions

> **Status:** Planned behavioral contract. No schema or store has been selected.

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

The concrete database is an adapter choice, not part of this first scaffold.

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

## Proposed record families

The likely record families are configuration/onboarding, sessions and lineage,
schedules, schedule runs, and migration metadata. These are concepts, not a
schema commitment; columns and indexes belong with the future executable schema.

## Open decisions

- Database and migration library.
- Transcript format, location, and retention defaults.
- Event delivery guarantees inside one process and across Gateway clients.
