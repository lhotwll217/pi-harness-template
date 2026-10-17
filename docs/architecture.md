---
title: "Architecture"
summary: "The intended harness core: system boundaries, module ownership, roots, and dependency direction"
read_when:
  - Deciding where future implementation belongs
  - Evaluating whether a capability belongs in the reusable harness core
  - Tracing which module should own a behavior or boundary
---

# Architecture

> **Status:** Partially implemented. Contracts, State, and the daemon/Gateway
> skeleton exist; the source map below marks each module.

Pi Harness Template is a local-first harness core for Pi-based products. The
harness core is responsible for lifecycle, trust, continuity, and automation
primitives, and every module doubles as a demonstration a product can copy. The
product using the harness owns user experience, domain workflows, and any public
surface beyond the explicitly chosen harness interfaces. The template's own
chosen surface is self-description: the
[documentation interface](docs-interface.md) and the read-only
[database query surface](state-and-sessions.md#read-only-query-surface).

## System boundary

```text
human · coding agent · product client
                  │
        CLI / authenticated Gateway
                  │
     daemon: composition + process lifecycle
                  │
  ┌───────────────┼───────────────┐
state          scheduler       Pi runtime
durable truth  time + runs      agent sessions
```

The daemon is a process boundary and composition root, not a domain layer. The
Gateway is a transport adapter, not a second application core. Product-specific
interfaces may use the Gateway client without moving their behavior into the
harness core.

## Runtime roots

Code and mutable agent state have different owners:

| Root | Intended responsibility |
|---|---|
| Install root | Executable code and bundled prompts, tools, skills, and extensions |
| Harness home | Configuration, credentials, durable state, transcripts, logs, and daemon files |
| Agent workspace | Persistent owner instructions, artifacts, and workspace skills |
| Task working directory | Files and commands targeted by one interactive or scheduled run |

Entry points may create missing harness-owned files, but must not overwrite
owner-authored workspace content.

## Module ownership

These are conceptual seams, not approved package paths:

| Module | Owns | Does not own |
|---|---|---|
| Contracts | Shared types, pure rules, wire shapes, configuration boundaries | Database, network, timers, processes, model calls |
| State | Durable schema, transactions, migrations, projections, post-commit events | Timers, transport, model calls |
| Pi runtime | Explicit resource loading, agent sessions, Gateway chats, tools, skills, permissions integration | Global timers, direct durable-state writes |
| Workspace files | Reading, writing, and listing the owner's files inside the workspace | Harness entries, links, anything outside the workspace |
| Scheduler | Trigger evaluation, execution policy, isolated runs, run history through State | Gateway transport, private database access |
| Gateway | Authenticated loopback protocol and client translation | Durable ownership, child processes, timers, model behavior |
| Daemon | Composition, readiness, discovery, process and shutdown lifecycle | Product decisions or duplicated domain rules |
| CLI | Human- and agent-facing commands over stable contracts | Durable state, privileged runtime access, or product behavior |

Dependencies point toward contracts and owning seams, following the layering
proven in Owner Operator:

```text
contracts ← state ← {Pi runtime, scheduler, Gateway server} ← daemon
contracts ← Gateway client ← {CLI, product clients}
```

State is the one concrete module other application modules may import; the
scheduler and Pi runtime persist through the typed State interface rather than
private database access. The Gateway server receives module interfaces from the
daemon at composition time and does not import scheduler, state, or Pi-runtime
implementations. The daemon selects and supplies concrete adapters at the
composition root.

## Durable truth and events

State is the only production writer of durable harness truth. A successful
transaction may publish a typed, fail-isolated event after commit. Events tell
consumers what class of truth changed; consumers refetch the current projection
instead of treating event payloads as another database.

The concrete store is SQLite through Node's built-in `node:sqlite`, converging
on Owner Operator's choice: zero external dependency, transactional, and
single-file. The adapter must preserve transactions, migrations, recovery, and
single-writer semantics. What the template's database demonstratively stores
remains an open decision. See [State and sessions](state-and-sessions.md).

## Daemon discovery and recovery

The daemon publishes `daemon.json` in the harness home (port, pid, start time,
runtime fingerprint, bearer token, mode `0600`) once its Gateway listens. A CLI
command trusts the record only when an authenticated `/health` agrees with it on
pid and fingerprint in two consecutive probes, each bounded at one second, so a
daemon that answers once and then stalls gets the same diagnostic as one that
stalls from the start. `status` prints the confirming probe's health and
readiness instead of requesting them again, so a daemon that stalls after both
probes cannot hang it. `/health` also reports the daemon's `repoRoot`; a client
in another checkout connects to that daemon and is served by its code.

The record survives a crash, so the client treats a failed probe as evidence,
not proof, of a dead daemon. It starts a fresh daemon when the pid has exited,
when the connection is refused, or when it can bind the recorded port; this
covers a pid reused by an unrelated process. Otherwise the recorded process is
alive and holds the port (for example a hung daemon or a wrong token), and the
command fails with the pid, address, probe failure, and a manual recovery
command instead of starting a second daemon. The diagnostic gives
`launchctl kickstart -k` when `launchctl print` reports that the LaunchAgent for
this harness home runs that pid, and `kill <pid>` otherwise. It never prints the
bearer token. A closing daemon removes `daemon.json` only while the record still
names it, so a replacement's record survives.

When the CLI starts a daemon and the installed LaunchAgent names this harness
home (its `PI_TEMPLATE_HOME` entry, read in either the layout onboarding writes
or the one `plutil -convert xml1` writes, compared as resolved real paths),
launchd starts it: `launchctl enable`
and `launchctl kickstart` without `-k` on `gui/<uid>/com.pi-template.daemon`, so
a job launchd already runs (restarted by `KeepAlive`, or started by a concurrent
command) is left alone while its record appears. When launchd reports the job
not loaded (exit 3 or 113), the CLI runs `launchctl bootstrap` of the plist and
a second kickstart; a failed bootstrap is accepted when `launchctl print` then
finds the job loaded, since a concurrent command bootstrapped it. Any other
`launchctl` failure, or a call that takes over five seconds, fails the command
rather than starting a detached daemon that would hold the port the
LaunchAgent's `KeepAlive` restarts need. The command first records the pid
`launchctl print` reports. If no reachable daemon publishes its record within
15 seconds while launchd still runs that pid (for example after `daemon.json`
was removed by hand), the command names the pid and gives
`launchctl kickstart -k` instead of killing it; when launchd started the job
during the command and it never became ready, the command says so and points
at the daemon log. Without that LaunchAgent the CLI
starts a detached `pi-template daemon` from its own checkout. A reachable daemon
is never restarted, whichever checkout it runs from.

Onboarding's service install boots out the loaded job before it bootstraps the
new plist. `launchctl bootout` returns only after the job exits, and the daemon
has no shutdown bound of its own (a draining scheduler waits out each run's
timeout), so the plist pins `ExitTimeOut` at five seconds, launchd's default
for user agents, after which launchd sends `SIGKILL`. Bootout gets that plus
the five-second call bound; one that runs past it fails the install with that
cause instead of leaving bootstrap to fail against the job still loaded.

This adopts Owner Operator's recovery rules
([`039359a`](https://github.com/lhotwll217/owner-operator/commit/039359a),
[`643f99d`](https://github.com/lhotwll217/owner-operator/commit/643f99d),
[`b548896`](https://github.com/lhotwll217/owner-operator/commit/b548896),
[`7e1aa60`](https://github.com/lhotwll217/owner-operator/commit/7e1aa60)) and its
launchd start sequence (`startDaemonProcess` in `src/daemon/ensure.ts` at
[`21d5d29`](https://github.com/lhotwll217/owner-operator/blob/21d5d29/src/daemon/ensure.ts)).
Owner Operator decides launchd ownership by comparing the home with its default
path; this harness's plist records its home, so the check reads that entry.
Owner Operator kickstarts with `-k`, which kills a running job; this harness
drops `-k` because it starts a daemon only when discovery is absent or stale.

## Trust boundary

Onboarding must complete before headless or model-driven work is permitted.
Capabilities, approvals, protected data, and operating-system enforcement are
separate controls. Pi resources are loaded from one explicit agent definition;
ambient project resources are not automatically trusted. See
[Security](security.md) and [Onboarding](onboarding.md).

## Source map

`packages/contracts` is implemented; the `src/` modules are planned and land in
[porting](porting.md) order.

```text
packages/
  contracts/   stable types, pure rules, wire shapes, config readers (implemented)
src/
  state/       durable store, events, read-only query surface (implemented)
  agent/       owned Pi runtime, onboarding, sandbox adapter, tools (implemented)
  scheduler/   triggers, queue, and isolated execution (implemented)
  workspace/   the owner's workspace files over the Gateway (implemented)
  gateway/     authenticated loopback transport, routes, and client (implemented)
  daemon/      composition, lifecycle, and service management (implemented)
  cli/         the pi-template executable and interactive session (implemented)
apps/
  web/         the template's App, a Gateway consumer outside the core (web-app.md)
```

## Harness-core exclusions

- Product UI, widgets, channel bridges, monitoring views, and business workflows.
  The template's own [web app](web-app.md) lives in `apps/`, outside the core,
  and reaches the harness only through the Gateway.
- A second plugin runtime beside Pi extensions.
- A requirement to expose all internal state or behavior publicly.
- Publishing bundled extensions as independent packages. Private extraction may
  be considered after a real second local consumer exists; external publication
  is a separate product decision outside the template.

## Adopted by convergence

Decisions already proven in Owner Operator and OpenClaw are adopted rather than
reopened:

- Pi lineage: the `@earendil-works` Pi toolkit (`pi-ai`, `pi-coding-agent`,
  `pi-tui`) plus the `@gotgenes/pi-permission-system`, pinned at port time.
- Durable store: SQLite via Node's built-in `node:sqlite`.
- Gateway transport: loopback (`127.0.0.1`) HTTP + SSE with timing-safe
  bearer-token authentication, as in Owner Operator's gateway and following
  OpenClaw's authenticated-loopback-gateway posture.
- Scheduler seam: one typed service facade shared by the Gateway and tests, in
  the style of OpenClaw's `CronServiceContract`; calendar math via Croner.
- Run history: durable run records live in SQLite through State (Owner
  Operator's pattern), rejecting OpenClaw's separate JSONL run log to preserve
  the single-durable-writer rule.
- Docs catalog: a deterministic frontmatter parser in the OpenClaw
  `docs-list` style (see [Self-documentation](self-documentation.md)).

## Decided

- Naming: executable `pi-template`, packages `@pi-template/*`, harness home
  `~/.pi-template/`, or `PI_TEMPLATE_HOME` when it is set and not empty.
- Every CLI command traverses the Gateway; there is no direct-filesystem CLI
  path. Model-free docs routes are served before onboarding completes under the
  fail-closed rule's diagnostics exception.
- The database stores harness bookkeeping plus one deliberately trivial
  `notes` worked example (see
  [State and sessions](state-and-sessions.md#worked-example-notes)).
- OS sandbox enforcement adopts `@anthropic-ai/sandbox-runtime` behind the
  replaceable adapter (see [Security](security.md#sandbox-adapter-boundary)).

## Open decisions

- Initial global concurrency, queue fairness, and retention defaults
  (owned by [Scheduler](scheduler.md)).
- Event delivery guarantees across Gateway clients
  (owned by [State and sessions](state-and-sessions.md)).

## Design references

This design was distilled from the current
[Owner Operator architecture](https://github.com/lhotwll217/owner-operator/blob/0d314721831d2c760c77feb67124859626ddbd47/docs/architecture.md)
and Pi integration practices. It adopts ownership patterns, not Owner Operator's
product behavior or source code. Scheduler-specific provenance lives with the
[scheduler contract](scheduler.md#design-references).
