---
title: "Onboarding"
summary: "The planned versioned setup flow for roots, credentials, trust policy, sandboxing, and readiness"
read_when:
  - Designing or changing first-run setup
  - Deciding which work must fail closed before owner consent
  - Debugging future setup-required behavior
---

# Onboarding

> **Status:** Implemented, including the entry behavior below: running
> `pi-template` starts guided setup when needed — three questions on the happy
> path (standalone-Pi import including model settings, protected paths, one
> accept over the full review surface) — with Pi's built-in provider login for
> fresh installs and per-question customization when the review is declined.

Onboarding is a versioned, resumable state machine rather than a collection of
first-run side effects. It establishes the trust and runtime contract shared by
interactive commands, the daemon, and headless scheduled work.

## Intended stages

1. Create the harness home and agent workspace without overwriting owner files.
2. Authenticate a provider or import credentials through an explicit approved flow.
3. Select and verify model settings.
4. Review the [agent definition](extensibility.md#pi-resources) of bundled prompts,
   tools, skills, and extensions, then explicitly approve any owner-installed or
   workspace-provided resources eligible for loading.
5. Choose a capability and approval posture.
6. Review protected paths and data boundaries.
7. Record the operating-system sandbox choice, off unless the owner opts in, and
   verify enforcement when it is on.
8. Install or configure the daemon service if the selected platform supports it.
9. Run model-free readiness checks.
10. Write a completed-version marker only after every required stage succeeds.

Each stage must be safe to repeat. Resuming setup starts from durable stage state,
not from guesses about partially created files.

A rerun on a completed home runs every stage again. Each answer it does not
replace keeps the value the home records: an omitted flag, or a prompt left at
its default. The completion marker is withdrawn only after the rerun has every
answer it needs, and is written again when the last stage passes, so a rerun
that fails a stage leaves setup incomplete. Homes onboarded before the
agent-definition acknowledgment was recorded must acknowledge it once more.

A rerun never falls back to a default that could widen access when a recorded
answer cannot be read; it stops, or asks, before anything is written. A
`sandbox.json` that does not parse, or lacks any part of its policy (the three
filesystem root lists, `process.allowSubprocesses`, and a network mode of `deny`
or `allowlist` with its domain list), stops the rerun until `--sandbox` or
`--sandbox-off` replaces it. A non-interactive rerun stops when `settings.json`
does not parse or records an unknown permission mode, until `--permission`
replaces it, and when `protected_paths.json` does not parse or lists anything
but strings, until `--protected-path` replaces it. An interactive rerun over
either of those two files names the damage, asks for its answers with no
default (the protected paths; the permission mode, and the service choice when
settings no longer record it), and lists the damaged file in the review.
Non-interactive onboarding without `--permission` takes the recorded mode, or
`allow` on a new home.

With the sandbox on, onboarding refuses, before anything is written, a write
root that contains the harness home, whether given with `--sandbox-write`, taken
from the working directory, or kept from the recorded `sandbox.json`, and a
write root with glob characters, a leading `~`, a relative spelling, or a
symlink on its spelling whose target does not exist; the
message names the root and the home. Interactive onboarding checks before it
asks for authentication. Both modes honor `--sandbox-read` and
`--sandbox-write`. The rule and its reason are in
[security](security.md#write-roots-stay-outside-the-harness-home).

## Fail-closed rule

Until the current onboarding contract is complete, the daemon may expose
model-free diagnostics but must not permit headless model calls, scheduled
prompts, or other model/tool work that depends on owner consent. A changed trust
contract—such as new bundled capabilities or materially different protected-path
rules—must reopen the relevant review instead of silently grandfathering the old
marker.

New bundled capabilities follow this rule through the recorded resource review.
`resource-approvals.json` lists the agent-definition entries the owner
acknowledged. When the agent definition gains an entry that list lacks, every
session (interactive, `pi-template prompt`, and scheduled) refuses to start,
`pi-template doctor` reports not ready and lists the entries under
`resources.unacknowledged`, and a rerun of onboarding without
`--acknowledge-resources` stops. Each names the new entries and the command that
acknowledges them. A home that never recorded a resource review gets the same
refusal, worded as no review yet, pointing at `pi-template onboard`. A
non-interactive rerun that changes a resource answer (`--approve-workspace-context`,
`--workspace-skills`, or `--skill`) keeps the recorded acknowledgement while the
agent definition is unchanged; otherwise it exits 2 and names
`--acknowledge-resources`.

## Agent-operated onboarding

The north star is minimizing friction for the human to start interacting. One
path to that is letting an agent the owner already uses — a coding agent in
their terminal — drive this same onboarding flow on their behalf: "download
this and set it up." There is no separate agent mode. The agent operates the
ordinary flow, answering the same questions and reviewing the same setup a
person would; onboarding is written to be operable that way.

This is a valid, supported option **when the product and its trust boundary
allow it**, and it is a trade the owner makes deliberately:

- The driving agent must be granted the capabilities to operate the flow.
- That agent becomes an **information broker** — it sees the answers and the
  auth handoff. Convenience is weighed against trusting the middle agent with
  that visibility.

Onboarding is never reduced to a switch: an agent that drives it still goes
through every stage, and the sandbox stage, when the owner opted in
([the sandbox is opt-in](security.md#the-sandbox-is-opt-in)), still runs its
real enforcement probe and fails closed. Automation changes *who operates the flow*, never
*whether the verification happens*.

### The login handoff (`--no-browser`)

The one step that structurally assumes a human is provider login: the default
browser flow opens a page and waits on a localhost callback. An agent driving a
terminal cannot complete that. `pi-template onboard --no-browser` (or the
`PI_TEMPLATE_NO_BROWSER` environment variable) takes the login method Pi marks
as headless instead. For a device-code provider such as OpenAI Codex, the
harness prints a URL and a short code, the owner approves on any device, and
polling completes with no callback and no redirect URL to paste. Anthropic
offers copy-code login instead: the owner signs in at the printed URL and the
code Anthropic shows is pasted back. The agent relays the URL, and the code
when there is one; nothing else in the flow needs a human. The interactive
default stays browser login, which is the better experience for a person at a
laptop.

## Readiness

Readiness should report effective roots, provider/model availability, selected
resources, permission posture, sandbox status, and daemon configuration without
printing secrets. Readiness is a deterministic diagnostic; it must not require a
paid model call.

## Entry behavior

Onboarding is the first-run experience of the main entry point, converging on
Owner Operator's pattern — never a subcommand the owner must discover:

- Running `pi-template` in an interactive terminal with no completed marker
  starts guided setup immediately; once setup is complete, the same bare
  command is the harness's default surface — it ensures the daemon and opens
  the interactive agent session. The owner runs one command, ever.
  `pi-template onboard` remains the explicit revisit path, and non-interactive
  invocations print status for scripts.
- Non-interactive invocations without a marker fail closed: setup-required on
  stderr and exit code 2.
- The auth stage offers, in order: copying the global standalone Pi
  installation's authorizations and model settings if one exists (read-only —
  importing never modifies the source; the harness knows about no other
  application's files), Pi's built-in provider login (the toolkit's own OAuth
  flows; the harness does not reinvent login), and manual API-key entry only as
  an explicit fallback. Without a standalone Pi install, the owner
  authenticates the harness like any other fresh tool.
- The auth stage reads `auth.json` as Pi does (a leading byte-order mark is
  ignored) and stops with the file untouched when it is not a JSON object, so
  a damaged file never loses its saved providers. `pi-template doctor` reads it
  the same way and reports a damaged file as unreadable. Import renames the provider
  key `azure-openai-responses`, which Pi 1.0.3 renamed to `azure` without
  migrating stored credentials.
- Guided setup is consolidated onto one review surface: after the import offer
  and a dedicated protected-paths question, every remaining choice — provider
  and model, the exact agent definition, permission mode, skill policy,
  workspace approval, sandbox defaults, and service — is shown together and
  accepted with a single confirmation. Declining the summary drops into
  per-question customization. Consolidation never skips a stage predicate or
  the probe of an opted-in sandbox; it only consolidates the asking. The review
  defaults to permission mode `allow` and the sandbox off.

## Decided

- All ten stages ship in the first implementation; none are deferred or
  ceremonial. Every stage has a verification predicate and a test proving it
  fails closed when its precondition is broken.
- Provider login and credential import follow the entry behavior above:
  toolkit-owned OAuth flows plus guided import, resolving what a product must
  support before onboarding can complete.
- Sandbox enforcement (stage 7), when the owner opts in with `--sandbox`, is
  verified through the adopted
  [sandbox adapter](security.md#sandbox-adapter-boundary); there is no
  complete-with-warning path. A new home records the sandbox off.
- macOS (launchd) is the first always-on service platform, ported from Owner
  Operator's daemon management; other platforms follow.

## Open decisions

- The exact versioning and access-contract hash format.
