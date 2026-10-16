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
    filesystem: { allowedReadRoots: [paths.workspace], allowedWriteRoots: [paths.workspace], deniedReadRoots: [] },
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
    "protectedPaths",
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

  writeFileSync(join(home, "sandbox.json"), JSON.stringify({ ...policy, enabled: false }));
  const off = await runDoctor({ home, providerModelVerifier: () => true });
  assert.deepEqual(off.checks.sandbox, {
    enabled: false, verified: false, reason: "turned off in sandbox.json; bash runs on the host",
  });
  assert.match(formatDoctorReport(off), /^Sandbox: off \(turned off in sandbox.json; bash runs on the host\)$/m);
  assert.equal(off.ok, true);
  assert.deepEqual(off.checks.protectedPaths, { readable: true, reason: "none recorded" });

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

  writeFileSync(join(home, "sandbox.json"), JSON.stringify({ ...policy, enabled: false }));
  writeFileSync(paths.protectedPaths, JSON.stringify({ paths: ["/a", "/b"], repos: ["Personal"] }));
  const recorded = await runDoctor({ home, providerModelVerifier: () => true });
  assert.deepEqual(recorded.checks.protectedPaths, { readable: true, reason: "2 paths, 1 repo" });
  assert.match(formatDoctorReport(recorded), /^Protected paths: 2 paths, 1 repo$/m);
  assert.equal(recorded.ok, true);
  writeFileSync(paths.protectedPaths, `{ "paths": ["/a"], }`);
  const damaged = await runDoctor({ home, providerModelVerifier: () => true });
  const damage = `protected paths are not valid JSON at ${paths.protectedPaths}; the agent will not start without the owner's protected paths. ` +
    "Fix the file, or record them again with `pi-template onboard` (non-interactive: `pi-template onboard --non-interactive --protected-path <dir>`)";
  assert.deepEqual(damaged.checks.protectedPaths, { readable: false, reason: damage });
  assert.equal(formatDoctorReport(damaged).includes(`Protected paths: unreadable (${damage})\n`), true);
  assert.equal(damaged.ok, false);
  unlinkSync(paths.protectedPaths);

  writeFileSync(paths.piAuth, JSON.stringify({ anthropic: { type: "api_key", key: secret } }));
  writeFileSync(paths.piSettings, JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-5" }));
  assert.equal((await runDoctor({ home })).checks.model.available, true);
  writeFileSync(paths.piSettings, JSON.stringify({ defaultProvider: "anthropic", defaultModel: "no-such-model" }));
  assert.equal((await runDoctor({ home })).checks.model.available, false);

  process.stdout.write("ok — doctor reports readiness shape without secret material and names the sandbox state\n");
} finally {
  rmSync(home, { recursive: true, force: true });
}
