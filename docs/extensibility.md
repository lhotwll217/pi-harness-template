---
title: "Extensibility"
summary: "The intended extension seams for Pi resources, application modules, and product-selected surfaces"
read_when:
  - Adding a tool, skill, prompt, extension, adapter, or client surface
  - Deciding whether reusable behavior belongs inside or outside the harness core
  - Considering extraction or package publication
---

# Extensibility

> **Status:** The agent definition and exact-set loading are
> implemented (`src/agent/agent-definition.ts`); the design rules below govern
> everything added to it.

The template uses three extension seams:

1. **Pi resources** — prompts, tools, skills, and Pi-native extensions loaded by
   the owned agent runtime.
2. **Application modules** — replaceable implementations behind narrow
   harness-core contracts, such as state or sandbox adapters.
3. **Product surfaces** — clients, commands, or interfaces selected by the
   product using the harness.

## Pi resources

Bundled resources live under the future agent owner and appear in one explicit,
ordered agent definition — the standard bundle of system prompt, tools, and extensions. The definition is the source for loading, onboarding review,
diagnostics, and exact-set tests. Ambient project extensions, skills, and prompts
are not loaded automatically.

Pi already owns its extension lifecycle. The harness must not add another plugin
runtime, discovery convention, or package registry beside it.

### Choosing a Pi seam

Pi provides one mechanism per extension intent. Route new behavior to the
matching seam instead of designing local infrastructure; each mechanism is
specified in the named document inside the pinned
`@earendil-works/pi-coding-agent` package:

- **Workflow knowledge** the model should load on demand → a **skill**
  (`docs/skills.md`; Pi implements the
  [Agent Skills standard](https://agentskills.io/specification)).
- **A new callable capability** with typed input and output → a **tool**
  (a `kind: "tool"` definition entry, or `pi.registerTool()` inside an extension).
- **Lifecycle or interactive behavior** — intercepting tool calls, custom
  commands, user prompts, custom rendering → an **extension**
  (`docs/extensions.md`).
- **A new client surface** — web UI, IDE, automation pipeline → the **SDK**
  (`createAgentSession`, `docs/sdk.md`) or **RPC mode** (`docs/rpc.md`). The
  harness Gateway and CLI are adapters of this kind.
- **Reusable behavior shared across installations** → search existing **Pi
  packages** first (`docs/packages.md`; installable from npm or git — there is
  no central registry), per the repository's do-not-reinvent rule.

When intent is unclear, ask **who owns the trigger**:

- Pi owns it (a turn starts, a tool is called, a command is entered) →
  extension.
- The model requests a standalone operation → tool.
- The agent follows a composable workflow → skill.
- The harness owns durable behavior → application module behind a contract.
- A particular client displays it → that surface's adapter.

A feature may span several seams; classify each piece separately. An extension
is the Pi-facing adapter: its handlers translate Pi events into calls on
harness modules, so the durable behavior survives if the adapter is removed. Durable
state, scheduling, and Gateway operations stay in their owning modules; in
particular, Pi's session-entry persistence records session state, not durable
truth, which keeps the single-durable-writer rule intact.

This is already how the bundled capabilities are integrated: the permission
extension (which also carries the sensitive-path privacy rules), the defined
tools, and the identity prompt each enter through their native Pi seam and the
explicit agent definition — never through ambient discovery. Whatever seam produces the
resource, the agent definition still decides whether it loads.

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

The harness core may provide a Gateway client and selected CLI commands, but a
product chooses which primitives it exposes. Sessions, schedules, state, events,
or model intelligence are not automatically public APIs. The template's own
product surface is self-description — the
[documentation interface](docs-interface.md) and the
[read-only query surface](state-and-sessions.md#read-only-query-surface).

## Open decisions

- The agent definition entry format.
- Which adapters are required for the first supported operating system.
- How a product declares enabled resources without creating another plugin system.
