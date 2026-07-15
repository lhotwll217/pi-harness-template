---
title: "Self-documentation"
summary: "How repository instructions, routed pages, and a future catalog teach humans and agents progressively"
read_when:
  - Adding or reorganizing durable documentation
  - Designing documentation discovery for humans, agents, or tools
  - Preventing behavior knowledge from drifting across surfaces
---

# Self-documentation

> **Status:** The Markdown routing structure exists. Automated catalog and drift
> checks are planned.

Self-documentation is a product primitive: another coding agent should be able
to enter the repository, learn only what it needs, and follow stable links to
deeper contracts. Source Markdown remains canonical for people and machines.

## Routing chain

```text
AGENTS.md policy
      ↓
README orientation
      ↓
docs page selected by summary + read_when
      ↓
future executable contracts: schemas, catalogs, parsers, and tests
```

Root `AGENTS.md` owns repository policy. A scoped `AGENTS.md` owns local working
rules. README explains the project and routes to pages; it does not become a
second behavioral specification. Each durable docs page owns one surface.

## Page metadata

Every page under `docs/`, excluding instruction files, begins with:

```yaml
---
title: "Surface name"
summary: "One line saying what this page is"
read_when:
  - A concrete reason to read it
---
```

The summary identifies the page. `read_when` alone owns routing triggers. A
future catalog generator must fail if a page lacks any required field.

## Progressive reading paths

- A new contributor reads README, then [Architecture](architecture.md).
- Security or setup work follows [Onboarding](onboarding.md) and
  [Security](security.md).
- Continuity or automation work follows [State and sessions](state-and-sessions.md)
  and [Scheduler](scheduler.md).
- Agent-resource work follows [Extensibility](extensibility.md).
- Public discovery work follows [Documentation interface](docs-interface.md).
- Verification work follows [Testing](testing.md).

## Single-owner rule

Behavior is stated where it is owned and linked elsewhere. Once executable
contracts exist, schemas, catalogs, flags, and parsers should document their own
exact shapes. Narrative pages explain purpose and invariants and point to those
contracts rather than copying them.

## Planned catalog

A deterministic catalog will parse routing frontmatter and stable section
headings from the same Markdown used by contributors. The catalog may later back
the CLI, Gateway, and an embedded Pi tool. Generated views are disposable; they
never replace source Markdown.

Drift checks should validate metadata, links, duplicate identifiers, generated
artifacts, and claims that refer to paths or commands that do not exist.

## Open decisions

- Stable document and section identifier format.
- Whether generated catalog data is committed or built on demand.
- How strictly automated checks detect duplicated behavioral claims.

## Design reference

The routed-page convention follows the deterministic metadata checks and
progressive listing used by OpenClaw's pinned
[docs-list mechanism](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/scripts/docs-list.js#L1-L179).
Only the documentation pattern is adopted here.
