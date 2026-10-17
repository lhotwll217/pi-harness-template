import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessPaths } from "@pi-template/contracts";
import { helpPages, rootHelp } from "./registry";

const executable = join(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."), "pi-template");
const home = mkdtempSync(join(tmpdir(), "pi-template-cli-help-"));
const piTemplate = (...args: string[]) => {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env: { ...process.env, PI_TEMPLATE_HOME: home, PI_TEMPLATE_PORT: "0" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

try {
  const top = piTemplate("--help");
  assert.equal(top.status, 0, top.stderr);
  assert.equal(top.stdout, rootHelp(), "rootHelp() is what the terminal prints");
  assert.match(top.stdout, /^Usage: pi-template <command> \[<verb>\] \[args\]$/m);
  assert.match(top.stdout, /^ {2}db +read-only SQL over the harness's state database$/m);

  const pages = helpPages();
  assert.deepEqual(pages.map(({ command }) => command), [
    "pi-template",
    "pi-template db", "pi-template db tables", "pi-template db describe", "pi-template db query",
    "pi-template docs", "pi-template docs list", "pi-template docs read", "pi-template docs query",
    "pi-template notes", "pi-template notes add", "pi-template notes list", "pi-template notes remove",
    "pi-template schedule", "pi-template schedule list", "pi-template schedule add",
    "pi-template schedule remove", "pi-template schedule run",
    "pi-template status", "pi-template doctor", "pi-template onboard", "pi-template prompt", "pi-template daemon",
  ]);
  assert.equal(pages[0]!.help, rootHelp());
  for (const path of ["pi-template db", "pi-template db query", "pi-template schedule add"]) {
    const printed = piTemplate(...path.split(" ").slice(1), "--help");
    assert.equal(printed.stdout, pages.find(({ command }) => command === path)!.help, `${path} page is what the terminal prints`);
  }

  const verb = piTemplate("docs", "read", "--help");
  assert.equal(verb.status, 0, verb.stderr);
  assert.equal(verb.stdout, [
    "Usage: pi-template docs read [options] <id>",
    "",
    "one page's Markdown",
    "",
    "Options:",
    "  -h, --help  display help for command",
    "",
    "Use when: docs query or docs list named the page that owns your question.",
    "",
    "Examples:",
    "  pi-template docs read scheduler",
    "",
  ].join("\n"));

  for (const name of ["db", "docs", "notes", "schedule"]) {
    const bare = piTemplate(name);
    assert.equal(bare.status, 0, name);
    assert.equal(bare.stderr, "", name);
    assert.equal(bare.stdout, piTemplate(name, "--help").stdout, name);
    assert.match(bare.stdout, new RegExp(`^Usage: pi-template ${name} \\[options\\] \\[command\\]$`, "m"));
  }

  const usageError = (args: string[], expected: { error: string; hint: string }) => {
    const result = piTemplate(...args);
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `${JSON.stringify(expected)}\n`);
  };
  usageError(["docs", "read"], {
    error: "missing required argument 'id'",
    hint: "Usage: pi-template docs read [options] <id>. `pi-template docs read --help` shows its flags and examples.",
  });
  usageError(["db", "query"], {
    error: "missing required argument 'sql'",
    hint: "Usage: pi-template db query [options] <sql>. `pi-template db query --help` shows its flags and examples.",
  });
  usageError(["docs", "lst"], { error: "unknown command 'lst' (Did you mean list?)", hint: "`pi-template docs --help` lists its verbs." });
  usageError(["docs", "list", "--frob"], {
    error: "unknown option '--frob'",
    hint: "Usage: pi-template docs list [options]. `pi-template docs list --help` shows its flags and examples.",
  });
  const scheduleUsage = "Usage: pi-template schedule add (--at <iso> | --every <duration> | --cron <expr> --tz <zone>) " +
    "(--prompt <text> | -- <argv...>). `pi-template schedule add --help` shows its flags and examples.";
  usageError(["schedule", "add"], { error: "schedule add needs exactly one of --at, --every, or --cron", hint: scheduleUsage });
  usageError(["schedule", "add", "--every", "1m"], {
    error: "schedule add needs one payload: --prompt <text> or -- <argv...>",
    hint: scheduleUsage,
  });
  for (const [typo, words] of [["node", "node task.mjs"], ["promt", "promt x"]] as const) {
    usageError(["schedule", "add", "--every", "1h", ...words.split(" ")], {
      error: `unexpected argument '${typo}'; put the command to run after --`,
      hint: scheduleUsage,
    });
  }
  for (const [flag, value, payload] of [
    ["--at <iso>", "2026-10-01T09:00:00Z", ["--prompt", "x"]],
    ["--every <duration>", "1h", ["--prompt", "x"]],
    ["--cron <expr>", "0 9 * * *", ["--tz", "UTC", "--prompt", "x"]],
    ["--tz <zone>", "UTC", ["--cron", "0 9 * * *", "--prompt", "x"]],
    ["--name <name>", "twice", ["--every", "1h", "--prompt", "x"]],
    ["--prompt <text>", "x", ["--every", "1h"]],
    ["--timeout <seconds>", "10", ["--every", "1h", "--prompt", "x"]],
  ] as const) {
    const [long] = flag.split(" ");
    usageError(["schedule", "add", ...payload, long!, value, long!, value], {
      error: `option '${flag}' argument '${value}' is invalid. ${long} may be provided only once`,
      hint: scheduleUsage,
    });
  }
  const promptWithDash = piTemplate("prompt", "how", "do", "I", "use", "-v");
  assert.equal(promptWithDash.status, 1, "a dash word is part of the prompt, so parsing reaches the setup check");
  assert.deepEqual(JSON.parse(promptWithDash.stderr), {
    error: "setup required before talking to the agent; run `pi-template` in an interactive terminal",
  });
  for (const [args, name, usage] of [
    [["prompt", ""], "message", "prompt [options] <message...>"],
    [["prompt", "  "], "message", "prompt [options] <message...>"],
    [["notes", "add", "  "], "body", "notes add [options] <body...>"],
    [["docs", "query", ""], "question", "docs query [options] <question...>"],
    [["db", "query", " "], "sql", "db query [options] <sql>"],
    [["db", "describe", ""], "table", "db describe [options] <table>"],
    [["docs", "read", ""], "id", "docs read [options] <id>"],
    [["notes", "remove", " "], "id", "notes remove [options] <id>"],
    [["schedule", "run", ""], "id", "schedule run [options] <id>"],
    [["schedule", "remove", ""], "id", "schedule remove [options] <id>"],
  ] as const) {
    const path = `pi-template ${usage.split(" [")[0]}`;
    usageError([...args], {
      error: `required argument '${name}' is blank`,
      hint: `Usage: pi-template ${usage}. \`${path} --help\` shows its flags and examples.`,
    });
  }
  usageError(["frobnicate"], { error: "unknown command 'frobnicate'", hint: "`pi-template --help` lists its commands." });
  assert.equal(existsSync(harnessPaths(home).daemonInfo), false, "help and usage errors never start the daemon");
} finally {
  rmSync(home, { recursive: true, force: true });
}

process.stdout.write("ok — help at every level comes from one commander tree; usage errors are JSON naming the right usage and exit 2, without a daemon\n");
