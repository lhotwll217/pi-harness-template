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
const root = mkdtempSync(join(tmpdir(), "pi-template-recovery-"));
const home = join(root, "harness");
const userHome = join(root, "user");
const bin = join(root, "bin");
mkdirSync(home);
mkdirSync(userHome);
mkdirSync(bin);
const paths = harnessPaths(home);
const environment: NodeJS.ProcessEnv = { ...process.env, PI_TEMPLATE_HOME: home, PI_TEMPLATE_PORT: "0" };
const started = new Set<number>();
const helpers = new Set<ChildProcess>();

interface CliResult { status: number | null; stdout: string; stderr: string }

const runCli = async (args: string[], env = environment): Promise<CliResult> =>
  await new Promise((resolveRun, reject) => {
    const child = spawn(join(repositoryRoot, "pi-template"), args, { cwd: repositoryRoot, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (status) => resolveRun({ status, stdout, stderr }));
  });

const status = async (env = environment): Promise<DaemonHealth> => {
  const result = await runCli(["status"], env);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout) as { health: DaemonHealth; ready: { ready: boolean } };
  assert.equal(body.ready.ready, true);
  started.add(body.health.pid);
  return body.health;
};

const discovery = (): DaemonInfo => JSON.parse(readFileSync(paths.daemonInfo, "utf8")) as DaemonInfo;
const writeDiscovery = (info: DaemonInfo): void => writeFileSync(paths.daemonInfo, JSON.stringify(info));
const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const daemonStarts = (): number =>
  existsSync(join(paths.logsDir, "daemon.log"))
    ? readFileSync(join(paths.logsDir, "daemon.log"), "utf8").split("\n").filter((line) => line.includes("daemon ready at")).length
    : 0;
const waitForExit = async (pid: number): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`pid ${pid} did not exit`);
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  }
};
const spawnUntilFirstOutput = async (source: string): Promise<{ pid: number; output: string }> => {
  const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "inherit"] });
  helpers.add(child);
  const output = await new Promise<string>((resolveReady, reject) => {
    child.once("error", reject);
    child.stdout!.once("data", (chunk) => resolveReady(String(chunk)));
  });
  return { pid: child.pid!, output };
};

try {
  const first = await status();
  assert.equal(first.repoRoot, repositoryRoot, "/health names the checkout the daemon runs from");

  process.kill(first.pid, "SIGKILL");
  await waitForExit(first.pid);
  assert.equal(discovery().pid, first.pid, "SIGKILL leaves the discovery record behind");
  const second = await status();
  assert.notEqual(second.pid, first.pid, "a killed daemon is replaced by the next command");
  console.log("ok — the command after a crash brings up a fresh daemon");

  const live = discovery();
  const wrongToken = "wrong-token-0123456789abcdef";
  const startsBefore = daemonStarts();
  writeDiscovery({ ...live, authToken: wrongToken });
  const unauthorized = await runCli(["status"]);
  assert.equal(unauthorized.status, 1);
  assert.equal(
    unauthorized.stderr,
    `pi-template: daemon pid ${second.pid} is running but this process cannot reach it at 127.0.0.1:${live.port}. ` +
      `Probe failed: GatewayRequestError: Gateway /health: "unauthorized". The daemon was not restarted. ` +
      `Verify that pid ${second.pid} is this harness's daemon, then run \`kill ${second.pid}\` ` +
      `(if it does not exit, \`kill -9 ${second.pid}\`), and retry.\n`,
  );
  assert.equal(`${unauthorized.stdout}${unauthorized.stderr}`.includes(wrongToken), false, "the token is never printed");
  assert.equal(isAlive(second.pid), true, "the unreachable daemon keeps running");
  assert.equal(discovery().pid, second.pid, "no second daemon replaced the discovery record");
  assert.equal(daemonStarts(), startsBefore, "no second daemon started");
  console.log("ok — an unauthenticated probe of a live daemon explains instead of restarting");

  writeFileSync(join(bin, "launchctl"), `#!/bin/sh\n[ "$1" = print ] && printf '\\tpid = %s\\n' "${second.pid}"\n`);
  chmodSync(join(bin, "launchctl"), 0o755);
  mkdirSync(dirname(daemonLaunchAgentPath(userHome)), { recursive: true });
  writeFileSync(daemonLaunchAgentPath(userHome), daemonLaunchAgent({
    home,
    executable: join(repositoryRoot, "pi-template"),
    workingDirectory: repositoryRoot,
  }));
  const launchd = await runCli(["status"], { ...environment, HOME: userHome, PATH: `${bin}:${process.env.PATH ?? ""}` });
  assert.equal(launchd.status, 1);
  assert.match(
    launchd.stderr,
    new RegExp(`then run \`launchctl kickstart -k gui/${process.getuid!()}/com\\.pi-template\\.daemon\`, and retry\\.\\n$`),
  );
  assert.equal(isAlive(second.pid), true);
  console.log("ok — a launchd-owned daemon's diagnostic gives the launchd recovery command");

  writeDiscovery(live);
  process.kill(second.pid, "SIGSTOP");
  try {
    const hung = await runCli(["status"]);
    assert.equal(hung.status, 1);
    assert.match(hung.stderr, new RegExp(`daemon pid ${second.pid} is running but this process cannot reach it`));
    assert.match(hung.stderr, /Probe failed: TimeoutError: .*The daemon was not restarted\./);
    assert.equal(discovery().pid, second.pid);
    assert.equal(daemonStarts(), startsBefore);
  } finally {
    process.kill(second.pid, "SIGCONT");
  }
  assert.equal((await status()).pid, second.pid, "the hung daemon serves again once it resumes");
  console.log("ok — a hung daemon is left running with a diagnostic");

  const unrelated = await spawnUntilFirstOutput(`setInterval(() => {}, 60_000); process.stdout.write("ready");`);
  process.kill(second.pid, "SIGKILL");
  await waitForExit(second.pid);
  writeDiscovery({ ...live, pid: unrelated.pid });
  const third = await status();
  assert.notEqual(third.pid, unrelated.pid);
  assert.equal(isAlive(unrelated.pid), true, "the unrelated process holding the reused pid is untouched");
  console.log("ok — discovery pointing at an unrelated live process leads to a fresh daemon");

  process.kill(third.pid, "SIGTERM");
  await waitForExit(third.pid);
  const token = "other-checkout-token";
  const otherCheckout = await spawnUntilFirstOutput(`
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
  `);
  writeDiscovery({
    port: Number(otherCheckout.output),
    pid: otherCheckout.pid,
    startedAt: "then",
    fingerprint: "other-checkout-fingerprint",
    authToken: token,
  });
  const startsBeforeOther = daemonStarts();
  const served = await status();
  assert.equal(served.pid, otherCheckout.pid);
  assert.equal(served.repoRoot, "/elsewhere/pi-template");
  assert.equal(daemonStarts(), startsBeforeOther, "a client in another checkout connects instead of starting its own");
  console.log("ok — a client in another checkout connects to the running daemon");
} finally {
  for (const child of helpers) child.kill("SIGKILL");
  for (const pid of started) {
    try { process.kill(pid, "SIGCONT"); process.kill(pid, "SIGKILL"); } catch {}
  }
  rmSync(root, { recursive: true, force: true });
}
