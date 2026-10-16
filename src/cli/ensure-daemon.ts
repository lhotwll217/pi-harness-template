// The daemon is infrastructure, not a command the owner must remember: any CLI command
// that needs the Gateway starts the daemon itself when none is running, waits for it to
// become discoverable, and proceeds. `pi-template daemon` remains only the explicit
// foreground mode for debugging and service managers.
// Contract: docs/architecture.md#daemon-discovery-and-recovery
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_PROBE_TIMEOUT_MS, harnessPaths } from "@pi-template/contracts";
import {
  DAEMON_LAUNCHD_LABEL,
  LaunchdOwnership,
  launchdJobPid,
  launchdManagesHome,
  launchdOwnership,
  startDaemonService,
} from "../daemon/ensure";
import { gatewayClient, probeGateway, type GatewayClient, type GatewayProbe } from "../gateway/client";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const READY_DEADLINE_MS = 15_000;
const READY_POLL_MS = 150;
const probeDeadline = () => ({ signal: AbortSignal.timeout(DAEMON_PROBE_TIMEOUT_MS) });

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

type UnreachableProbe = Extract<GatewayProbe, { kind: "unreachable" }>;
type ReachableProbe = Extract<GatewayProbe, { kind: "reachable" }>;

export type ConfirmedGatewayClient = GatewayClient & { readonly probe: ReachableProbe };

const confirmedClient = (probe: ReachableProbe): ConfirmedGatewayClient =>
  Object.assign(gatewayClient(probe.info), { probe });

const launchdRestart = (): string =>
  `\`launchctl kickstart -k gui/${process.getuid?.() ?? "<uid>"}/${DAEMON_LAUNCHD_LABEL}\``;

const probeCauses = (probe: UnreachableProbe): Error[] => {
  const causes: Error[] = [];
  for (let cause = probe.cause; cause instanceof Error && !causes.includes(cause); cause = cause.cause) {
    causes.push(cause);
  }
  return causes;
};
const errorCode = (error: Error): unknown => (error as NodeJS.ErrnoException).code;

async function discoveryIsStale(probe: UnreachableProbe): Promise<boolean> {
  const { pid, port } = probe.info;
  return !processExists(pid) || probeCauses(probe).some((cause) => errorCode(cause) === "ECONNREFUSED") ||
    await loopbackPortIsFree(port);
}

async function unreachableDaemonError(probe: UnreachableProbe): Promise<Error> {
  const { pid, port, authToken } = probe.info;
  const causes = probeCauses(probe);
  let detail = causes.map((cause) => {
    const code = errorCode(cause);
    return `${cause.name}${typeof code === "string" ? ` (${code})` : ""}: ${cause.message}`;
  }).join("; ") || String(probe.cause);
  if (typeof authToken === "string" && authToken.trim()) detail = detail.replaceAll(authToken.trim(), "[redacted]");
  const permissionHint = causes.some((cause) => errorCode(cause) === "EPERM" || errorCode(cause) === "EACCES")
    ? " Check this process's sandbox or network permissions."
    : "";
  const restart = launchdRestart();
  const stop = `\`kill ${pid}\` (if it does not exit, \`kill -9 ${pid}\`)`;
  const recovery = {
    [LaunchdOwnership.Owned]: `run ${restart}`,
    [LaunchdOwnership.NotOwned]: `run ${stop}`,
    [LaunchdOwnership.Unknown]: `if launchd owns it run ${restart}, otherwise run ${stop}`,
  }[await launchdOwnership(pid, harnessPaths().home)];
  return new Error(
    `daemon pid ${pid} is running but this process cannot reach it at 127.0.0.1:${port}. ` +
      `Probe failed: ${detail}.${permissionHint} The daemon was not restarted. ` +
      `Verify that pid ${pid} is this harness's daemon, then ${recovery}, and retry.`,
  );
}

async function daemonNotReadyError(
  startedByLaunchd: boolean,
  launchdPidBeforeStart: number | undefined,
  logPath: string,
): Promise<Error> {
  const timedOut = `daemon did not become ready within ${READY_DEADLINE_MS / 1000}s`;
  if (!startedByLaunchd) return new Error(`${timedOut}; see ${logPath}`);
  const pid = await launchdJobPid();
  if (pid === undefined || pid !== launchdPidBeforeStart) {
    return new Error(
      `${timedOut}. launchd started the daemon job for this harness home` +
        `${pid === undefined ? "" : ` and now runs pid ${pid}`}, but it never became ready; ` +
        `it may be failing at startup or starting slowly. See ${logPath}.`,
    );
  }
  const { daemonInfo } = harnessPaths();
  return new Error(
    `${timedOut}. launchd runs pid ${pid} for this harness home, but no reachable daemon has published ` +
      `${daemonInfo}. The daemon was not restarted. If ${daemonInfo} was removed while pid ${pid} was running, ` +
      `run ${launchdRestart()}, and retry. See ${logPath}.`,
  );
}

export async function ensureDaemon(): Promise<ConfirmedGatewayClient> {
  let probe = await probeGateway(probeDeadline());
  // A daemon can answer one probe and stall on the next; the confirming probe sends that case
  // through the same classification as a daemon that stalls from the start.
  if (probe.kind === "reachable") probe = await probeGateway(probeDeadline());
  if (probe.kind === "reachable") return confirmedClient(probe);
  if (probe.kind === "unreachable" && !await discoveryIsStale(probe)) throw await unreachableDaemonError(probe);

  const paths = harnessPaths();
  const logPath = join(paths.logsDir, "daemon.log");
  const startedByLaunchd = launchdManagesHome(paths.home);
  const launchdPidBeforeStart = startedByLaunchd ? await launchdJobPid() : undefined;
  if (startedByLaunchd) {
    await startDaemonService();
  } else {
    mkdirSync(paths.logsDir, { recursive: true });
    const log = openSync(logPath, "a");
    const child = spawn(join(repositoryRoot, "pi-template"), ["daemon"], {
      cwd: repositoryRoot,
      detached: true,
      stdio: ["ignore", log, log],
      env: process.env,
    });
    closeSync(log);
    child.unref();
  }

  const deadline = Date.now() + READY_DEADLINE_MS;
  for (;;) {
    const started = await probeGateway(probeDeadline());
    if (started.kind === "reachable") return confirmedClient(started);
    if (Date.now() >= deadline) throw await daemonNotReadyError(startedByLaunchd, launchdPidBeforeStart, logPath);
    await delay(READY_POLL_MS);
  }
}
