// Every `pi-template` command, as one commander tree. The tree drives parsing and help at each
// level; rootHelp() and helpPages() return exactly what the terminal prints, so a caller that
// embeds the help reads the same text. Building it has no side effects: run bodies load what
// they need when they run.
import { Command, CommanderError } from "commander";
import { commandPath, forEachCommand } from "./command";
import { addDb } from "./db";
import { addDocs } from "./docs";
import { addHarnessCommands } from "./harness";
import { addNotes } from "./notes";
import { addSchedule } from "./schedule";

const ROUTING = `Pi Harness Template: a running, self-documenting micro harness. Bare \`pi-template\` opens
the agent in this terminal, starting setup when needed.

Which command answers what:
  how many, which, since when: notes, schedules, runs
      pi-template db: tables, then describe, then one read-only SELECT
  how this harness works or why it was built this way
      pi-template docs query "<question>", then docs read <id>
  keep or remove a short note
      pi-template notes
  prompts or commands on a timer
      pi-template schedule
  whether the harness is up and set up
      pi-template status | doctor`;

export function harnessProgram(): Command {
  // Settings are inherited by every subcommand created after them, so they come first. A fixed
  // help width keeps embedded help identical to what a terminal prints.
  const program = new Command("pi-template")
    .description(ROUTING)
    .usage("<command> [<verb>] [args]")
    .configureHelp({ helpWidth: 100 })
    .exitOverride()
    .allowExcessArguments(false)
    .showSuggestionAfterError();
  addDb(program);
  addDocs(program);
  addNotes(program);
  addSchedule(program);
  addHarnessCommands(program);
  program.addHelpText("after", [
    "",
    "Every command prints JSON on stdout; failures print one JSON line on stderr and exit 1, or 2 for a",
    "usage mistake. `pi-template prompt` prints the agent's answer, and `pi-template daemon` runs in the",
    "foreground.",
    "`pi-template <command> --help` shows a command's verbs; `pi-template <command> <verb> --help` its",
    "flags, rules, and examples.",
  ].join("\n"));
  // Every usage mistake, commander's own included, is one JSON line on stderr naming the right
  // usage, and exits 2.
  forEachCommand(program, (command) => {
    const path = commandPath(command);
    const hint = command.commands.length === 0
      ? `Usage: ${path} ${command.usage()}. \`${path} --help\` shows its flags and examples.`
      : `\`${path} --help\` lists its ${command.parent ? "verbs" : "commands"}.`;
    // A noun with no verb is discovery, not a mistake: its help on stdout, exit 0.
    if (command.commands.length > 0) {
      command.help = () => {
        command.outputHelp();
        throw new CommanderError(0, "commander.helpDisplayed", "(outputHelp)");
      };
    }
    command.error = (message, options) => {
      const error = message.replace(/^error: /, "").replace(/\s*\n\s*/g, " ");
      process.stderr.write(`${JSON.stringify({ error, hint })}\n`);
      throw new CommanderError(2, options?.code ?? "pi-template.usage", error);
    };
  });
  return program;
}

function helpOf(command: Command): string {
  let help = "";
  command.configureOutput({ writeOut: (text) => { help += text; } }).outputHelp();
  return help;
}

/** Exactly what `pi-template --help` prints. */
export function rootHelp(): string {
  return helpOf(harnessProgram());
}

export interface HelpPage {
  /** The command path, e.g. `pi-template db query`. */
  command: string;
  /** Exactly what `<command> --help` prints. */
  help: string;
}

/** Every help page in the tree, root first, each noun followed by its verbs. */
export function helpPages(): HelpPage[] {
  const pages: HelpPage[] = [];
  forEachCommand(harnessProgram(), (command) => {
    pages.push({ command: commandPath(command), help: helpOf(command) });
  });
  return pages;
}
