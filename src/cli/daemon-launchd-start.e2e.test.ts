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
const kickstartExit = join(root, "kickstart-exit");
mkdirSync(home);
mkdirSync(userHome);
mkdirSync(bin);
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
  TEST_KICKSTART_EXIT: kickstartExit,
  TEST_DAEMON_LOG: join(paths.logsDir, "daemon.log"),
  TEST_REPOSITORY: repositoryRoot,
};
const started = new Set<number>();
const helpers = new Set<ChildProcess>();

const fakeLaunchctl = `#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { dirname, join } = require("node:path");
const env = process.env;
const args = process.argv.slice(2);
appendFileSync(env.TEST_LAUNCHCTL_LOG, args.join(" ") + "\\n");
if (args[0] !== "kickstart") process.exit(0);
if (existsSync(env.TEST_KICKSTART_EXIT)) {
  const code = Number(readFileSync(env.TEST_KICKSTART_EXIT, "utf8"));
  rmSync(env.TEST_KICKSTART_EXIT);
  process.exit(code);
}
mkdirSync(dirname(env.TEST_DAEMON_LOG), { recursive: true });
const log = openSync(env.TEST_DAEMON_LOG, "a");
spawn(join(env.TEST_REPOSITORY, "pi-template"), ["daemon"], {
  cwd: env.TEST_REPOSITORY, detached: true, stdio: ["ignore", log, log], env,
}).unref();
`;
writeFileSync(join(bin, "launchctl"), fakeLaunchctl);
chmodSync(join(bin, "launchctl"), 0o755);

interface CliResult { status: number | null; stdout: string; stderr: string }

const runCli = async (args: string[]): Promise<CliResult> =>
  await new Promise((resolveRun, reject) => {
    const child = spawn(join(repositoryRoot, "pi-template"), args, { cwd: repositoryRoot, env: environment });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (status) => resolveRun({ status, stdout, stderr }));
  });

const status = async (): Promise<DaemonHealth> => {
  const result = await runCli(["status"]);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout) as { health: DaemonHealth; ready: { ready: boolean } };
  assert.equal(body.ready.ready, true);
  started.add(body.health.pid);
  return body.health;
};

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
  assert.deepEqual(launchctlCalls(), [`enable ${target}`, `kickstart -k ${target}`]);
  console.log("ok — a dead daemon in a launchd-managed home is restarted through launchd");

  await kill(restarted.pid);
  writeFileSync(kickstartExit, "113");
  const bootstrapped = await status();
  assert.notEqual(bootstrapped.pid, restarted.pid);
  assert.deepEqual(launchctlCalls(), [
    `enable ${target}`,
    `kickstart -k ${target}`,
    `bootstrap gui/${process.getuid!()} ${plist}`,
    `kickstart -k ${target}`,
  ]);
  console.log("ok — an installed but unloaded LaunchAgent is bootstrapped, then kickstarted");

  await kill(bootstrapped.pid);
  writeFileSync(kickstartExit, "1");
  const startsBefore = daemonStarts();
  const failed = await runCli(["status"]);
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr, `pi-template: Command failed: launchctl kickstart -k ${target}\n\n`);
  assert.deepEqual(launchctlCalls(), [`enable ${target}`, `kickstart -k ${target}`]);
  assert.equal(daemonStarts(), startsBefore, "a failed kickstart never falls back to a detached daemon");
  console.log("ok — a launchctl failure fails the command without starting a detached daemon");
} finally {
  for (const child of helpers) child.kill("SIGKILL");
  for (const pid of started) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  rmSync(root, { recursive: true, force: true });
}
