import assert from "node:assert";
import type { DaemonHealth, DaemonReady } from "@pi-template/contracts";
import { startGateway } from "./server";

const token = "test-gateway-token";
const health: DaemonHealth = {
  ok: true,
  port: 0,
  pid: process.pid,
  startedAt: "2026-01-01T00:00:00.000Z",
  fingerprint: "test-fingerprint",
  stale: false,
};
const readiness: DaemonReady = {
  ready: false,
  setupRequired: true,
  modules: { state: false, scheduler: false, gateway: true },
};
const previousPort = process.env.PI_TEMPLATE_PORT;
process.env.PI_TEMPLATE_PORT = "0";
const gateway = await startGateway({
  authToken: token,
  health: () => ({ ...health, port: gateway.port }),
  ready: () => readiness,
});
if (previousPort === undefined) delete process.env.PI_TEMPLATE_PORT;
else process.env.PI_TEMPLATE_PORT = previousPort;

try {
  assert.equal(gateway.host, "127.0.0.1", "Gateway binds only to IPv4 loopback");
  const base = `http://${gateway.host}:${gateway.port}`;

  const missing = await fetch(`${base}/health`);
  assert.equal(missing.status, 401, "missing credential is rejected");
  assert.equal(missing.headers.get("www-authenticate"), "Bearer");

  const wrong = await fetch(`${base}/health`, {
    headers: { authorization: "Bearer wrong-token" },
  });
  assert.equal(wrong.status, 401, "wrong credential is rejected");

  const headers = { authorization: `Bearer ${token}` };
  const accepted = await fetch(`${base}/health`, { headers });
  assert.equal(accepted.status, 200, "matching credential is accepted");
  assert.deepEqual(await accepted.json(), { ...health, port: gateway.port });

  const ready = await fetch(`${base}/ready`, { headers });
  assert.equal(ready.status, 503, "incomplete modules remain unavailable");
  assert.deepEqual(await ready.json(), readiness);

  const controller = new AbortController();
  const events = await fetch(`${base}/events`, { headers, signal: controller.signal });
  assert.equal(events.status, 200);
  assert.equal(events.headers.get("content-type"), "text/event-stream");
  const first = await events.body?.getReader().read();
  assert.equal(new TextDecoder().decode(first?.value), ":ready\n\n", "SSE connection opens immediately");
  controller.abort();

  const absent = await fetch(`${base}/notes`, { headers });
  assert.equal(absent.status, 404, "later module routes are absent");

  process.env.PI_TEMPLATE_PORT = " ";
  await assert.rejects(startGateway({
    authToken: token,
    health: () => health,
    ready: () => readiness,
  }), /PI_TEMPLATE_PORT must not be blank/);
  if (previousPort === undefined) delete process.env.PI_TEMPLATE_PORT;
  else process.env.PI_TEMPLATE_PORT = previousPort;

  process.stdout.write("ok — authenticated loopback Gateway skeleton\n");
} finally {
  if (previousPort === undefined) delete process.env.PI_TEMPLATE_PORT;
  else process.env.PI_TEMPLATE_PORT = previousPort;
  await gateway.close();
}
