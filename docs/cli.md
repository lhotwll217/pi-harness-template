---
title: "Command-line interface"
summary: "The pi-template CLI: one command registry, JSON output, JSON usage errors, exit codes, and help as the guidance text"
read_when:
  - Adding or changing a pi-template command or verb
  - Calling pi-template from a script or another agent
  - Rendering the CLI's help or the schema descriptions into another surface, such as the system prompt
---

# Command-line interface

> **Status:** Implemented (`src/cli/commands`), including the harness agent's
> own use of it from `bash`.

The `pi-template` CLI is the harness's public interface for people, scripts,
and agents alike, the harness's own agent included. Every command traverses the
Gateway. The owner's starts the daemon when none is running
([Architecture](architecture.md)); the agent's never does.

## One command registry

Every command is a noun and its verbs in one [Commander](https://github.com/tj/commander.js)
tree, built in `src/cli/commands/registry.ts` with one module per noun. The
tree owns parsing and help at every level, adopted from Stitcher's registry
(`595ac4d`, then Commander in `f0ba616`). Building the tree has no side
effects, so printing help never loads the daemon.

## Output contract

| Outcome | stdout | stderr | Exit |
|---|---|---|---|
| Success | JSON payload | — | 0 |
| Failure | — | one JSON line: `error`, the Gateway's `status`, and any `hint` or `closest` | 1 |
| Usage mistake | — | one JSON line: `error` and a `hint` naming the right usage | 2 |
| `--help`, or a noun without a verb | prose help | — | 0 |

`doctor` prints its report and exits 1 when a check fails. Three entries are
not JSON commands: `prompt` prints the agent's answer, or with `--json` Pi's
event stream; `daemon` runs in the foreground; bare `pi-template` follows the
[entry behavior](onboarding.md#entry-behavior). JSON by default and JSON
usage errors follow Stitcher `914a47b` and `75db0d9`.

## Arguments

`notes add`, `docs query`, and `prompt` join their words into one text, dash
words included. A blank text, like any blank required argument, is a usage
mistake. Commander parses the words first, so the text differs from what was
typed in three ways: a `--` is dropped when it is the first word, and in
`prompt` anywhere; `-h` or `--help` prints help when it is the first word, and
in `prompt` anywhere before a `--`; and `prompt` reads `--json` anywhere as its
flag. `schedule add` runs the command after `--` exactly as given, refuses any
other stray word, and refuses a flag given twice. `db query` reads an argument
that opens with a dash, such as a `-- comment`, as its SQL, except `-h` or `--help`.

## Help is the guidance

Each verb's help ends in one shape: when to use it, what to use instead, what
to run next, its rules, and examples. `src/cli/commands/conventions.test.ts`
fails a verb whose help lacks examples or that writes stdout other than
through `emit()`.

`rootHelp()` and `helpPages()` in the registry return exactly what
`pi-template --help` and each `<command> --help` print, and `SCHEMA_DOCS` in
`src/state/schema-docs.ts` holds every table and column description. Another
surface renders these instead of restating them.

The agent's system prompt is one such surface. The bundled identity prompt
(`src/agent/prompts/pi-template.md`) marks where `helpTree()`, every page root
first, and `schemaReference()`, the schema descriptions as text, are rendered
in, so the agent starts each session with the whole help tree and schema
exactly as the CLI prints and serves them. `src/agent/identity-prompt.e2e.test.ts`
builds a real session and fails when any printed `--help` page is missing from
its prompt word for word. Embedding the whole tree rather than root help alone
follows Owner Operator `52fa55f`; Stitcher `0a261ec` embeds root help only.

## Agent callers

The harness agent runs this CLI in `bash` with `PI_TEMPLATE_AGENT=1` and
`PI_TEMPLATE_HOME` naming its session's home
([Security](security.md#the-agent-uses-its-own-cli) owns the environment, the
permission rules, and the agent's authority). As an agent caller the CLI:

- reaches the daemon over the agent socket `<home>/agent.sock`, never reads
  `daemon.json`, and writes nothing under the home;
- never starts a daemon: with none running it exits 1 with
  `{"error":"the pi-template daemon is not running","hint":"the owner starts it with \`pi-template status\`; the agent never starts it"}`;
- refuses the owner's commands, `onboard`, `daemon`, `prompt`, and bare
  `pi-template`, with exit 2 and `{"error":"<command> is the owner's command",...}`;
- returns `schedule run`'s started run at once instead of waiting for it, since
  one run happens at a time and a scheduled agent that waited would wait on
  itself.

`src/cli/commands/registry.test.ts` fails when a top-level command is neither
the agent's nor the owner's (`AGENT_CLI_COMMANDS` and `OWNER_CLI_COMMANDS` in
`packages/contracts/src/agent-cli.ts`).

## Reading the database

`pi-template db tables`, `db describe <table>`, and `db query '<SELECT>'` are
the CLI form of the [read-only query surface](state-and-sessions.md#read-only-query-surface),
which owns its guarantees.
