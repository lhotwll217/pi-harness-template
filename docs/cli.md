---
title: "Command-line interface"
summary: "The pi-template CLI: one command registry, JSON output, JSON usage errors, exit codes, and help as the guidance text"
read_when:
  - Adding or changing a pi-template command or verb
  - Calling pi-template from a script or another agent
  - Rendering the CLI's help or the schema descriptions into another surface
---

# Command-line interface

> **Status:** Implemented (`src/cli/commands`). The agent still reaches state
> through its typed tools; package 19 in [Porting](porting.md) moves it onto
> this CLI.

The `pi-template` CLI is the harness's public interface for people, scripts,
and agents alike. Every command traverses the Gateway, starting the daemon
when none is running ([Architecture](architecture.md)).

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
other stray word, and refuses a flag given twice.

## Help is the guidance

Each verb's help ends in one shape: when to use it, what to use instead, what
to run next, its rules, and examples. `src/cli/commands/conventions.test.ts`
fails a verb whose help lacks examples or that writes stdout other than
through `emit()`.

`rootHelp()` and `helpPages()` in the registry return exactly what
`pi-template --help` and each `<command> --help` print, and `SCHEMA_DOCS` in
`src/state/schema-docs.ts` holds every table and column description. Another
surface renders these instead of restating them.

## Reading the database

`pi-template db tables`, `db describe <table>`, and `db query '<SELECT>'` are
the CLI form of the [read-only query surface](state-and-sessions.md#read-only-query-surface),
which owns its guarantees.
