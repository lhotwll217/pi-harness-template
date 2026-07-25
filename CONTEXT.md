# Pi Harness Template — Domain Glossary

Language pinned during design sessions. Glossary only — behavior and
implementation live in [docs/](docs/).

## Language

**Harness**:
The runtime that hosts an agent and mediates its work: sessions, tools,
permissions, and durable state. The field's converged term — pi, Claude Code,
and Codex are all harnesses.

**Micro harness**:
A harness with one behavioral **Specialty**, built from the shared **Harness
primitives**. "Micro" scopes behavior, not code size or ambition: the
architecture beneath is what makes the specialty trustworthy.
_Avoid_: mini harness, template harness, framework

**Specialty**:
The single behavioral scope that identifies a micro harness, statable in one
sentence. A harness whose specialty needs more than one sentence is a
generalist harness or a framework. This template's specialty: teach how to
build a micro harness by being one.

**Harness primitive**:
A capability every serious harness needs regardless of specialty: durable
state and sessions with provenance, scheduled runs in fresh isolated
sessions, onboarding that fails closed, explicit security boundaries,
self-description, and a **Public interface**.
_Avoid_: feature, module (those are implementation units, not capabilities)

**Public interface**:
How the harness is driven from outside — by a human, its own agent, or an
**External harness** — without embedding it. Model-free, discoverable in
pieces rather than as one schema dump, with reads and mutations
distinguishable. Usually a CLI, because a shell costs no model context and
every caller already has one; an MCP server is the alternative where a
caller cannot shell out, at the cost of resident tool schemas. The form is
a product choice; each operation keeping one implementation of its behavior
is not.
_Avoid_: operation surface, command set

**External harness**:
Any other harness acting as a caller of this one through the operation
interface, taught by a small skill rather than injected tool schemas.
_Avoid_: client, integration
