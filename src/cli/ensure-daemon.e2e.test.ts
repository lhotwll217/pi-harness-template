// The owner never types a daemon command: a CLI command issued with no daemon running
// starts one itself, waits for discovery, and completes. Cleanup kills the spawned
// daemon through the discovery file it wrote.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessPaths, type DaemonInfo } from "@pi-template/contracts";
import { runOnboarding } from "../agent";
import { passingOnboardingDependencies, testOnboardingAnswers } from "../../test/helpers/onboarding";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const home = mkdtempSync(join(tmpdir(), "pi-template-ensure-"));
const environment = { ...process.env, PI_TEMPLATE_HOME: home, PI_TEMPLATE_PORT: "0" };

const runCli = async (args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  await new Promise((resolveRun, reject) => {
    const child = spawn(join(repositoryRoot, "pi-template"), args, { cwd: repositoryRoot, env: environment });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (status) => resolveRun({ status, stdout, stderr }));
  });

try {
  process.env.PI_TEMPLATE_HOME = home;
  const onboarding = await runOnboarding(testOnboardingAnswers(home), passingOnboardingDependencies(home));
  assert.equal(onboarding.complete, true);

  // No daemon is running in this temp home; the command must start one and succeed.
  const status = await runCli(["status"]);
  assert.equal(status.status, 0, status.stderr);
  const body = JSON.parse(status.stdout) as { health: { ok: boolean }; ready: { ready: boolean } };
  assert.equal(body.health.ok, true);
  assert.equal(body.ready.ready, true);

  // A second command reuses the already-running daemon rather than spawning another.
  const info = JSON.parse(readFileSync(harnessPaths(home).daemonInfo, "utf8")) as DaemonInfo;
  const again = await runCli(["status"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal((JSON.parse(again.stdout) as { health: { pid: number } }).health.pid, info.pid);

  process.kill(info.pid, "SIGTERM");
  console.log("ok — CLI commands start the daemon automatically and reuse it");
} finally {
  try {
    const info = JSON.parse(readFileSync(harnessPaths(home).daemonInfo, "utf8")) as DaemonInfo;
    process.kill(info.pid, "SIGKILL");
  } catch { /* daemon already stopped or never started */ }
  rmSync(home, { recursive: true, force: true });
}
