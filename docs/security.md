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

| Mode | Reads | The agent's CLI (`pi-template <command>` in `bash`) | `edit`, `write`, and writes a command names | Other `bash` |
|---|---|---|---|---|
| `allow` (default) | allow | allow | allow | allow |
| `ask` | allow | allow | ask | ask |
| `read-only` | allow | allow | deny | deny |

A fresh home defaults to `allow`, so the agent can act from its first turn. A
`settings.json` that records no mode also means `allow`; one that does not parse
or records an unknown mode means `read-only`, so a damaged choice never widens
access. In `read-only` the agent keeps `bash` for its own CLI only, and in
`ask` for its CLI and the commands the owner approves
([below](#the-agent-uses-its-own-cli)). A write a command names, such as the
redirect in `pi-template notes list > notes.json`, is judged by `path_write`,
which also judges the file tools: `ask` asks and `read-only` denies. The
harness owns the `*` key of `path_write`; `allow` removes it.

## The agent uses its own CLI

The agent reaches harness state the way the owner does: it runs `pi-template`
in `bash` ([Command-line interface](cli.md#agent-callers)). It has no data tool;
typed tools stay for results an App renders (Stitcher ADR 0001). Reconciling
the permission config removes the retired `query_database` and `save_note`
surfaces, and a stored schedule that allowed either now allows `bash`
([Scheduler](scheduler.md#permissions)).

**Environment.** The agent's `bash`, sandbox on or off, sees the short variable
list below plus `PI_TEMPLATE_HOME`, naming the session's home, and
`PI_TEMPLATE_AGENT=1`. Its `PATH` starts with the checkout, so `pi-template` is
the bare word the rules match, then the daemon's Node. `PI_TEMPLATE_PORT` and the
daemon's own variables stay out. Outside `allow` a plain CLI call sees only
`PATH`, `HOME`, `TMPDIR`, `PI_TEMPLATE_HOME`, and `PI_TEMPLATE_AGENT=1`.

**Rules.** Every mode gets one generated `bash` allow rule per agent command,
`pi-template db *`, `docs *`, `notes *`, `schedule *`, `status *`, and
`doctor *`, inserted directly after `*` unless the owner already wrote that
key. One rule per command rather than `pi-template *` keeps `onboard`, which
can rewrite the permission mode, out of the agent's reach in `read-only`. The
last matching rule wins, so an owner rule written after the generated ones,
such as `"pi-template db *": "deny"`, blocks the agent in every mode.

**Outside `allow`, the CLI never runs through a shell.** The permission
extension strips a leading `VAR=` before it matches, so
`PI_TEMPLATE_AGENT=0 pi-template schedule run <id>` or
`NODE_OPTIONS=… pi-template notes list` passes a generated rule, and an owner's
"for this session" approval of `ls` also passes
`ls; PI_TEMPLATE_AGENT=0 pi-template schedule add …`. The `bash` tool in `ask`
and `read-only` therefore decides by the command text, not by the permission
decision ([`agentCliArgv` and `namesAgentCli`](../src/agent/agent-cli-command.ts)):

1. A command that is exactly one `pi-template` call in plain words and `'…'` or
   `"…"` quotes runs the checkout's launcher with those arguments and the fixed
   environment above, through the sandbox when it is on.
2. Any other command with a word ending in `pi-template`, quotes and
   backslashes removed, is refused with a message naming the mode: after a
   `VAR=`, `env`, `command`, or a path, or inside a chain, subshell, or
   substitution. The match ignores case, since macOS's case-insensitive
   filesystem resolves `Pi-Template` to the launcher. The check is
   deliberately broad, so `cat notes/pi-template` is refused too.
3. Anything else runs in a shell in `ask`, with the `allow` environment, once
   the `*` rule has asked the owner; a headless run, with no one to ask, is
   denied. `read-only` refuses it.

The permission rules stay the first layer: an owner deny still wins. In
`allow` the agent's `bash` is a shell, trusted as the owner's.

**Chains.** The permission extension splits a command on `;`, `&&`, `||`, `|`,
`&`, and newlines, and descends into `$(…)`, backticks, and subshells; the most
restrictive part decides. In `pi-template db query "SELECT 1"; rm -rf workspace`
the `rm` is judged by `*`: denied in `read-only`, asked in `ask`, and run in
`allow`, as any command is there. The CLI rule never covers it, and in `ask` the
harness refuses the chain even when the owner approves it, since it names the
CLI.

**Spelling.** Rules match a command as typed, a leading `VAR=` stripped. A
different spelling, such as `pi-template "db" query`, a doubled space, or
`command pi-template`, misses both an owner deny and the generated allow, so it
falls to `*`: denied in `read-only`, asked in `ask` (where the harness still
refuses all but a plain call), and run in `allow`. An owner who
denies a CLI command in `allow` mode therefore relies on the agent spelling it
plainly; this is a limit of the permission extension, not normalized here.

**Authority.** The daemon serves the agent on a second Gateway listener, the
unix socket `agent.sock` in the harness home (mode `0600`), and grants every
request there agent authority, decided by the listener and never by anything
the client sends. Each route declares its caller policy in one table in
`src/gateway/server.ts`: whether an agent caller may call it, and whether it
waits for onboarding; the owner may call every route. A socket rather than loopback TCP, because sandbox-runtime
0.0.65 admits one unix socket by path but opens loopback only as every port at
once. The chat and workspace file routes are the owner's: an agent caller gets
403 `owner_only`, because the daemon writes transcripts and files outside the
sandbox and the agent's path policy, and the agent has its own file tools.
An agent caller may use every other route except creating a command
schedule, changing a schedule to or from one, and running one: the daemon runs
command schedules on the host, outside the sandbox, so each of those returns
403 and changes nothing. The check reads the stored schedule in the same step
as the write or the run, so an owner's change in between cannot slip past it.
The owner's loopback TCP listener, with the token in
`daemon.json`, keeps full authority. The agent may still delete notes and
schedules, in `read-only` too: read-only protects files and the host, not
product actions (Stitcher ADR 0001).

**What holds where.** In `read-only`, `bash` runs nothing but the CLI as an
agent caller, sandbox on or off, so agent authority is all it has. In `ask` it
also runs each command the owner approves, which holds only what `allow` holds
below. A command that assembles the CLI's name at run time names no word the
harness refuses, but no generated rule matches it either, so the owner is
asked. In `allow` with the sandbox on, `bash` cannot read `daemon.json` and can reach no network
but the agent socket, so the same holds. In `allow` with the sandbox off,
`bash` is trusted with the owner's account: it can read `daemon.json` through a
glob or clear `PI_TEMPLATE_AGENT`, which is all that makes the CLI an agent
caller, so the authority check is policy there, not a boundary. The agent's CLI
never starts a daemon, a client-side choice: starting one would not raise its
authority.

**Reachability.** `pi-template doctor` reports whether the agent can reach the
CLI and counts it toward ready (onboarding's own readiness check leaves it out,
since setup may finish before any daemon runs). It checks, without running a
command, that the launcher and Node exist, that the daemon answers on the agent
socket, and that the sandbox can admit the socket. sandbox-runtime admits one
unix socket by path only on macOS, so with the sandbox on elsewhere the agent
cannot reach the CLI, and doctor says so. A unix socket path holds at most 104
bytes on macOS (107 on Linux). A longer `agent.sock` path, a file there that is
not a socket, or another daemon already answering there leaves the daemon
running without the socket, and doctor names which.

## Interactive and headless authority

Interactive runs may ask the owner when policy allows. Headless runs cannot
manufacture consent: an operation that would require approval in an interactive
session is denied unless a separately reviewed headless policy grants it.
Scheduled runs also narrow their tool set to the tools declared by the
schedule snapshot.

A Gateway chat turn is headless too: no one can answer an approval mid-turn.
In `ask` its plain `pi-template` calls still run, and every call that would ask,
such as other `bash`, `edit`, or `write`, is denied and reaches the model as a
tool error. A chat turn otherwise has the full tool posture.

**Workspace file writes.** The file routes walk from the workspace's real path
with `lstat` and refuse every link, then write through an `O_EXCL|O_NOFOLLOW`
temporary file and a rename. Node has no `openat` or `renameat`, so a local
process that swaps a checked folder for a link between the walk and the rename
can still redirect a write; with owner-only routes, that means agent `bash`
racing the owner's save.

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
  agent reaches the state database through `pi-template` over the daemon's
  agent socket, which names no path.

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
onboarding skips the probe. Either way bash takes Pi's timeout bounds, and a
timeout or abort stops the command's whole process group: on, with SIGTERM and
SIGKILL one second later; the tool returns then even if a descendant that left
the group still holds its output. Either way a command sees only a short list of
environment variables (`PATH`, `HOME`, locale, certificate paths and the like)
and the two that [point its CLI at the home](#the-agent-uses-its-own-cli), so
the daemon's own credentials stay out of transcripts.

The sandbox covers bash only; the file tools run in the harness process under
the [protected-path rules](#protected-paths) alone. On, a bash command writes
only under its write roots and cannot read or write an owner protected path,
which onboarding records in `sandbox.json`'s read denials. Whatever
`sandbox.json` records, the runtime adds `<harness home>/pi` and `daemon.json`
to the sandbox's read denials, every control file, the state database included,
to its write denials, and the agent socket as the one unix socket bash may
connect to, without saving any of them to the file. It names them under the path the
macOS kernel matches: the home's real path in on-disk case and Unicode form,
without the `/System/Volumes/Data` firmlink prefix that `realpath` keeps. So a
control file not yet written is covered when the home is reached through a
symlink such as macOS `/var` or spelled through the firmlink. These denials back up the
[write-root rule](#write-roots-stay-outside-the-harness-home); neither is
removed. Reads outside `pi/`, `daemon.json`, and the protected paths
are allowed by design. Off, a command
reaches everything the owner can except a literal protected path, so a glob or
`python3 -c` with a path it builds itself reads the model credentials and the
Gateway token.
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
