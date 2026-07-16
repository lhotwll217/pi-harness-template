---
title: "Documentation interface"
summary: "The planned CLI, Gateway, and agent-facing catalog for progressive documentation access"
read_when:
  - Designing the first public harness primitive
  - Exposing documentation to another harness or coding agent
  - Defining stable machine-readable documentation output
---

# Documentation interface

> **Status:** The catalog and deterministic ranked query are implemented
> (`src/docs-catalog`) with real-question fixtures. The `pi-template docs`
> CLI commands and Gateway routes remain planned.

The first planned public harness primitive is documentation discovery:

```text
pi-template docs list
pi-template docs read <id>
pi-template docs query <question>
```

It demonstrates how a harness can let another harness or coding agent inspect
its capabilities progressively without making every internal subsystem public.
Surfacing harness primitives through a command-line interface for external
agents can be valuable, but **doing this is a product decision** — the template
makes that decision for itself because self-description is its demonstrative
product; a product built on the harness makes its own call. Its sibling
primitive is the
[read-only query surface](state-and-sessions.md#read-only-query-surface) over
durable state.

## Command intent

| Command | Planned behavior |
|---|---|
| `docs list` | Return document IDs, titles, summaries, and `read_when` triggers |
| `docs read <id>` | Return one canonical document or addressable section |
| `docs query <question>` | Deterministically return ranked pages, relevant sections, and a bounded progressive reading plan |

The documentation interface does not invoke a model. A product may add an
explicitly intelligent documentation command later, but doing so is a separate
product decision.

## Shared catalog

CLI, Gateway, and any future Pi adapter consume the same `DocsCatalog`
contract and identifier scheme. The CLI reaches the catalog through the
Gateway, like every other command. Markdown under `docs/` remains canonical,
and any transport must return equivalent stable JSON.

## Proposed output properties

- Versioned response envelope.
- Stable document and section identifiers.
- Canonical relative source path.
- Title, summary, and `read_when` metadata.
- Content hash or revision for cache validation.
- Explicit truncation and follow-up identifiers for progressive reads.
- Structured errors for unknown or ambiguous IDs.

Exact schemas belong with the future executable contract, not in this outline.

## Boundary

This example does not require sessions, schedules, state, events, or model
intelligence to become public CLI APIs. A product may expose those primitives
only after choosing their authority, privacy, and compatibility contracts.

## Decided

- The executable is `pi-template`.
- Docs commands traverse the Gateway like every other CLI command. The daemon
  serves docs routes before onboarding completes: they are model-free and ride
  the fail-closed rule's diagnostics exception.
- `docs query` ships in the first milestone with deliberately simple,
  deterministic ranking — term matching over titles, summaries, `read_when`
  triggers, and section headings with a transparent score. Its quality is
  asserted by acceptance fixtures with real questions and expected top pages;
  a product may replace the ranker behind the same contract.

## Open decisions

- Section identifier and content-version format.
