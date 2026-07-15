---
title: "Onboarding"
summary: "The planned versioned setup flow for roots, credentials, trust policy, sandboxing, and readiness"
read_when:
  - Designing or changing first-run setup
  - Deciding which work must fail closed before owner consent
  - Debugging future setup-required behavior
---

# Onboarding

> **Status:** Planned contract; no onboarding flow is implemented.

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

## Readiness

Readiness should report effective roots, provider/model availability, selected
resources, permission posture, sandbox status, and daemon configuration without
printing secrets. Readiness is a deterministic diagnostic; it must not require a
paid model call.

## Open decisions

- Supported provider login and credential-import paths.
- The exact versioning and access-contract hash format.
- Which platforms receive an always-on service in the first implementation.
- Whether sandbox verification can be portable or needs platform-specific probes.
