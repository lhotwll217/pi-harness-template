import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessPaths } from "@pi-template/contracts";
import { passingOnboardingDependencies } from "../../test/helpers/onboarding";
import { onboard } from "./onboard";

const root = mkdtempSync(join(tmpdir(), "pi-template-cli-onboard-"));
const home = join(root, "home");

try {
  const result = await onboard([
    "--non-interactive",
    "--provider", "fake",
    "--api-key", "test-secret",
    "--model", "deterministic-model",
    "--permission", "ask",
    "--service", "declined",
    "--acknowledge-resources",
    "--sandbox-read", root,
    "--sandbox-write", root,
  ], passingOnboardingDependencies(home));
  assert.equal(result.complete, true);
  assert.equal(result.marker?.version, 1);
  assert.equal(harnessPaths(home).home, home);
  assert.equal((await onboard(["--non-interactive"], passingOnboardingDependencies(home))).complete, true);
  process.stdout.write("ok — non-interactive onboarding flags drive the resumable machine through injected test verifiers\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
