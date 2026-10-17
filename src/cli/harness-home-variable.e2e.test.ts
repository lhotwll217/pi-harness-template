// PI_TEMPLATE_HOME names one home for the CLI and the daemon it starts, whatever directory the
// CLI runs from: whitespace means the default home, and a relative value resolves against the
// caller's directory, never the checkout the daemon runs in.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessPaths, type DaemonInfo } from "@pi-template/contracts";
import { runOnboarding } from "../agent";
import { passingOnboardingDependencies, testOnboardingAnswers } from "../../test/helpers/onboarding";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = mkdtempSync(join(tmpdir(), "pi-template-home-variable-"));
const userHome = join(scratch, "user");
const caller = join(scratch, "caller");
const homes: string[] = [];
mkdirSync(caller, { recursive: true });
mkdirSync(userHome, { recursive: true });

const runStatus = async (variable: string): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  await new Promise((resolveRun, reject) => {
    const child = spawn(join(repositoryRoot, "pi-template"), ["status"], {
      cwd: caller,
      env: { ...process.env, HOME: userHome, PI_TEMPLATE_HOME: variable, PI_TEMPLATE_PORT: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (status) => resolveRun({ status, stdout, stderr }));
  });

async function assertOneHome(variable: string, home: string): Promise<void> {
  homes.push(home, join(repositoryRoot, variable));
  process.env.PI_TEMPLATE_HOME = home;
  const onboarding = await runOnboarding(testOnboardingAnswers(home), passingOnboardingDependencies(home));
  assert.equal(onboarding.complete, true);

  const status = await runStatus(variable);
  assert.equal(status.status, 0, status.stderr);
  const body = JSON.parse(status.stdout) as { health: { pid: number }; ready: { ready: boolean } };
  assert.equal(body.ready.ready, true);
  const info = JSON.parse(readFileSync(harnessPaths(home).daemonInfo, "utf8")) as DaemonInfo;
  assert.equal(body.health.pid, info.pid);
  assert.equal(existsSync(join(repositoryRoot, variable)), false);
}

try {
  await assertOneHome("  ", join(userHome, ".pi-template"));
  await assertOneHome("h", join(caller, "h"));
  console.log("ok — whitespace and relative PI_TEMPLATE_HOME reach the daemon of the caller's home");
} finally {
  for (const home of homes) {
    try {
      const info = JSON.parse(readFileSync(harnessPaths(home).daemonInfo, "utf8")) as DaemonInfo;
      process.kill(info.pid, "SIGKILL");
    } catch { /* daemon never started */ }
  }
  for (const stray of homes.filter((home) => home.startsWith(repositoryRoot))) rmSync(stray, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}
