---
title: "State and sessions"
summary: "The intended durable truth, session continuity, provenance, transactions, events, and read-only query surface"
read_when:
  - Designing persistence or session lifecycle behavior
  - Deciding what may write durable harness state
  - Tracing resume, fork, recovery, or provenance requirements
  - Working on `pi-template db` or schema documentation
  - Working on Gateway chats, their transcripts, or their events
---

# State and sessions

> **Status:** State machinery is implemented (`src/state`): migrations, notes,
> schedules and runs, post-commit events, startup recovery, and the read-only
> query surface. Gateway chats are implemented ([Chats](#chats)). Session
> lifecycle beyond them and provenance records remain planned.

The harness needs one durable source of truth for configuration state,
onboarding, sessions, schedules, run history, and provenance. State owns that
truth through transactions and migrations; clients and modules do not maintain
competing durable projections.

## State boundary

- One production writer owns the durable store.
- Other modules use a typed State interface rather than private database access.
- Multi-record changes commit atomically when partial success would violate an invariant.
- Schema and contract changes are versioned and migratable.
- Recovery is explicit; startup never silently discards or recreates durable truth.
- Read projections may be cached in memory, but the store remains authoritative.

The concrete store is SQLite through Node's built-in `node:sqlite`, converging
on Owner Operator's choice: zero external dependency, transactional, and a
single file under the harness home. What the template's database
demonstratively stores beyond harness bookkeeping is an open decision.

## Read-only query surface

State also owns a read-only query surface with progressive disclosure,
converging on Owner Operator's pattern. Its one consumer is the `pi-template db`
CLI noun ([Command-line interface](cli.md)), which the owner runs in a terminal
and the agent runs in bash ([Security](security.md#the-agent-uses-its-own-cli)).

1. **List tables** — names, row counts, and one-line descriptions.
2. **Describe one table** — columns with types, constraints, and descriptions.
3. **Run a bounded `SELECT`** — one statement, results capped at 200 rows and
   1 MB of JSON, with an explicit truncation flag telling the caller to narrow
   the query.

Read-only is enforced by SQLite, not by statement inspection: the query runs on
a read-only handle whose authorizer permits only reads, so any write, `ATTACH`,
`PRAGMA`, or `VACUUM` is refused and the data is left unchanged. SQL after the
first statement is refused rather than dropped, and SQL with no statement is
refused. Each query runs in its own Node process because `node:sqlite` cannot
interrupt a running statement; a worker thread in that process stops it after 5
seconds, so the limit holds even when the daemon dies first, and the daemon
stops it one second later if that thread could not run. A refusal carries a hint
where one fits, and a query or describe naming a missing table names the
closest real tables. This follows Stitcher `1f63ce4` and `cc5e8c8`.

Table and column descriptions come from a git-tracked schema-docs module
versioned with the writers, never from the database file, so the documentation
is a reviewed prompt surface and drift between code and store is visible as an
undocumented column. Alongside the [documentation interface](docs-interface.md),
this is one of the template's two demonstrative self-description primitives.

## Session concepts

The stable vocabulary should support:

- **Create:** start a new Pi session with its own durable identity and transcript.
- **Resume:** continue an existing session without losing its provenance or ordering.
- **Fork:** create a new session whose lineage points to prior context without
  making two writers compete for one transcript.
- **Complete/retain:** close active work while preserving the audit ledger under
  an explicit retention policy.

Operations for one session are serialized. Separate sessions may run
concurrently within global policy.

## Provenance

Every session records its origin: interactive caller, external harness,
scheduled prompt, or another approved surface. Scheduled work also records job
and run identity. Provenance is immutable context attached at session creation
and propagated to tool and command boundaries.

## Chats

A chat is a Pi session whose transcript sits in `<home>/transcripts/chats/`;
its id is the Pi session id, which the client mints (a UUID) and the first
message creates. Pi lists a session folder without descending into it, so the
TUI's `/resume` never offers a chat, and nothing but the daemon opens one: the
daemon is the only writer of chat transcripts. The Gateway routes
(`src/gateway/server.ts`) serve the `ChatService` in `src/agent/chat-service.ts`.

- **One turn per chat.** A second message to a chat whose turn is running, or a
  delete, answers 409 `chat_busy` and touches nothing. Separate chats run
  concurrently.
- **A fresh session per turn.** Each turn builds a headless harness session in
  the workspace, so every session start check runs on every turn; a refused
  check answers 503 `session_refused` and writes nothing; its message names
  files by their last path segment only. A transcript the daemon cannot read
  or write answers 500 `filesystem_error` with the chat id and the error code.
  An untyped Gateway error has each absolute path cut to its last segment.
  Provenance records
  `origin: "gateway-chat"` with the chat and turn ids once Pi accepts the turn. The message goes to the
  model as typed: no slash commands, skill commands, or prompt templates.
- **The reply streams** as NDJSON on the `POST /chats/:id/messages` response:
  `turn.started`, `text.delta`, `tool.started`, `tool.finished`, and last
  `turn.finished` with `completed`, `cancelled`, or `failed`. A client that
  disconnects stops only the stream; `POST /chats/:id/cancel` stops the turn,
  and Pi keeps the partial reply in the transcript. A cancelled turn reports
  `cancelled` even when Pi ends it as an error, as when the cancel lands
  during a tool call; the transcript marks it with a
  `pi-template-turn-cancelled` entry so it reads `cancelled` later too.
- **A chat reads as** text and tool calls only: each user message, then one
  assistant message folding the replies and tool results up to the next user
  message, with Pi's thinking dropped. A turn that ended without a reply and
  no longer runs, as when the daemon stopped mid-turn, reads `interrupted`.
- **Title** is the name set by `PATCH /chats/:id` (Pi's `session_info`, up to
  200 characters on one line, without C0 or C1 control characters, U+2028 or
  U+2029, or bidirectional overrides; else 400 `invalid_request`), else the first
  message.
- **Delete** renames the transcript to `<file>.deleted-<time>`, out of the
  listing; nothing is unlinked, and no retention policy reclaims the space yet.
- **Shutdown** cancels running turns before the daemon stops, so each keeps its
  partial reply, and refuses new messages with 503 `daemon_stopping`.

`pi-template prompt --chat <id> <message>` sends one turn to a chat through the
Gateway; the run state lives only in the daemon's memory.

## Events

State publishes typed events only after successful commit. Subscribers treat an
event as an invalidation and refetch current truth. Delivery may be
fail-isolated and best effort because restart reconciliation uses the durable
store, not the event stream, to recover.

The chat service and the workspace files publish on the same bus, so `/events`
orders their invalidations with State's: `chat.changed` with the chat id when a
turn's message is saved, when the turn ends, and on rename or delete (never per
token), and `workspace.changed` once per file write through the Gateway and
once per finished `write`, `edit`, or `bash` call in a chat. Edits made outside
the daemon, in the owner's editor, the TUI, or a scheduled run, raise no
`workspace.changed`; a client refetches on `schedule-run.changed` and when it
regains focus.

## Record families

The database stores the harness's own bookkeeping — configuration/onboarding,
sessions and lineage, schedules, schedule runs, and migration metadata — plus
one worked example. The harness's operational truth is itself the primary
demonstration: querying your own runs and sessions through the read-only
surface is genuinely useful. Columns and indexes belong with the executable
schema and its schema-docs module.

## Worked example: notes

`notes` is a deliberately trivial record family (id, body, timestamps) that
exists to demonstrate the full write-to-read pattern without resembling a
product feature. Its one writer is the `pi-template notes` CLI, traversing the
Gateway to one State method. The owner runs it in a terminal; the agent runs the
same commands in bash, over the daemon's agent socket.

Two callers, one interface, one durable owner. The example shows a State transaction, the
post-commit event, schema-docs entries, and visibility through the read-only
query surface end to end. A product copies this pattern for its real record
families and deletes `notes`.

## Open decisions

- Migration approach on top of `node:sqlite` (must land with the first State
  implementation; recovery is unimplementable without it).
- Transcript format, location, and retention defaults.
- Event delivery guarantees inside one process and across Gateway clients.
