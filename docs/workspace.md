---
title: "Workspace"
summary: "The boundary between bundled agent resources and the owner-authored workspace, and the philosophy for what belongs on each side"
read_when:
  - Deciding whether a prompt, skill, or workflow belongs in the bundle or the workspace
  - Authoring owner instructions or workspace skills
  - Vendoring a skill into the harness or debugging why a skill did not load
  - Designing the bundled identity prompt or adding a bundled resource
---

# Workspace

> **Status:** Implemented. The owner workspace exists
> (`~/.pi-template/workspace`) and the bundled identity prompt
> (`src/agent/prompts/pi-template.md`) is wired into every session surface and
> listed in the agent definition.

The harness agent is configured from two places with one rule dividing them.

## Bundled resources: capability, not personality

The [agent definition](extensibility.md#pi-resources) — the bundled prompts, tools,
skills, and extensions — is opinionated toward exactly one thing: **optimizing
the agent for the harness domain and its capabilities.** The bundled identity
prompt tells the agent what it is, what system it operates — durable state and
its record families, the read-only query surface, notes, schedules and runs,
the documentation catalog — and how to use those primitives well. It embeds
the CLI's help tree and the state schema as generated text
([Command-line interface](cli.md#help-is-the-guidance)). Bundled
content earns its place by making the agent competent at *being this harness*;
it never encodes a particular owner's workflow, style, or domain.

## The owner workspace: identity nuance and opinionated workflows

Everything more opinionated belongs to the owner, in the workspace the harness
creates but never overwrites:

- `workspace/AGENTS.md` — persistent owner instructions: who the agent should
  be for this owner, house rules, tone, priorities.
- `workspace/skills/` — owner-defined Agent Skills for nuanced, multi-step
  workflows.
- `workspace/artifacts/` — durable owner-visible outputs.

Owners define instructions and skills here; the harness loads workspace
content only after explicit approval during onboarding, per the
[explicit resource loading](security.md#explicit-resource-loading) rule.
`AGENTS.md` is the only workspace file loaded into the session context. Any
other file, a `MEMORY.md` left by an older harness included, is an ordinary
owner file the agent reads only when asked.

## Skills

Every session (interactive, `pi-template prompt`, and scheduled) loads two
sets of skills:

- **Vendored skills**, listed in the agent definition as `kind: "skill"`
  entries and stored under `src/agent/skills/<name>/`. Each is a copy of an
  upstream skill, with an `UPSTREAM.md` naming the source repository and the
  commit it was copied from. The first is `writing-for-agents`, from
  [lhotwll217/skills](https://github.com/lhotwll217/skills).
- **Workspace skills** in `workspace/skills/`: each folder with a `SKILL.md`
  (Pi also finds one in a subfolder of a folder without one), and each
  top-level `.md` file whose frontmatter has a `description` (and a `name`;
  without one, Pi names it `skills`, after its folder). A link to either
  counts. Onboarding's skill policy chooses which load: `all-workspace` (the
  default) loads every one, `bundled` loads none, and `allowlist` loads only the
  named entries. Non-interactive onboarding takes
  `--workspace-skills all|bundled|allowlist` and a repeated `--skill <name>`;
  `--skill` alone means `allowlist`.

The harness hands Pi each folder and `.md` file in `workspace/skills/`
separately; other files, such as a `LICENSE` or `package.json`, stay out.
Because Pi reads each entry as its own root, a `.gitignore` (or `.ignore`,
`.fdignore`) at the root of `workspace/skills/` no longer applies; one inside a
skill folder still does. When two skills share a name, the first one loaded
wins: vendored skills, then real folders and files, then links, each group in
name order (in allowlist order under `allowlist`).

The harness leaves out what Pi cannot load, would load twice, or would never
finish walking. `pi-template doctor` prints the skill policy beside the loaded
workspace skills and lists each entry left out:

- `resources.brokenSkillLinksNotLoaded`: a link whose target is gone. Pi skips
  it without a diagnostic.
- `resources.skippedSkillLinks`: a link back to `workspace/skills/` or a folder
  above it, a second link to a folder already loaded, or a link inside a skill
  folder back to a folder that holds it, which keeps that whole entry out. Pi
  follows linked folders without a cycle check, so a looping link would stall
  every session, doctor, and the daemon that runs them.
- `resources.skillNameCollisionsNotLoaded`: a skill whose name another skill
  already took.

Doctor also notes, under `resources.notices`, a `workspace/MEMORY.md` that no
longer loads and a `bundled` policy that keeps every workspace skill out, with
the command that changes it.

## The dividing question

For any new resource, ask: *would every owner of this harness want the agent
to behave this way?* Yes — it is a capability concern and may be bundled,
subject to definition review. No — it is an opinion and belongs in a workspace
(or, for a product built on the template, in that product's own bundle, judged
by the same question against that product's owners).

## Design reference

The split follows Owner Operator's agent configuration: one git-tracked
identity prompt owning domain capability, with owner personalization living in
the workspace the entry points must never overwrite.
