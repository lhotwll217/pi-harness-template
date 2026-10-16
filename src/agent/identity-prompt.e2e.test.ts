import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { helpPages } from "../cli/commands/registry";
import { schemaReference } from "../state/schema-docs";
import { createHarnessSession } from "./runtime";

const executable = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "pi-template");
const dir = mkdtempSync(join(tmpdir(), "pi-template-identity-prompt-"));
const home = join(dir, "home");
const cwd = join(dir, "task");

const printedHelp = async (args: readonly string[]) => await new Promise<string>((resolveRun, reject) => {
  const child = spawn(executable, [...args, "--help"], {
    env: { ...process.env, PI_TEMPLATE_HOME: home, PI_TEMPLATE_PORT: "0" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (status) => {
    if (status === 0 && stderr === "") resolveRun(stdout);
    else reject(new Error(`pi-template ${args.join(" ")} --help exited ${status}: ${stderr}`));
  });
});

async function sessionSystemPrompt(): Promise<string> {
  const created = await createHarnessSession({
    home,
    cwd,
    ephemeral: true,
    toolsAllow: [],
    query: {
      listTables: () => [],
      describeTable: () => ({ description: "", columns: [] }),
      runQuery: () => ({ rows: [], truncated: false }),
    },
    notes: { createNote: () => ({ id: "n", body: "", createdAt: "", updatedAt: "" }) },
  });
  try {
    return created.session.systemPrompt;
  } finally {
    created.session.dispose();
  }
}

try {
  const commands = helpPages().map(({ command }) => command.split(" ").slice(1));
  const printed = await Promise.all(commands.map(printedHelp));
  const prompt = await sessionSystemPrompt();

  printed.forEach((page, index) => {
    assert.ok(prompt.includes(page), `\`${["pi-template", ...commands[index]!].join(" ")} --help\` is in the prompt word for word`);
  });
  assert.ok(prompt.includes(`\`\`\`text\n${printed.join("\n").trimEnd()}\n\`\`\``),
    "the prompt embeds every printed page, root first, in one block");
  assert.ok(prompt.includes(`\`\`\`text\n${schemaReference()}\n\`\`\``), "the prompt embeds the schema reference");
  assert.ok(prompt.includes([
    "schedule_runs — Durable execution history with immutable launch context and terminal outcome tails.",
    "  id                     Stable run id.",
    "  schedule_id            References the originating schedule.",
  ].join("\n")), "the schema reference names each table and its columns with their meaning");
  assert.doesNotMatch(prompt, /<!-- generated:/, "no generation marker reaches the model");
  assert.equal(await sessionSystemPrompt(), prompt, "two sessions from one commit get identical system prompts");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write("ok — the session system prompt holds every page `pi-template --help` prints and the schema reference\n");
