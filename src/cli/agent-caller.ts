// The CLI as the agent runs it from bash: `PI_TEMPLATE_AGENT=1` with `PI_TEMPLATE_HOME` naming the
// session's home. It reaches a running daemon over the agent socket and never starts one, never
// reads daemon.json, and never writes under the home (docs/security.md#the-agent-uses-its-own-cli).
import { AGENT_CLI_COMMANDS, DAEMON_PROBE_TIMEOUT_MS, OWNER_CLI_COMMANDS, harnessPaths } from "@pi-template/contracts";
import { agentTransport, gatewayClient, probeAgentGateway } from "../gateway/client";
import type { ConfirmedGatewayClient } from "./ensure-daemon";

/** A failure the CLI reports as one JSON line with a hint for what to do instead. */
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
    if (codes.includes("EINVAL")) {
      throw new CliFailure(`the agent socket ${socket} is longer than a unix socket path may be`, "the owner runs `pi-template doctor` to see why");
    }
    if (codes.includes("EPERM") || codes.includes("EACCES")) {
      throw new CliFailure("the sandbox keeps this shell from the daemon", "the owner runs `pi-template doctor` to see why");
    }
    throw error;
  }
}

/** The owner-only command an agent caller asked for, if any: the bare entry, or onboard, daemon, or prompt. */
export function ownerOnlyCommand(argv: readonly string[]): string | undefined {
  const [command] = argv;
  if (command === undefined) return "pi-template with no command";
  return (OWNER_CLI_COMMANDS as readonly string[]).includes(command) ? `pi-template ${command}` : undefined;
}

export const ownerOnlyRefusal = (command: string): { error: string; hint: string } => ({
  error: `${command} is the owner's command`,
  hint: `the agent runs pi-template ${AGENT_CLI_COMMANDS.join(" | ")}`,
});
