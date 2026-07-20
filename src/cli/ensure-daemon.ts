// The daemon is infrastructure, not a command the owner must remember: any CLI command
// that needs the Gateway starts the daemon itself when none is running, waits for it to
// become discoverable, and proceeds. `pi-template daemon` remains only the explicit
// foreground mode for debugging and service managers.
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessPaths } from "@pi-template/contracts";
import { connectGateway, type GatewayClient } from "../gateway/client";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const READY_DEADLINE_MS = 15_000;
const READY_POLL_MS = 150;

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
};

export async function ensureDaemon(): Promise<GatewayClient> {
  const existing = await connectGateway();
  if (existing) return existing;

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
    const client = await connectGateway();
    if (client) return client;
    if (Date.now() >= deadline) {
      throw new Error(`daemon did not become ready within ${READY_DEADLINE_MS / 1000}s; see ${logPath}`);
    }
    await delay(READY_POLL_MS);
  }
}
