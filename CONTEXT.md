# Pi Harness Template — Domain Glossary

Language pinned during design sessions. Glossary only — behavior and
implementation live in [docs/](docs/).

## Language

**Harness**:
The runtime that hosts an agent and mediates its work: sessions, tools,
permissions, and durable state. The field's converged term — pi, Claude Code,
and Codex are all harnesses.

**Micro harness**:
A specialized agent, backed by a core set of **Harness primitives**, shared
across **External consumers** and shown to a person through purpose-built
**Apps**. "Micro" scopes the agent's **Specialty**, not code size or ambition;
the primitives beneath are what make the specialty dependable.
_Avoid_: mini harness, template harness, framework

**Specialty**:
The behavioral scope that identifies a micro harness — what it is for, not
the list of things it can do. A specialty is coherent: its capabilities
follow from one another, and a person can say what the harness is for
without enumerating features. This template's specialty: teach how to build
a micro harness by being one.

**Harness primitive**:
A capability any specialty depends on and none should reinvent: durable state
and sessions with provenance, scheduled runs in fresh isolated sessions,
onboarding that fails closed, explicit security boundaries, self-description,
and a **Public interface**.
_Avoid_: feature, module (those are implementation units, not capabilities)

**Public interface**:
What the agent and its primitives can do, stated so that anything outside can
find out and ask, without knowing how the micro harness is built. It takes
whatever form suits a consumer, and one micro harness may offer several at
once; what it answers does not change with the form.
_Avoid_: operation surface, command set

**External consumer**:
Anything outside the micro harness that uses it through the **Public
interface** — a person at a terminal, a script, an **App**, another agent, an
**External harness**. No consumer gets a privileged path in.

**External harness**:
A kind of **External consumer**: another harness using this one, taught by a
small skill rather than injected tool schemas.
_Avoid_: client, integration

**App**:
A UI purpose-built for the specialty's use case, giving a person a tailored
view of the agent and its primitives. An **External consumer** like any other
— an app renders and requests; it holds no behavior of its own.
_Avoid_: frontend, client (both imply the app owns part of the harness)
