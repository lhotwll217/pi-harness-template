import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ONBOARDING_VERSION,
  harnessPaths,
  type DaemonInfo,
} from "@pi-template/contracts";
import { connectGateway } from "../gateway/client";
import { startDaemon } from "./lifecycle";

const previousHome = process.env.PI_TEMPLATE_HOME;
const home = mkdtempSync(join(tmpdir(), "pi-template-daemon-e2e-"));
process.env.PI_TEMPLATE_HOME = home;
let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

try {
  daemon = await startDaemon({ port: 0, fingerprintIntervalMs: 60_000 });
  const paths = harnessPaths();
  const info = JSON.parse(readFileSync(paths.daemonInfo, "utf8")) as DaemonInfo;
  assert.equal(info.port, daemon.port);
  assert.equal(info.pid, process.pid);
  assert.equal(info.fingerprint, daemon.fingerprint);
  assert.ok(info.authToken.length >= 32, "discovery includes a generated credential");
  assert.equal(statSync(paths.daemonInfo).mode & 0o777, 0o600, "discovery credential is owner-readable only");

  const client = await connectGateway();
  assert.ok(client, "authenticated live daemon is discoverable before full readiness");
  assert.equal((await client.health()).fingerprint, daemon.fingerprint);
  const readiness = await client.ready();
  assert.deepEqual(readiness, {
    ready: false,
    setupRequired: true,
    modules: { state: false, scheduler: false, gateway: true },
  });

  writeFileSync(paths.onboardingMarker, JSON.stringify({
    version: ONBOARDING_VERSION,
    completedAt: "2026-01-01T00:00:00.000Z",
  }));
  assert.equal((await client.ready()).setupRequired, false, "readiness reads the current onboarding marker");

  const originalFetch = globalThis.fetch;
  let markEventConnection: () => void = () => undefined;
  const eventConnection = new Promise<void>((resolve) => { markEventConnection = resolve; });
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (String(args[0]).endsWith("/events") && response.ok) markEventConnection();
    return response;
  };
  const unsubscribe: () => void = client.subscribe(() => undefined);
  let connectionTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      eventConnection,
      new Promise<never>((_, reject) => {
        connectionTimeout = setTimeout(() => reject(new Error("client SSE connection timed out")), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(connectionTimeout);
    globalThis.fetch = originalFetch;
    unsubscribe();
    client.close();
  }
  process.stdout.write("ok — daemon composition and Gateway e2e\n");
} finally {
  if (daemon) {
    await daemon.close();
    assert.equal(existsSync(harnessPaths().daemonInfo), false, "closed daemon removes discovery");
    assert.equal(await connectGateway(), null, "closed daemon removes discovery");
  }
  if (previousHome === undefined) delete process.env.PI_TEMPLATE_HOME;
  else process.env.PI_TEMPLATE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
}
