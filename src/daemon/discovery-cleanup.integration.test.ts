// Contract: docs/architecture.md#daemon-discovery-and-recovery
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessPaths, type DaemonInfo } from "@pi-template/contracts";
import { startDaemon } from "./lifecycle";

const previousHome = process.env.PI_TEMPLATE_HOME;
const home = mkdtempSync(join(tmpdir(), "pi-template-discovery-cleanup-"));
process.env.PI_TEMPLATE_HOME = home;
const discovery = harnessPaths(home).daemonInfo;
const start = async () => await startDaemon({
  port: 0,
  fingerprintIntervalMs: 60_000,
  scheduler: { promptRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
});

try {
  const closing = await start();
  const own = JSON.parse(readFileSync(discovery, "utf8")) as DaemonInfo;
  const replacement: DaemonInfo = {
    port: own.port + 1,
    pid: own.pid + 1,
    startedAt: "2026-10-16T00:00:00.000Z",
    fingerprint: "replacement-fingerprint",
    authToken: "replacement-token",
  };
  writeFileSync(discovery, JSON.stringify(replacement));
  await closing.close();
  assert.deepEqual(JSON.parse(readFileSync(discovery, "utf8")), replacement);

  rmSync(discovery);
  const sole = await start();
  await sole.close();
  assert.equal(existsSync(discovery), false, "a daemon still named by discovery removes its record");
  console.log("ok — a closing daemon leaves its replacement's discovery record intact");
} finally {
  if (previousHome === undefined) delete process.env.PI_TEMPLATE_HOME;
  else process.env.PI_TEMPLATE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
}
