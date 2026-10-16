// The daemon is infrastructure, not a command the owner must remember: any CLI command
// that needs the Gateway starts the daemon itself when none is running, waits for it to
// become discoverable, and proceeds. `pi-template daemon` remains only the explicit
// foreground mode for debugging and service managers.
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessPaths } from "@pi-template/contracts";
import { DAEMON_LAUNCHD_LABEL, LaunchdOwnership, launchdOwnership } from "../daemon/ensure";
import { connectGateway, probeGateway, type GatewayClient, type GatewayProbe } from "../gateway/client";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const READY_DEADLINE_MS = 15_000;
const READY_POLL_MS = 150;
// Matches the startup guard in src/daemon/lifecycle.ts; a daemon that cannot answer
// /health within it is treated as unreachable, not as absent.
const PROBE_TIMEOUT_MS = 1_000;
const probeDeadline = () => ({ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
};

async function loopbackPortIsFree(port: number): Promise<boolean> {
  return await new Promise((resolveFree) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolveFree(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolveFree(true)));
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means some process holds the pid; only ESRCH establishes that it exited.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Stale discovery (an exited pid, or a reused pid whose port is free) permits a fresh daemon.
 * A live daemon this process cannot reach is left running, with a diagnostic instead.
 */
async function refuseUnreachableDaemon(probe: Extract<GatewayProbe, { kind: "unreachable" }>): Promise<void> {
  const { pid, port, authToken } = probe.info;
  const causes: Error[] = [];
  for (let cause = probe.cause; cause instanceof Error && !causes.includes(cause); cause = cause.cause) {
    causes.push(cause);
  }
  const codes = causes.map((cause) => (cause as NodeJS.ErrnoException).code);
  if (!processExists(pid) || codes.includes("ECONNREFUSED") || await loopbackPortIsFree(port)) return;

  let detail = causes.map((cause) => {
    const code = (cause as NodeJS.ErrnoException).code;
    return `${cause.name}${typeof code === "string" ? ` (${code})` : ""}: ${cause.message}`;
  }).join("; ") || String(probe.cause);
  if (typeof authToken === "string" && authToken.trim()) detail = detail.replaceAll(authToken.trim(), "[redacted]");
  const permissionHint = codes.some((code) => code === "EPERM" || code === "EACCES")
    ? " Check this process's sandbox or network permissions."
    : "";
  const restart = `\`launchctl kickstart -k gui/${process.getuid?.() ?? "<uid>"}/${DAEMON_LAUNCHD_LABEL}\``;
  const stop = `\`kill ${pid}\` (if it does not exit, \`kill -9 ${pid}\`)`;
  const recovery = {
    [LaunchdOwnership.Owned]: `run ${restart}`,
    [LaunchdOwnership.NotOwned]: `run ${stop}`,
    [LaunchdOwnership.Unknown]: `if launchd owns it run ${restart}, otherwise run ${stop}`,
  }[await launchdOwnership(pid, harnessPaths().home)];
  throw new Error(
    `daemon pid ${pid} is running but this process cannot reach it at 127.0.0.1:${port}. ` +
      `Probe failed: ${detail}.${permissionHint} The daemon was not restarted. ` +
      `Verify that pid ${pid} is this harness's daemon, then ${recovery}, and retry.`,
  );
}

export async function ensureDaemon(): Promise<GatewayClient> {
  const probe = await probeGateway(probeDeadline());
  if (probe?.kind === "reachable") {
    const existing = await connectGateway(probeDeadline());
    if (existing) return existing;
  }
  if (probe?.kind === "unreachable") await refuseUnreachableDaemon(probe);

  const paths = harnessPaths();
  mkdirSync(paths.logsDir, { recursive: true });
  const logPath = join(paths.logsDir, "daemon.log");
  const log = openSync(logPath, "a");
  const child = spawn(join(repositoryRoot, "pi-template"), ["daemon"], {
    cwd: repositoryRoot,
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + READY_DEADLINE_MS;
  for (;;) {
    const client = await connectGateway(probeDeadline());
    if (client) return client;
    if (Date.now() >= deadline) {
      throw new Error(`daemon did not become ready within ${READY_DEADLINE_MS / 1000}s; see ${logPath}`);
    }
    await delay(READY_POLL_MS);
  }
}
