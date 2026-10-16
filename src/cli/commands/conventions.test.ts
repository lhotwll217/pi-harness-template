// CLI conventions enforced on the command tree and its source rather than in review, so a new
// verb that breaks one fails here.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { commandPath, forEachCommand } from "./command";
import { harnessProgram, helpPages } from "./registry";

const here = dirname(fileURLToPath(import.meta.url));

// JSON is structural: a verb reaches stdout only through emit(), which serializes its payload, so
// no command source but command.ts may write to stdout itself.
for (const file of readdirSync(here).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "command.ts")) {
  assert.doesNotMatch(readFileSync(join(here, file), "utf8"), /process\.stdout|console\.log/, `${file} writes stdout only through emit()`);
}

const verbs: Command[] = [];
forEachCommand(harnessProgram(), (command) => {
  if (command.parent && command.commands.length === 0) verbs.push(command);
});
const pages = new Map(helpPages().map(({ command, help }) => [command, help]));
for (const verb of verbs) {
  const path = commandPath(verb);
  const help = pages.get(path)!;
  assert.match(help, /\nExamples:\n(?: {2}pi-template .+\n)+$/, `${path} help ends with examples`);
  assert.equal(help.includes("--json"), path === "pi-template prompt", `${path} advertises --json only where it changes output`);
}

process.stdout.write(`ok — ${verbs.length} verbs print JSON through emit() and end their help with examples\n`);
