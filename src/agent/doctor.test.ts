import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHarnessWorkspace, saveHarnessSettings } from "@pi-template/contracts";
import { formatDoctorReport, runDoctor } from "./doctor";

const home = mkdtempSync(join(tmpdir(), "pi-template-doctor-"));
const secret = "never-print-this-provider-secret";

try {
  const paths = ensureHarnessWorkspace(home);
  writeFileSync(paths.piAuth, JSON.stringify({ fake: { type: "api_key", key: secret } }));
  writeFileSync(paths.piSettings, JSON.stringify({ defaultProvider: "fake", defaultModel: "model" }));
  writeFileSync(join(home, "sandbox-verification.json"), JSON.stringify({ ok: true, reason: "verified" }));
  writeFileSync(join(home, "sandbox.json"), JSON.stringify({ network: { mode: "deny" } }));
  saveHarnessSettings(home, { alwaysOn: "declined", permissionMode: "ask" });

  const report = await runDoctor({
    home,
    installRoot: "/install/root",
    taskCwd: "/task/root",
    providerModelVerifier: () => true,
  });
  assert.deepEqual(Object.keys(report.checks), [
    "roots",
    "provider",
    "model",
    "resources",
    "permission",
    "sandbox",
    "daemon",
  ]);
  assert.equal(report.checks.provider.available, true);
  assert.equal(report.checks.model.available, true);
  assert.equal(report.checks.daemon.configuration, "declined");
  const output = formatDoctorReport(report);
  assert.equal(output.includes(secret), false);
  assert.match(output, /fake\/model/);
  assert.match(output, /sandbox.*verified/i);

  process.stdout.write("ok — doctor reports readiness shape without secret material\n");
} finally {
  rmSync(home, { recursive: true, force: true });
}
