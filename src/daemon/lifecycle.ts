import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ensureHarnessWorkspace,
  harnessPaths,
  isOnboardingComplete,
  type DaemonHealth,
  type DaemonInfo,
  type DaemonReady,
  type OnboardingMarker,
} from "@pi-template/contracts";
import { startGateway } from "../gateway/server";
import { runtimeFingerprint } from "./fingerprint";

export interface DaemonOptions {
  port?: number;
  fingerprintIntervalMs?: number;
  onStale?: () => void;
}

export interface RunningDaemon {
  port: number;
  fingerprint: string;
  close(): Promise<void>;
}

function onboardingMarker(path: string): OnboardingMarker | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as OnboardingMarker; } catch { return undefined; }
}

export async function startDaemon(options: DaemonOptions = {}): Promise<RunningDaemon> {
  ensureHarnessWorkspace();
  const paths = harnessPaths();
  const startedAt = new Date().toISOString();
  const fingerprint = runtimeFingerprint();
  const authToken = randomBytes(32).toString("base64url");
  let stale = false;
  let closed = false;
  let gatewayPort = 0;
  const modules: DaemonReady["modules"] = {
    state: false,
    scheduler: false,
    gateway: false,
  };

  const health = (): DaemonHealth => ({
    ok: true,
    port: gatewayPort,
    pid: process.pid,
    startedAt,
    fingerprint,
    stale,
  });
  const ready = (): DaemonReady => ({
    ready: Object.values(modules).every(Boolean) && !stale,
    setupRequired: !isOnboardingComplete(onboardingMarker(paths.onboardingMarker)),
    modules: { ...modules },
  });

  const gateway = await startGateway({
    authToken,
    health,
    ready,
    port: options.port,
  });
  gatewayPort = gateway.port;
  modules.gateway = true;

  const info: DaemonInfo = {
    port: gateway.port,
    pid: process.pid,
    startedAt,
    fingerprint,
    authToken,
  };
  try {
    mkdirSync(dirname(paths.daemonInfo), { recursive: true });
    writeFileSync(paths.daemonInfo, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
    chmodSync(paths.daemonInfo, 0o600);
  } catch (error) {
    await gateway.close();
    throw error;
  }

  const fingerprintTimer = setInterval(() => {
    if (!stale && runtimeFingerprint() !== fingerprint) {
      stale = true;
      options.onStale?.();
    }
  }, options.fingerprintIntervalMs ?? 2_000);
  fingerprintTimer.unref?.();

  return {
    port: gateway.port,
    fingerprint,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(fingerprintTimer);
      try {
        await gateway.close();
      } finally {
        try { rmSync(paths.daemonInfo, { force: true }); } catch { /* best effort */ }
      }
    },
  };
}

export async function daemonMain(): Promise<void> {
  let daemon: RunningDaemon;
  try {
    daemon = await startDaemon({ onStale: () => process.kill(process.pid, "SIGTERM") });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      process.stderr.write("pi-template: another daemon already owns the loopback port\n");
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  process.stderr.write(`pi-template daemon ready at http://127.0.0.1:${daemon.port} · pid ${process.pid}\n`);
  await new Promise<void>((resolve, reject) => {
    const stop = (): void => { void daemon.close().then(resolve, reject); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
