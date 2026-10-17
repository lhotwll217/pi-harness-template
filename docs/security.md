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

Two lists become deny rules on the permission extension's `path` surface,
[generated](../packages/contracts/src/permissions.ts) in every permission mode:

- the `paths` the owner lists in `protected_paths.json`;
- the harness control files, which set the agent's own limits or hold its
  credentials: `settings.json`, `protected_paths.json`, `sandbox.json`,
  `sandbox-verification.json`, `resource-approvals.json`, `daemon.json` (the
  gateway token), the `pi/` directory (model credentials and Pi settings), and
  the state database `state.db` with its SQLite `-wal`, `-shm`, and `-journal`
  files, whose command schedules the daemon runs on the host outside the
  sandbox; all under the harness home
  ([`harnessControlPaths`](../packages/contracts/src/harness-home.ts)). The
  agent reads the state database through its `query_database` tool, which
  names no path.

A rule denies reading and writing the path and everything beneath it, matched as
written and as symlink-resolved, with the reason `Pi Template protected paths`.
It fires when a file tool (`read`, `write`, `edit`, `grep`, `find`, `ls`) names
the path in its own path argument, and when a bash command names it as a
literal path in an argument the extension parses, such as
`cat <home>/pi/auth.json`. It does not see:

- a path the shell expands: a glob (`cat <home>/*.json`, `cat <home>/p?/auth.json`),
  a brace list (`cat <home>/{daemon,x}.json`), or a variable
  (`f=<home>/daemon.json; cat $f`);
- a path a process assembles for itself, such as
  `python3 -c "open('/Us' + 'ers/...')"`;
- a `grep` or `find` rooted above a protected path, which descends into it: a
  `grep` rooted at the harness home prints matching lines of `pi/auth.json`.

With the sandbox off, bash is trusted with everything the owner's account can
reach; these rules stop only a command that names a protected path literally.
With the sandbox on, the OS enforces the boundary whatever the spelling: bash
cannot read or write `pi/` or an owner protected path, and cannot write any
control file. Protected `repos` are recorded in `protected_paths.json`, but no
runtime rule enforces them yet.

A missing `protected_paths.json` protects nothing. One that does not parse, or
lists anything but strings, stops every session (interactive, `pi-template
prompt`, and scheduled) before the permission rules are rebuilt, and
`pi-template doctor` reports not ready, naming the file, until the owner fixes
it or records the paths again with `pi-template onboard`
([rerun rules](onboarding.md)).

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
One that does not parse, or lacks part of its policy, stops every session and
fails `pi-template doctor`.

On, bash runs through the adapter and onboarding runs the probe. Off, bash runs
on the host with the owner's permissions through Pi's local executor, and
onboarding skips the probe. Either way a command sees only a short list of
environment variables (`PATH`, `HOME`, locale, certificate paths and the like),
so the daemon's own credentials stay out of transcripts.

The sandbox covers bash only; the file tools run in the harness process under
the [protected-path rules](#protected-paths) alone. On, a bash command writes
only under its write roots and cannot read or write an owner protected path,
which onboarding records in `sandbox.json`'s read denials. Whatever
`sandbox.json` records, the runtime adds `<harness home>/pi` to the sandbox's
read denials and every control file, the state database included, to its write
denials, without saving either to the file. It names them under the path the
macOS kernel matches: the home's real path in on-disk case and Unicode form,
without the `/System/Volumes/Data` firmlink prefix that `realpath` keeps. So a
control file not yet written is covered when the home is reached through a
symlink such as macOS `/var` or spelled through the firmlink. These denials back up the
[write-root rule](#write-roots-stay-outside-the-harness-home); neither is
removed. Reads outside `pi/` and the protected paths
are allowed by design, so bash can still read `daemon.json`, which
`pi-template` needs to reach the daemon. Off, a command
reaches everything the owner can except a literal protected path, so a glob or
`python3 -c` with a path it builds itself reads the model credentials.
`pi-template doctor` reads `sandbox.json` itself and reports `sandbox.enabled`,
so a hand edit shows at once.

### Write roots stay outside the harness home

With the sandbox on, no write root may contain the harness home. Containment
is decided by file identity (device and inode), not by comparing path strings:
a root contains the home when it is the same directory as the home or as any
directory above it, walking up the home as spelled, its real path, and the real
path of every directory on its spelling, so a symlink on that spelling counts
wherever the link lives. Letter case, Unicode form, `/tmp` against
`/private/tmp`, and the `/System/Volumes/Data` firmlink therefore cannot hide
the home. A root that does not exist yet contains the home only when the home
does not exist yet either, beneath the same existing directory and the same
names, compared case- and Unicode-insensitively. The sandbox library also lets
bash write its built-in paths (`/tmp/claude`, `/private/tmp/claude`,
`~/.npm/_logs`, `~/.claude/debug`, from `getDefaultWritePaths()`), so a home
inside one of those is refused the same way. A root the library would rewrite
before use is refused outright: one with glob characters (`*`, `?`, `[`, `]`;
the library drops a trailing `/**`), one starting with `~` (the library expands
it to `$HOME`), and a relative one (the library resolves it against the
daemon's working directory). A root whose spelling passes through a symlink
whose target does not exist is refused too: it has no file identity to compare,
and the target the link later reaches could lie above the home.
Onboarding refuses such a root before writing anything, naming the root and
the home; interactive onboarding checks the roots its review would propose
before it asks for authentication. Every sandboxed session (interactive, `pi-template prompt`, and
scheduled) refuses to start over a `sandbox.json` that records one, legacy and
hand-edited files included, with the same message and the recovery
`pi-template onboard --sandbox-write <dir>` (or, for a built-in path, moving
the home); `pi-template doctor` reports not ready. The check runs at every
session start, so a link an agent creates that makes a recorded root contain
the home stops later sessions rather than opening the home. A write root inside the home, such as its `workspace/`, is allowed.

Denying each dangerous path under such a root did not hold. Four audits each
escaped the sandbox through a write root that contained the home: a glob that
the path rules could not match edited `sandbox.json`; a schedule written into
`state.db` ran on the host; and with the home reached through a symlink inside
the write root, bash replaced the link with one to a home whose `sandbox.json`
was off, so the next session ran bash unsandboxed and the daemon would run that
home's schedules; and a string comparison of roots let a `/**` glob, a
different letter case or Unicode form, a firmlink spelling, or a home under
`/tmp/claude` through, after which bash replaced `logs/daemon.log` with a
symlink the daemon then appended to on the host. Removing the shared precondition closes the class rather
than the next path in it.

The rule covers the harness home only. A write root that contains another
place the host later runs from, such as `~/Library/LaunchAgents` or the
`pi-template` checkout, is the owner's choice.

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
