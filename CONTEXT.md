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
What the harness can do, stated so that something outside it can find out
and ask, without knowing how the harness is built. Its callers are humans,
its own agent, and **External harnesses**. It takes whatever form suits a
caller, and one harness may offer several at once; what the harness answers
does not change with the form.
_Avoid_: operation surface, command set

**External harness**:
Any other harness acting as a caller of this one through the **Public
interface**, taught by a small skill rather than injected tool schemas.
_Avoid_: client, integration
