# Pi Harness Template — Domain Glossary

Language pinned during design sessions. Glossary only — behavior and
implementation live in [docs/](docs/).

## Language

**Harness**:
The runtime that hosts an agent and mediates its work: sessions, tools,
permissions, and durable state. The field's converged term — pi, Claude Code,
and Codex are all harnesses.

**Micro harness**:
An agent specialized by its **System prompt**, **Specialized skills**,
**Specialized tools**, and **Domain data model**, backed by a core set of
**Harness primitives**, shared across **External consumers** and shown to
its **User** through purpose-built **Apps**.
"Micro" scopes the agent's **Specialty**, not code size or ambition; the
primitives beneath are what make the specialty dependable.
_Avoid_: mini harness, template harness, framework

**Specialty**:
What a micro harness is for — travel planning, SEO, language learning — not
the list of things it can do. This template's specialty is teaching how to
build a micro harness by being one.

**User**:
The person a micro harness serves and answers to. Apps are built for them,
boundaries are set by them, and the agent's work is auditable to them.

**System prompt**:
The agent's standing instructions: who it is, what it is for, and the
judgment its **Specialty** demands — what matters, what to do first, when to
stop and ask the **User**. The part of the specialty that is know-how rather
than capability.

**Specialized skills**:
Domain procedures the agent loads when a task calls for them, rather than
carrying in its **System prompt** at all times. They keep the specialty deep
without making the agent read everything it knows on every turn.
_Avoid_: playbooks, workflows

**Specialized tools**:
The domain-specific tools that let the agent act in its **Specialty** — the
part a travel-planning harness has and an SEO harness does not. Built on
**Harness primitives**, never in place of them.
_Avoid_: custom tools, product tools

**Domain data model**:
The slice of durable state belonging to the **Specialty**: a lasting,
auditable record of what the agent did and what was derived from it. The
primitives make state durable; the domain data model decides what is worth
keeping.
_Avoid_: schema, tables (those are its implementation)

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
interface** — the **User** at a terminal, a script, an **App**, another agent, an
**External harness**. No consumer gets a privileged path in.

**External harness**:
A kind of **External consumer**: another harness using this one, taught by a
small skill rather than injected tool schemas.
_Avoid_: client, integration

**App**:
A UI purpose-built for the specialty's use case, giving the **User** a tailored
view of the agent and its primitives. An **External consumer** like any other
— an app renders and requests; it holds no behavior of its own.
_Avoid_: frontend, client (both imply the app owns part of the harness)
