// Contract: docs/architecture.md#daemon-discovery-and-recovery
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessPaths, type DaemonHealth, type DaemonInfo } from "@pi-template/contracts";
import { daemonLaunchAgent, daemonLaunchAgentPath } from "../daemon/ensure";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = mkdtempSync(join(tmpdir(), "pi-template-launchd-start-"));
const home = join(root, "harness");
const userHome = join(root, "user");
const bin = join(root, "bin");
const launchctlLog = join(root, "launchctl.log");
const launchd = join(root, "launchd");
mkdirSync(home);
mkdirSync(userHome);
mkdirSync(bin);
mkdirSync(launchd);
const paths = harnessPaths(home);
const plist = daemonLaunchAgentPath(userHome);
const target = `gui/${process.getuid!()}/com.pi-template.daemon`;
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  PI_TEMPLATE_HOME: home,
  PI_TEMPLATE_PORT: "0",
  HOME: userHome,
  PATH: `${bin}:${process.env.PATH ?? ""}`,
  TEST_LAUNCHCTL_LOG: launchctlLog,
  TEST_LAUNCHD: launchd,
  TEST_DAEMON_LOG: join(paths.logsDir, "daemon.log"),
  TEST_REPOSITORY: repositoryRoot,
};
const started = new Set<number>();
const helpers = new Set<ChildProcess>();

// Emulates one launchd job: `print` reports its pid, `kickstart` starts it only when it is not
// running and `-k` kills it first. A file named after a subcommand in TEST_LAUNCHD overrides
// that subcommand once with an exit code or "hang".
const fakeLaunchctl = `#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { dirname, join } = require("node:path");
const env = process.env;
const [command, ...rest] = process.argv.slice(2);
appendFileSync(env.TEST_LAUNCHCTL_LOG, [command, ...rest].join(" ") + "\\n");
const pidFile = join(env.TEST_LAUNCHD, "pid");
const running = () => {
  try {
    const pid = Number(readFileSync(pidFile, "utf8"));
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
};
const override = join(env.TEST_LAUNCHD, command);
const behavior = existsSync(override) ? readFileSync(override, "utf8") : undefined;
if (behavior !== undefined) rmSync(override);
if (behavior === "hang") setTimeout(() => {}, 60_000);
else if (behavior !== undefined) process.exit(Number(behavior));
else if (command === "print") {
  const pid = running();
  process.stdout.write(pid ? "\\tpid = " + pid + "\\n" : "\\tstate = not running\\n");
} else if (command === "kickstart") {
  const pid = running();
  if (pid && rest[0] === "-k") process.kill(pid, "SIGKILL");
  if (!pid || rest[0] === "-k") {
    mkdirSync(dirname(env.TEST_DAEMON_LOG), { recursive: true });
    const log = openSync(env.TEST_DAEMON_LOG, "a");
    const child = spawn(join(env.TEST_REPOSITORY, "pi-template"), ["daemon"], {
      cwd: env.TEST_REPOSITORY, detached: true, stdio: ["ignore", log, log], env,
    });
    child.unref();
    writeFileSync(pidFile, String(child.pid));
  }
}
`;
writeFileSync(join(bin, "launchctl"), fakeLaunchctl);
chmodSync(join(bin, "launchctl"), 0o755);

interface CliResult { status: number | null; stdout: string; stderr: string }

const COMMAND_DEADLINE_MS = 30_000;

const runCli = async (args: string[]): Promise<CliResult> =>
  await new Promise((resolveRun, reject) => {
    const child = spawn(join(repositoryRoot, "pi-template"), args, { cwd: repositoryRoot, env: environment });
    const deadline = setTimeout(() => child.kill("SIGKILL"), COMMAND_DEADLINE_MS);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (status) => {
      clearTimeout(deadline);
      resolveRun({ status, stdout, stderr });
    });
  });

const succeeded = (result: CliResult): DaemonHealth => {
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout) as { health: DaemonHealth; ready: { ready: boolean } };
  assert.equal(body.ready.ready, true);
  started.add(body.health.pid);
  return body.health;
};
const status = async (): Promise<DaemonHealth> => succeeded(await runCli(["status"]));
const overrideOnce = (subcommand: string, behavior: string): void => writeFileSync(join(launchd, subcommand), behavior);
const discovery = (): DaemonInfo => JSON.parse(readFileSync(paths.daemonInfo, "utf8")) as DaemonInfo;

