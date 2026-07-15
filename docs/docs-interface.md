---
title: "Documentation interface"
summary: "The planned CLI, Gateway, and agent-facing catalog for progressive documentation access"
read_when:
  - Designing the first public harness primitive
  - Exposing documentation to another harness or coding agent
  - Defining stable machine-readable documentation output
---

# Documentation interface

> **Status:** Planned example interface. No commands, Gateway routes, generated
> catalog, or model-backed query exist yet.

The first proposed public harness primitive is documentation discovery:

```text
harness docs list
harness docs read <id>
harness docs query <question>
```

It demonstrates how a harness can let another harness or coding agent inspect
its capabilities progressively without making every internal subsystem public.
Surfacing harness primitives through a command-line interface for external
agents can be valuable, but **doing this is a product decision**.

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

CLI, Gateway, and any future Pi adapter should consume the same `DocsCatalog`
contract and identifier scheme. Whether the first CLI reads Markdown locally or
calls the Gateway remains an implementation decision. Markdown under `docs/`
remains canonical, and either transport must return equivalent stable JSON.

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

## Open decisions

- Final executable name; `harness` is illustrative.
- Direct filesystem versus Gateway transport for local CLI reads.
- Section identifier and content-version format.
- Whether `docs query` belongs in the first implementation milestone.
