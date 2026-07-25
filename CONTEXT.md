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
self-description, and an **Operation surface**.
_Avoid_: feature, module (those are implementation units, not capabilities)

**Operation surface**:
The model-free, progressively discoverable interface through which a caller
invokes harness primitives — here, the `pi-template` CLI over the
authenticated Gateway. Reads and mutations stay distinguishable, and each
operation keeps one implementation of its behavior no matter how many
surfaces reach it. Which operations reach which callers is a product
decision; whether behavior is duplicated to serve them is not.
_Avoid_: API, tool schema, command set

**External harness**:
Any other harness acting as a caller of this one through the operation
surface, taught by a small skill rather than injected tool schemas.
_Avoid_: client, integration
