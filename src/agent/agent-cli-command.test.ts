import assert from "node:assert/strict";
import { agentCliArgv } from "./agent-cli-command";

const accepted: Array<[string, string[]]> = [
  ["pi-template notes list", ["notes", "list"]],
  ["  pi-template\tstatus  ", ["status"]],
  [`pi-template db query 'SELECT count(*) AS n FROM notes'`, ["db", "query", "SELECT count(*) AS n FROM notes"]],
  [`pi-template db query "SELECT * FROM notes WHERE body = 'milk'"`, ["db", "query", "SELECT * FROM notes WHERE body = 'milk'"]],
  [`pi-template notes add "buy milk"`, ["notes", "add", "buy milk"]],
  [`pi-template schedule add --every 1d --name="daily summary" --prompt 'it''s due'`, ["schedule", "add", "--every", "1d", "--name=daily summary", "--prompt", "its due"]],
  [`pi-template notes add ""`, ["notes", "add", ""]],
  ["pi-template docs read cli.md", ["docs", "read", "cli.md"]],
  ["pi-template schedule run 0b7e-41,a@x%y+z:/w", ["schedule", "run", "0b7e-41,a@x%y+z:/w"]],
];
for (const [command, argv] of accepted) assert.deepEqual(agentCliArgv(command), { argv }, command);

const refused: Array<[string, string]> = [
  ["", "it is empty"],
  ["ls", "its first word is not pi-template"],
  ["./pi-template notes list", "its first word is not pi-template"],
  ["PI_TEMPLATE_AGENT=0 pi-template schedule run 1", "its first word is not pi-template"],
  ["NODE_OPTIONS=--import=data:text/javascript,x pi-template notes list", "its first word is not pi-template"],
  ["env PI_TEMPLATE_AGENT=0 pi-template status", "its first word is not pi-template"],
  ["pi-template notes list > notes.json", "it has > outside quotes"],
  ["pi-template notes list; rm -rf workspace", "it has ; outside quotes"],
  ["pi-template notes list && ls", "it has & outside quotes"],
  ["pi-template notes list | cat", "it has | outside quotes"],
  ["pi-template notes list\nls", "it has a control character"],
  ["pi-template notes add $HOME", "it has $ outside quotes"],
  [`pi-template notes add "$(id)"`, "it has $ inside double quotes"],
  ["pi-template notes add `id`", "it has ` outside quotes"],
  [`pi-template notes add "a\\"b"`, "it has \\ inside double quotes"],
  ["pi-template notes add a\\ b", "it has \\ outside quotes"],
  ["pi-template docs read *.md", "it has * outside quotes"],
  ["pi-template docs read ?", "it has ? outside quotes"],
  ["pi-template docs read [a]", "it has [ outside quotes"],
  ["pi-template docs read ~/x", "it has ~ outside quotes"],
  ["pi-template docs read {a,b}", "it has { outside quotes"],
  ["pi-template status # comment", "it has # outside quotes"],
  ["pi-template status (x)", "it has ( outside quotes"],
  ["pi-template notes add 'unterminated", "a quote is not closed"],
  [`pi-template notes add "unterminated`, "a quote is not closed"],
];
for (const [command, reason] of refused) assert.deepEqual(agentCliArgv(command), { refused: reason }, command);

process.stdout.write("ok — the agent CLI splitter accepts plain pi-template argv and refuses every shell construct\n");
