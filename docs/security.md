---
title: "Security"
summary: "The intended trust model across capabilities, approvals, privacy policy, and operating-system enforcement"
read_when:
  - Designing or changing tool access
  - Tracing what should prevent an agent from reaching a protected resource
  - Evaluating interactive and headless authority
---

# Security

> **Status:** Implemented across the four controls: the pinned
> `@gotgenes/pi-permission-system` reconciled from owner settings, protected
> paths, the opt-in `@anthropic-ai/sandbox-runtime` adapter with its fail-closed
> verification probe (`src/agent/sandbox`), and headless approval denial in the
> scheduled-prompt runner.

Security is not one feature. The harness keeps four independent controls visible
because each answers a different question:

| Control | Question |
|---|---|
| Capability posture | Which tools and operations exist for this run? |
| Approval policy | Is an attempted call allowed, denied, or subject to owner approval? |
| Privacy policy | Which paths, repositories, credentials, and data are protected? |
| OS enforcement | What can the process actually access through files, subprocesses, and the network? |

Passing one layer never proves that another layer is enforced. Documentation and
diagnostics must not call a permission decision a sandbox.

## Permission modes

The owner picks one mode, and the harness
[reconciles it](../packages/contracts/src/permissions.ts) into the permission
extension's config while keeping owner-authored rules:

| Mode | Reads | Bounded harness state (`save_note`) | `edit`, `write`, `bash` |
|---|---|---|---|
| `allow` (default) | allow | allow | allow |
| `ask` | allow | allow | ask |
| `read-only` | allow | deny | deny |

A fresh home defaults to `allow`, so the agent can act from its first turn. A
`settings.json` that records no mode also means `allow`; one that does not parse
or records an unknown mode means `read-only`, so a damaged choice never widens
access. `read-only` stays supported: permission system 39 withholds a tool its
policy denies outright, so under `read-only` the agent has no `bash` at all.

## Interactive and headless authority

Interactive runs may ask the owner when policy allows. Headless runs cannot
manufacture consent: an operation that would require approval in an interactive
session is denied unless a separately reviewed headless policy grants it.
Scheduled runs also narrow their tool set to the tools declared by the
schedule snapshot.

## Explicit resource loading

The Pi runtime must begin with ambient context, prompts, skills, and extensions
disabled. It then loads the harness-owned agent definition plus explicitly approved
workspace resources. A task working directory may carry trusted task policy, but
its mere presence does not make arbitrary executable extensions safe.

## Protected paths

Path policy must reason about explicit paths, traversal, symlinks, filesystem
resolution, and repository identities. Direct file-tool guards are useful but do
not constrain process-internal access from a shell command. OS enforcement owns
that stronger boundary.

Secrets remain under the harness home or provider store and must not appear in
logs, readiness output, transcripts, events, or error messages.

## Sandbox adapter boundary

The sandbox is a replaceable platform adapter behind a small contract. The
contract should express filesystem, process, and network policy and provide a
model-free verification probe.

The adopted provider is `@anthropic-ai/sandbox-runtime` (Apache-2.0), wrapping
macOS Seatbelt and Linux bubblewrap behind one API. It is pinned exactly and
treated as disposable behind the adapter contract: the package is pre-1.0 and
published from an experimental organization, so the contract — not the provider
— is the durable architecture. Adoption is gated on an escape-boundary review
at port time. There is no stub fallback: if enforcement cannot be verified by
the model-free probe, the onboarding sandbox stage fails closed rather than
completing with a warning.

### The sandbox is opt-in

The sandbox is off until the owner turns it on. `sandbox.json` in the harness
home records the choice as `"enabled": true` or `false`, beside the filesystem,
process, and network policy, so turning it on later starts from recorded roots.
Onboarding writes `false` for a new home; `pi-template onboard --sandbox` turns
it on and `--sandbox-off` turns it off again. A rerun without either flag keeps
the recorded choice. A home with no `sandbox.json` is off, and a `sandbox.json`
written before the field existed stays on, because it was enforced when written.

On, bash runs through the adapter and onboarding runs the probe. Off, bash runs
on the host with the owner's permissions through Pi's local executor, and
onboarding skips the probe. Either way a command sees only a short list of
environment variables (`PATH`, `HOME`, locale, certificate paths and the like),
so the daemon's own credentials stay out of transcripts. Off gives up what only
the OS layer can enforce, because the permission layer cannot see what a shell
command touches: a command can read the model credentials under
`<harness home>/pi` and every protected path. `pi-template doctor` reads
`sandbox.json` itself and reports `sandbox.enabled`, so a hand edit shows at
once.

## Audit and provenance

Every model or command run should retain enough provenance to identify its
session, caller, task directory, schedule/run when applicable, effective
capability set, and policy version. Provenance supports diagnosis and audit; it
must not duplicate secrets or become a competing source of durable truth.

## Open decisions

- The stable adapter contract around the adopted
  `@gotgenes/pi-permission-system` extension.
- Network defaults for interactive and scheduled work when the sandbox is on.
- How owner-authored task policy may narrow or widen the global baseline.
