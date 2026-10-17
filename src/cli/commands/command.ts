import { once } from "node:events";
import type { Command } from "commander";
import { isAgentCaller } from "@pi-template/contracts";
import type { ConfirmedGatewayClient } from "../ensure-daemon";
import { CliUsageError } from "../args";

export interface VerbInput {
  args: Array<string | string[] | undefined>;
  options: Record<string, unknown>;
}

export interface CommandGuide {
  useWhen?: string;
  notFor?: string;
  next?: string;
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

export function noun(parent: Command, name: string, summary: string, guide: CommandGuide): Command {
  return parent.command(name).description(summary).addHelpText("after", guideText(guide));
}

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
      refuseBlankArguments(command);
      process.exitCode = await run({ args: command.processedArgs as VerbInput["args"], options: command.opts() });
    } catch (error) {
      if (error instanceof CliUsageError) command.error(error.message, { exitCode: 2 });
      await reportFailure(error);
      process.exitCode = 1;
    }
  });
  return command;
}

// Commander accepts "" for a required argument.
function refuseBlankArguments(command: Command): void {
  command.registeredArguments.forEach((argument, index) => {
    const value = command.processedArgs[index] as string | string[] | undefined;
    const text = Array.isArray(value) ? value.join(" ") : value;
    if (argument.required && !text?.trim()) throw new CliUsageError(`required argument '${argument.name()}' is blank`);
  });
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

export async function emit(payload: unknown): Promise<void> {
  await writeOut(`${JSON.stringify(payload, null, 2)}\n`);
}

/** Run with a confirmed Gateway client: the owner's starts the daemon when none runs; an agent caller's never does. */
export async function withGateway<T>(use: (client: ConfirmedGatewayClient) => Promise<T>): Promise<T> {
  const client = isAgentCaller()
    ? await (await import("../agent-caller")).connectAgentGateway()
    : await (await import("../ensure-daemon")).ensureDaemon();
  try {
    return await use(client);
  } finally {
    client.close();
  }
}

async function reportFailure(error: unknown): Promise<void> {
  const { GatewayRequestError } = await import("../../gateway/client");
  const { CliFailure } = await import("../agent-caller");
  const report = error instanceof GatewayRequestError
    ? { status: error.status, ...(error.body && typeof error.body === "object" ? error.body : { error: error.message }) }
    : error instanceof CliFailure
    ? { error: error.message, hint: error.hint }
    : { error: error instanceof Error ? error.message : String(error) };
  process.stderr.write(`${JSON.stringify(report)}\n`);
}
