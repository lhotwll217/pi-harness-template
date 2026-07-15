---
title: "Extensibility"
summary: "The intended extension seams for Pi resources, application modules, and product-selected surfaces"
read_when:
  - Adding a tool, skill, prompt, extension, adapter, or client surface
  - Deciding whether reusable behavior belongs inside or outside the kernel
  - Considering extraction or package publication
---

# Extensibility

> **Status:** Design rules; no extension catalog or packages exist yet.

The template uses three extension seams and does not invent a fourth:

1. **Pi resources** — prompts, tools, skills, and Pi-native extensions loaded by
   the owned agent runtime.
2. **Application modules** — replaceable implementations behind narrow kernel
   contracts, such as state or sandbox adapters.
3. **Product surfaces** — clients, commands, or interfaces selected by the
   product using the kernel.

## Pi resources

Bundled resources live under the future agent owner and appear in one explicit,
ordered catalog. The catalog is the source for loading, onboarding review,
diagnostics, and exact-set tests. Ambient project extensions, skills, and prompts
are not loaded automatically.

Pi already owns its extension lifecycle. The harness must not add another plugin
runtime, discovery convention, or package registry beside it.

## Application adapters

An adapter earns a seam when multiple valid implementations exist or a platform
boundary must be isolated. Contracts remain small and describe behavior rather
than library-specific objects. The daemon chooses concrete adapters at the
composition root.

## Extraction rule

Bundled integrations remain inside the agent owner initially. They are not
published as independent packages. Extraction becomes a real design question
only after a second consumer exists and proves which contract is shared. A
second consumer may justify extraction, but does not by itself justify external
publication.

## Product surfaces

The kernel may provide a Gateway client and selected CLI commands, but a product
chooses which primitives it exposes. Sessions, schedules, state, events, or model
intelligence are not automatically public APIs. The documentation interface is
the one planned example; see [Documentation interface](docs-interface.md).

## Open decisions

- The initial ordered resource catalog format.
- Which adapters are required for the first supported operating system.
- How a product declares enabled resources without creating another plugin system.
