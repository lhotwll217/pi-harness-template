import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ONBOARDING_VERSION,
  ensureHarnessWorkspace,
  reconcilePermissionSettings,
  saveHarnessSettings,
} from "@pi-template/contracts";
import { formatDoctorReport, runDoctor } from "./doctor";

const home = mkdtempSync(join(tmpdir(), "pi-template-doctor-"));
const secret = "never-print-this-provider-secret";

try {
  const paths = ensureHarnessWorkspace(home);
  writeFileSync(paths.piAuth, JSON.stringify({ fake: { type: "api_key", key: secret } }));
  writeFileSync(paths.piSettings, JSON.stringify({ defaultProvider: "fake", defaultModel: "model" }));
  writeFileSync(join(home, "sandbox-verification.json"), JSON.stringify({ ok: true, reason: "verified" }));
  const policy = {
    enabled: true,
    filesystem: { allowedReadRoots: [home], allowedWriteRoots: [home], deniedReadRoots: [] },
    process: { allowSubprocesses: true },
    network: { mode: "deny", allowedDomains: [] },
  };
  writeFileSync(join(home, "sandbox.json"), JSON.stringify(policy));
  saveHarnessSettings(home, { alwaysOn: "declined", permissionMode: "ask" });
  reconcilePermissionSettings(home);
  writeFileSync(paths.onboardingProgress, JSON.stringify({ version: ONBOARDING_VERSION, stages: { resources: "2026-10-16T12:00:00.000Z" } }));

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
  assert.deepEqual(report.checks.sandbox, { enabled: true, verified: true, reason: "verified" });
  assert.match(output, /^Sandbox: on, verified \(verified\)$/m);
  assert.equal(report.ok, true);

  // The policy file decides, not the verification record an earlier onboarding left.
  writeFileSync(join(home, "sandbox.json"), JSON.stringify({ ...policy, enabled: false }));
  const off = await runDoctor({ home, providerModelVerifier: () => true });
  assert.deepEqual(off.checks.sandbox, {
    enabled: false, verified: false, reason: "turned off in sandbox.json; bash runs on the host",
  });
  assert.match(formatDoctorReport(off), /^Sandbox: off \(turned off in sandbox.json; bash runs on the host\)$/m);
  assert.equal(off.ok, true);

  unlinkSync(join(home, "sandbox.json"));
  const missing = await runDoctor({ home, providerModelVerifier: () => true });
  assert.deepEqual(missing.checks.sandbox, {
    enabled: false, verified: false, reason: "no sandbox policy; bash runs on the host",
  });
  assert.equal(missing.ok, true);

  writeFileSync(join(home, "sandbox.json"), JSON.stringify({ network: { mode: "deny" } }));
  const invalid = await runDoctor({ home, providerModelVerifier: () => true });
  assert.deepEqual(invalid.checks.sandbox, {
    enabled: true, verified: false, reason: `sandbox policy is invalid under ${home}`,
  });
  assert.equal(invalid.ok, false);

  writeFileSync(paths.piAuth, JSON.stringify({ anthropic: { type: "api_key", key: secret } }));
  writeFileSync(paths.piSettings, JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-5" }));
  assert.equal((await runDoctor({ home })).checks.model.available, true);
  writeFileSync(paths.piSettings, JSON.stringify({ defaultProvider: "anthropic", defaultModel: "no-such-model" }));
  assert.equal((await runDoctor({ home })).checks.model.available, false);

  process.stdout.write("ok — doctor reports readiness shape without secret material and names the sandbox state\n");
} finally {
  rmSync(home, { recursive: true, force: true });
}
