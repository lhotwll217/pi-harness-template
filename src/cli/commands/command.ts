// What every `pi-template` verb shares on top of commander: JSON on stdout; prose help ending in
// examples; failures as one JSON line on stderr, exiting 1 while usage mistakes exit 2. Run
// bodies import their dependencies lazily, so building the tree or printing help never loads
// the daemon.
import { once } from "node:events";
import type { Command } from "commander";
import type { GatewayClient } from "../../gateway/client";
import { CliUsageError } from "../args";

export interface VerbInput {
  /** Declared arguments in order; a variadic one is an array. */
  args: Array<string | string[] | undefined>;
  options: Record<string, unknown>;
}

/**
 * What a command's help says after its flags, in one shape everywhere: when to use it, what to
 * use instead, what to run next, its rules, and examples.
 */
export interface CommandGuide {
  useWhen?: string;
  notFor?: string;
  next?: string;
  /** How a noun's verbs fit together, or a verb's rules. */
  rules?: readonly string[];
  examples?: readonly string[];
}

function guideText(guide: CommandGuide): string {
  const sections: string[] = [];
  if (guide.useWhen) sections.push(`Use when: ${guide.useWhen}`);
  if (guide.notFor) sections.push(`Not for: ${guide.notFor}`);
  if (guide.next) sections.push(`Next: ${guide.next}`);
  if (guide.rules?.length) sections.push(["Rules:", ...guide.rules.map((rule) => `  - ${rule}`)].join("\n"));
  if (guide.examples?.length) sections.push(["Examples:", ...guide.examples.map((example) => `  ${example}`)].join("\n"));
  return `\n${sections.join("\n\n")}`;
}

/** Add a noun: `<parent> <name>` whose verbs are added to it. */
export function noun(parent: Command, name: string, summary: string, guide: CommandGuide): Command {
  return parent.command(name).description(summary).addHelpText("after", guideText(guide));
}

/** Add `<parent> <name> [args]` with a summary, its guide, and a run body returning the exit code. */
export function verb(
  parent: Command,
  nameAndArgs: string,
  summary: string,
  guide: CommandGuide,
  run: (input: VerbInput) => Promise<number>,
): Command {
  const command = parent.command(nameAndArgs).description(summary).addHelpText("after", guideText(guide));
  command.action(async () => {
    try {
      process.exitCode = await run({ args: command.processedArgs as VerbInput["args"], options: command.opts() });
    } catch (error) {
      if (error instanceof CliUsageError) command.error(error.message, { exitCode: 2 });
      await reportFailure(error);
      process.exitCode = 1;
    }
  });
  return command;
}

export const commandPath = (command: Command): string =>
  command.parent ? `${commandPath(command.parent)} ${command.name()}` : command.name();

export function forEachCommand(command: Command, visit: (command: Command) => void): void {
  visit(command);
  for (const child of command.commands) forEachCommand(child, visit);
}

async function writeOut(text: string): Promise<void> {
  if (!process.stdout.write(text)) await once(process.stdout, "drain");
}

/** The one way a verb writes to stdout: its payload as JSON. */
export async function emit(payload: unknown): Promise<void> {
  await writeOut(`${JSON.stringify(payload, null, 2)}\n`);
}

/** Run `use` against the daemon's Gateway, starting the daemon when none is running. */
export async function withGateway<T>(use: (client: GatewayClient) => Promise<T>): Promise<T> {
  const { ensureDaemon } = await import("../ensure-daemon");
  const client = await ensureDaemon();
  try {
    return await use(client);
  } finally {
    client.close();
  }
}

/** A failure as one JSON line on stderr: the Gateway's error body with its status, else the message. */
async function reportFailure(error: unknown): Promise<void> {
  const { GatewayRequestError } = await import("../../gateway/client");
  const report = error instanceof GatewayRequestError
    ? { status: error.status, ...(error.body && typeof error.body === "object" ? error.body : { error: error.message }) }
    : { error: error instanceof Error ? error.message : String(error) };
  process.stderr.write(`${JSON.stringify(report)}\n`);
}