const launchctlCalls = (): string[] => {
  const calls = existsSync(launchctlLog) ? readFileSync(launchctlLog, "utf8").split("\n").filter(Boolean) : [];
  rmSync(launchctlLog, { force: true });
  return calls;
};
const installLaunchAgent = (forHome: string): void => {
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, daemonLaunchAgent({
    home: forHome,
    executable: join(repositoryRoot, "pi-template"),
    workingDirectory: repositoryRoot,
  }));
};
const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const kill = async (pid: number): Promise<void> => {
  process.kill(pid, "SIGKILL");
  const deadline = Date.now() + 5_000;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`pid ${pid} did not exit`);
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  }
};
const daemonStarts = (): number =>
  existsSync(join(paths.logsDir, "daemon.log"))
    ? readFileSync(join(paths.logsDir, "daemon.log"), "utf8").split("\n").filter((line) => line.includes("daemon ready at")).length
    : 0;

try {
  const withoutAgent = await status();
  assert.deepEqual(launchctlCalls(), [], "with no LaunchAgent the CLI starts a detached daemon");
  await kill(withoutAgent.pid);

  installLaunchAgent(join(root, "another-harness"));
  const otherHomeAgent = await status();
  assert.notEqual(otherHomeAgent.pid, withoutAgent.pid);
  assert.deepEqual(launchctlCalls(), [], "a LaunchAgent for another harness home does not manage this one");
  await kill(otherHomeAgent.pid);
  console.log("ok — without this home's LaunchAgent the CLI starts a detached daemon");

  installLaunchAgent(home);
  const token = "other-checkout-token";
  const otherCheckout = spawn(process.execPath, ["-e", `
    const server = require("node:http").createServer((request, response) => {
      if (request.headers.authorization !== "Bearer ${token}") return response.writeHead(401).end();
      response.setHeader("content-type", "application/json");
      if (request.url === "/health") return response.end(JSON.stringify({
        ok: true, port: server.address().port, pid: process.pid, startedAt: "then",
        fingerprint: "other-checkout-fingerprint", stale: false, repoRoot: "/elsewhere/pi-template",
      }));
      if (request.url === "/ready") return response.end(JSON.stringify({
        ready: true, setupRequired: true, modules: { state: true, scheduler: true, gateway: true },
      }));
      response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port)));
  `], { stdio: ["ignore", "pipe", "inherit"] });
  helpers.add(otherCheckout);
  const otherPort = await new Promise<string>((resolveReady, reject) => {
    otherCheckout.once("error", reject);
    otherCheckout.stdout!.once("data", (chunk) => resolveReady(String(chunk)));
  });
  const otherInfo: DaemonInfo = {
    port: Number(otherPort),
    pid: otherCheckout.pid!,
    startedAt: "then",
    fingerprint: "other-checkout-fingerprint",
    authToken: token,
  };
  writeFileSync(paths.daemonInfo, JSON.stringify(otherInfo));
  const served = await status();
  assert.equal(served.repoRoot, "/elsewhere/pi-template");
  assert.deepEqual(launchctlCalls(), [], "a client in another checkout connects to a healthy daemon without kickstarting it");
  console.log("ok — a client in another checkout never kickstarts a healthy daemon");

  await kill(otherCheckout.pid!);
  const restarted = await status();
  assert.equal(restarted.repoRoot, repositoryRoot);
  assert.deepEqual(launchctlCalls(), [`enable ${target}`, `kickstart ${target}`]);
  console.log("ok — a dead daemon in a launchd-managed home is started through launchd");

  const published = discovery();
  writeFileSync(paths.daemonInfo, JSON.stringify(otherInfo));
  const racing = runCli(["status"]);
  while (!(existsSync(launchctlLog) && readFileSync(launchctlLog, "utf8").includes("kickstart"))) {
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  writeFileSync(paths.daemonInfo, JSON.stringify(published));
  assert.equal(succeeded(await racing).pid, restarted.pid, "the command connects to the daemon launchd already runs");
  assert.equal(isAlive(restarted.pid), true, "a daemon launchd already runs is never killed");
  assert.deepEqual(launchctlCalls(), [`enable ${target}`, `kickstart ${target}`]);
  console.log("ok — a stale record never kills the daemon launchd restarted in the meantime");

  rmSync(paths.daemonInfo);
  const startsBeforeRemoval = daemonStarts();
  const unpublished = await runCli(["status"]);
  assert.equal(unpublished.status, 1);
  assert.equal(
    unpublished.stderr,
    `pi-template: daemon did not become ready within 15s. launchd runs pid ${restarted.pid} for this harness home, ` +
      `but no reachable daemon has published ${paths.daemonInfo}. The daemon was not restarted. ` +
      `If ${paths.daemonInfo} was removed while pid ${restarted.pid} was running, ` +
      `run \`launchctl kickstart -k ${target}\`, and retry. See ${join(paths.logsDir, "daemon.log")}.\n`,
  );
  assert.equal(isAlive(restarted.pid), true);
  assert.equal(daemonStarts(), startsBeforeRemoval);
  assert.deepEqual(launchctlCalls(), [`enable ${target}`, `kickstart ${target}`, `print ${target}`]);
  console.log("ok — a launchd daemon whose record was removed is explained, not killed");

  await kill(restarted.pid);
  overrideOnce("kickstart", "113");
  const bootstrapped = await status();
  assert.notEqual(bootstrapped.pid, restarted.pid);
  assert.deepEqual(launchctlCalls(), [
    `enable ${target}`,
    `kickstart ${target}`,
    `bootstrap gui/${process.getuid!()} ${plist}`,
    `kickstart ${target}`,
  ]);
  console.log("ok — an installed but unloaded LaunchAgent is bootstrapped, then kickstarted");

  await kill(bootstrapped.pid);
  overrideOnce("kickstart", "113");
  overrideOnce("bootstrap", "5");
  const bootstrappedElsewhere = await status();
  assert.notEqual(bootstrappedElsewhere.pid, bootstrapped.pid);
  assert.deepEqual(launchctlCalls(), [
    `enable ${target}`,
    `kickstart ${target}`,
    `bootstrap gui/${process.getuid!()} ${plist}`,
    `print ${target}`,
    `kickstart ${target}`,
  ]);
  console.log("ok — a LaunchAgent another command bootstrapped first is kickstarted");

  await kill(bootstrappedElsewhere.pid);
  overrideOnce("kickstart", "113");
  overrideOnce("bootstrap", "5");
  overrideOnce("print", "113");
  const startsBeforeFailures = daemonStarts();
  const notBootstrapped = await runCli(["status"]);
  assert.equal(notBootstrapped.status, 1);
  assert.equal(notBootstrapped.stderr, `pi-template: Command failed: launchctl bootstrap gui/${process.getuid!()} ${plist}\n\n`);
  assert.deepEqual(launchctlCalls(), [
    `enable ${target}`,
    `kickstart ${target}`,
    `bootstrap gui/${process.getuid!()} ${plist}`,
    `print ${target}`,
  ]);

  overrideOnce("kickstart", "1");
  const failed = await runCli(["status"]);
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr, `pi-template: Command failed: launchctl kickstart ${target}\n\n`);
  assert.deepEqual(launchctlCalls(), [`enable ${target}`, `kickstart ${target}`]);

  overrideOnce("kickstart", "hang");
  const hung = await runCli(["status"]);
  assert.equal(hung.status, 1, "a hung launchctl is abandoned instead of hanging the command");
  assert.equal(hung.stderr, `pi-template: Command failed: launchctl kickstart ${target}\n\n`);
  assert.deepEqual(launchctlCalls(), [`enable ${target}`, `kickstart ${target}`]);
  assert.equal(daemonStarts(), startsBeforeFailures, "a failed launchd start never falls back to a detached daemon");
  console.log("ok — a failed or hung launchctl fails the command without starting a detached daemon");
} finally {
  for (const child of helpers) child.kill("SIGKILL");
  for (const pid of started) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  rmSync(root, { recursive: true, force: true });
}
