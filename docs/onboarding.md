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
4. Review the [ordered catalog](extensibility.md#pi-resources) of bundled prompts,
   tools, skills, and extensions, then explicitly approve any owner-installed or
   workspace-provided resources eligible for loading.
5. Choose a capability and approval posture.
6. Review protected paths and data boundaries.
7. Configure and verify operating-system sandbox enforcement separately from permissions.
8. Install or configure the daemon service if the selected platform supports it.
9. Run model-free readiness checks.
10. Write a completed-version marker only after every required stage succeeds.

Each stage must be safe to repeat. Resuming setup starts from durable stage state,
not from guesses about partially created files.

## Fail-closed rule

Until the current onboarding contract is complete, the daemon may expose
model-free diagnostics but must not permit headless model calls, scheduled
prompts, or other model/tool work that depends on owner consent. A changed trust
contract—such as new bundled capabilities or materially different protected-path
rules—must reopen the relevant review instead of silently grandfathering the old
marker.

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
through every stage, and the sandbox stage still runs its real enforcement
probe and fails closed. Automation changes *who operates the flow*, never
*whether the verification happens*.

### The login handoff (`--no-browser`)

The one step that structurally assumes a human is provider login: the default
browser flow opens a page and waits on a localhost callback. An agent driving a
terminal cannot complete that. `pi-template onboard --no-browser` (or the
`PI_TEMPLATE_NO_BROWSER` environment variable) routes login to the provider's
device-code flow instead — the harness prints a URL and a short code, the owner
approves on any device, and polling completes with no callback and no redirect
URL to paste. The agent relays the URL and code to the owner; nothing else in
the flow needs a human. The interactive default stays browser login, which is
the better experience for a person at a laptop.

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
- Guided setup is consolidated onto one review surface: after the import offer
  and a dedicated protected-paths question, every remaining choice — provider
  and model, the exact resource catalog, permission mode, skill policy,
  workspace approval, sandbox defaults, and service — is shown together and
  accepted with a single confirmation. Declining the summary drops into
  per-question customization. Consolidation never skips a stage predicate or
  the sandbox probe; it only consolidates the asking.

## Decided

- All ten stages ship in the first implementation; none are deferred or
  ceremonial. Every stage has a verification predicate and a test proving it
  fails closed when its precondition is broken.
- Provider login and credential import follow the entry behavior above:
  toolkit-owned OAuth flows plus guided import, resolving what a product must
  support before onboarding can complete.
- Sandbox enforcement (stage 7) is verified through the adopted
  [sandbox adapter](security.md#sandbox-adapter-boundary); there is no
  complete-with-warning path.
- macOS (launchd) is the first always-on service platform, ported from Owner
  Operator's daemon management; other platforms follow.

## Open decisions

- The exact versioning and access-contract hash format.
