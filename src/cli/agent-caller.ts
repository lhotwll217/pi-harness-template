import { CommanderError, type Command } from "commander";
import { AGENT_CLI_COMMANDS, DAEMON_PROBE_TIMEOUT_MS, OWNER_CLI_COMMANDS, harnessPaths } from "@pi-template/contracts";
import { agentTransport, gatewayClient, probeAgentGateway } from "../gateway/client";
import type { ConfirmedGatewayClient } from "./ensure-daemon";

export class CliFailure extends Error {
  constructor(message: string, readonly hint: string) {
    super(message);
    this.name = "CliFailure";
  }
}

const errorCodes = (error: unknown): unknown[] => {
  const codes: unknown[] = [];
  for (let cause = error; cause instanceof Error; cause = cause.cause) codes.push((cause as NodeJS.ErrnoException).code);
  return codes;
};

export async function connectAgentGateway(): Promise<ConfirmedGatewayClient> {
  const socket = harnessPaths().agentSocket;
  try {
    const probe = await probeAgentGateway(socket, { signal: AbortSignal.timeout(DAEMON_PROBE_TIMEOUT_MS) });
    return Object.assign(gatewayClient(agentTransport(socket)), { probe });
  } catch (error) {
    const codes = errorCodes(error);
    if (codes.includes("ENOENT") || codes.includes("ECONNREFUSED")) {
      throw new CliFailure(
        "the pi-template daemon is not running",
        "the owner starts it with `pi-template status`; the agent never starts it",
      );
    }
    if (codes.includes("ABORT_ERR")) {
      throw new CliFailure(
        `the pi-template daemon did not answer within ${DAEMON_PROBE_TIMEOUT_MS / 1000} s`,
        "tell the owner the daemon is not answering; the agent never restarts it",
      );
    }
    if (codes.includes("EINVAL")) {
      throw new CliFailure(`the agent socket ${socket} is longer than a unix socket path may be`, "the owner runs `pi-template doctor` to see why");
    }
    if (codes.includes("EPERM") || codes.includes("EACCES")) {
      throw new CliFailure("the sandbox keeps this shell from the daemon", "the owner runs `pi-template doctor` to see why");
    }
    throw error;
  }
}

/** The calls refused before commander parses: bare `pi-template` never reaches commander, and a
 * leading `--` is never needed for an agent command. */
export function ownerOnlyCall(argv: readonly string[]): string | undefined {
  if (argv.length === 0) return "pi-template with no command";
  return argv[0] === "--" ? "pi-template with a leading --" : undefined;
}

/** Refuses the owner's commands as commander resolves them, however the words reached them. */
export function refuseOwnerCommands(program: Command): void {
  program.hook("preSubcommand", (_program, command) => {
    if (!(OWNER_CLI_COMMANDS as readonly string[]).includes(command.name())) return;
    const refusal = ownerOnlyRefusal(`pi-template ${command.name()}`);
    process.stderr.write(`${JSON.stringify(refusal)}\n`);
    throw new CommanderError(2, "pi-template.ownerOnly", refusal.error);
  });
}

export const ownerOnlyRefusal = (command: string): { error: string; hint: string } => ({
  error: `${command} is the owner's command`,
  hint: `the agent runs pi-template ${AGENT_CLI_COMMANDS.join(" | ")}`,
});
