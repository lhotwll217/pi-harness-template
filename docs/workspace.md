---
title: "Workspace"
summary: "The boundary between bundled agent resources and the owner-authored workspace, and the philosophy for what belongs on each side"
read_when:
  - Deciding whether a prompt, skill, or workflow belongs in the bundle or the workspace
  - Authoring owner instructions, memory, or workspace skills
  - Designing the bundled identity prompt or adding a bundled resource
---

# Workspace

> **Status:** Contract for the boundary. The owner workspace exists
> (`~/.pi-template/workspace`); the bundled identity prompt is landing (see
> [Porting](porting.md)).

The harness agent is configured from two places with one rule dividing them.

## Bundled resources: capability, not personality

The [ordered catalog](extensibility.md#pi-resources) of bundled prompts, tools,
skills, and extensions is opinionated toward exactly one thing: **optimizing
the agent for the harness domain and its capabilities.** The bundled identity
prompt tells the agent what it is, what system it operates — durable state and
its record families, the read-only query surface, notes, schedules and runs,
the documentation catalog — and how to use those primitives well. Bundled
content earns its place by making the agent competent at *being this harness*;
it never encodes a particular owner's workflow, style, or domain.

## The owner workspace: identity nuance and opinionated workflows

Everything more opinionated belongs to the owner, in the workspace the harness
creates but never overwrites:

- `workspace/AGENTS.md` — persistent owner instructions: who the agent should
  be for this owner, house rules, tone, priorities.
- `workspace/MEMORY.md` — durable facts the owner wants carried across
  sessions.
- `workspace/skills/` — owner-defined Agent Skills for nuanced, multi-step
  workflows.
- `workspace/artifacts/` — durable owner-visible outputs.

Owners define skills, prompts, and memory here; the harness loads workspace
content only after explicit approval during onboarding, per the
[explicit resource loading](security.md#explicit-resource-loading) rule.

## The dividing question

For any new resource, ask: *would every owner of this harness want the agent
to behave this way?* Yes — it is a capability concern and may be bundled,
subject to catalog review. No — it is an opinion and belongs in a workspace
(or, for a product built on the template, in that product's own bundle, judged
by the same question against that product's owners).

## Design reference

The split follows Owner Operator's agent configuration: one git-tracked
identity prompt owning domain capability, with owner personalization living in
the workspace the entry points must never overwrite.
