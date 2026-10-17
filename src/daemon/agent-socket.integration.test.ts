// Contract: docs/security.md#the-agent-uses-its-own-cli (a socket that cannot listen leaves the daemon running)
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHarnessWorkspace, harnessPaths, type DaemonInfo } from "@pi-template/contracts";
import { connectGateway, probeAgentGateway } from "../gateway/client";
import { startDaemon } from "./lifecycle";

const previousHome = process.env.PI_TEMPLATE_HOME;
const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-sock-")));
process.env.PI_TEMPLATE_HOME = home;
const paths = harnessPaths(home);
const start = async () => await startDaemon({
  port: 0,
  fingerprintIntervalMs: 60_000,
  scheduler: { wakeIntervalMs: 60_000, promptRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
});
const running: Array<Awaited<ReturnType<typeof start>>> = [];

try {
  ensureHarnessWorkspace(home);
  mkdirSync(paths.agentSocket);
  running.push(await start());
  assert.equal(existsSync(paths.daemonInfo), true, "the daemon still publishes discovery");
  const owner = await connectGateway();
  assert.ok(owner, "the owner reaches the daemon over TCP");
  assert.deepEqual((await owner.doctor() as { checks: { agentCli: unknown } }).checks.agentCli, {
    reachable: false,
    reason: `${paths.agentSocket} exists and is not a socket; the owner removes it and restarts the daemon`,
  });
  owner.close();
  await running.pop()!.close();
  assert.equal(statSync(paths.agentSocket).isDirectory(), true, "the daemon removes only its own socket");
  rmSync(paths.agentSocket, { recursive: true });

  const first = await start();
  running.push(first);
  const firstStartedAt = (JSON.parse(readFileSync(paths.daemonInfo, "utf8")) as DaemonInfo).startedAt;
  const firstSocket = statSync(paths.agentSocket).ino;
  // Two daemons starting together both find no discovery record.
  rmSync(paths.daemonInfo);
  const second = await start();
  running.push(second);
  assert.equal(statSync(paths.agentSocket).ino, firstSocket, "the second daemon leaves the live socket in place");
  assert.equal((await probeAgentGateway(paths.agentSocket)).health.startedAt, firstStartedAt);
  const secondOwner = await connectGateway();
  assert.deepEqual((await secondOwner!.doctor() as { checks: { agentCli: unknown } }).checks.agentCli, {
    reachable: false,
    reason: `another daemon already listens on ${paths.agentSocket}`,
  });
  secondOwner!.close();
  await running.pop()!.close();
  assert.equal((await probeAgentGateway(paths.agentSocket)).health.startedAt, firstStartedAt, "closing the second daemon keeps the first's socket");
  console.log("ok — an agent socket that cannot listen leaves the daemon running and named by doctor; a live socket is never taken over");
} finally {
  for (const daemon of running.reverse()) await daemon.close().catch(() => undefined);
  if (previousHome === undefined) delete process.env.PI_TEMPLATE_HOME;
  else process.env.PI_TEMPLATE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
}
