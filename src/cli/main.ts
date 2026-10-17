import { CommanderError } from "commander";
import { isAgentCaller } from "@pi-template/contracts";
import { harnessProgram } from "./commands/registry";

// Commander reports help as an "error" too; only real usage mistakes exit 2.
const HELP_CODES = new Set(["commander.helpDisplayed", "commander.version"]);

try {
  const ownerOnly = isAgentCaller() ? (await import("./agent-caller")).ownerOnlyCommand(process.argv.slice(2)) : undefined;
  if (ownerOnly) {
    const { ownerOnlyRefusal } = await import("./agent-caller");
    process.stderr.write(`${JSON.stringify(ownerOnlyRefusal(ownerOnly))}\n`);
    process.exitCode = 2;
  } else if (process.argv.length === 2) {
    const { runEntry } = await import("./entry");
    process.exitCode = await runEntry();
  } else {
    await harnessProgram().parseAsync(process.argv);
  }
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = HELP_CODES.has(error.code) ? 0 : 2;
  } else {
    process.stderr.write(`pi-template: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
