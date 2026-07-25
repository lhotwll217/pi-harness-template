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
primitives**, whose operations are single-sourced behind an **Operation
surface**. "Micro" scopes behavior, not code size or ambition.
_Avoid_: mini harness, template harness, framework

**Specialty**:
The single behavioral scope that identifies a micro harness, statable in one
sentence. A harness whose specialty needs more than one sentence is a
generalist harness or a framework, not a micro harness. This template's
specialty: teach how to build a micro harness by being one (self-description).

**Harness primitive**:
A capability every serious harness needs regardless of specialty: durable
state and sessions with provenance, scheduled runs in fresh isolated
sessions, onboarding that fails closed, explicit security boundaries,
self-description, and an **Operation surface**.
_Avoid_: feature, module (those are implementation units, not capabilities)

**Operation surface**:
The model-free, progressively discoverable interface through which any caller
invokes harness primitives — here, the `pi-template` CLI traversing the
authenticated Gateway. Reads and mutations are explicit and distinguishable.
Term shared with Owner Operator's external operation interface work.
_Avoid_: API, tool schema, command set

**Caller**:
Anything that invokes an operation: a human at the shell, the harness's own
agent, or an **External harness**. Each has different context cost, trust,
and presentation needs.

**Single-sourced operation**:
An operation with exactly one implementation of its behavior, validation,
permission policy, and structured result, regardless of how many callers
reach it. Surfaces are adapters over it and cannot drift. This is the
invariant a micro harness must hold.
_Avoid_: shared operation (ambiguous — sharing behavior, not exposure)

**Caller parity**:
A design lens, not a requirement: for a given operation, ask which **Callers**
should reach it and in what shape, and justify each exclusion. Applied where
it earns its keep — a mutation may be human-only, a hot read may deserve a
native typed tool for the local agent and a CLI command for everyone else.
Parity is about *exposure*, which is situational; it never licenses a second
implementation, which is not.
_Avoid_: treating parity as "every operation, every caller, same shape"

**External harness**:
Any other harness acting as a caller of this one through the operation
surface, taught by a small skill rather than injected tool schemas.
_Avoid_: client, integration

## Flagged ambiguities

- "product decision" — partially resolved: *which* operations reach *which*
  callers stays a product decision; *whether* an operation surface exists and
  whether operations are single-sourced does not.
  `docs/docs-interface.md` predates this and still hedges the latter.
