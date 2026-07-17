import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ONBOARDING_VERSION,
  harnessPaths,
  type OnboardingProgress,
} from "@pi-template/contracts";
import { catalogIds, AGENT_RESOURCE_CATALOG } from "./resource-catalog";
import {
  OnboardingStageError,
  runOnboarding,
  type OnboardingAnswers,
  type OnboardingDependencies,
} from "./onboarding";

const root = mkdtempSync(join(tmpdir(), "pi-template-onboarding-"));
let tick = 0;
let sandboxPasses = true;
let readinessPasses = true;
const serviceChoices: string[] = [];

const dependencies = (): OnboardingDependencies => ({
  now: () => `2026-07-16T12:00:0${tick++}.000Z`,
  authVerifier: (paths) => {
    try { return Object.keys(JSON.parse(readFileSync(paths.piAuth, "utf8"))).length > 0; } catch { return false; }
  },
  modelVerifier: (_paths, selection) => selection.provider === "fake" && selection.model === "deterministic-model",
  sandbox: {
    async execute() { throw new Error("not used during onboarding"); },
    async verify() {
      return {
        ok: sandboxPasses,
        unavailable: false,
        reason: sandboxPasses ? "verified" : "canary read escaped",
        checks: {
          allowedRootReadPermitted: sandboxPasses,
          canaryReadDenied: sandboxPasses,
          allowedRootWritePermitted: sandboxPasses,
          canaryWriteDenied: sandboxPasses,
          networkDenied: sandboxPasses,
        },
      };
    },
  },
  service: {
    async configure(choice) { serviceChoices.push(choice); },
    async verify(choice) { return serviceChoices.includes(choice); },
  },
  readiness: async () => ({ ok: readinessPasses, reason: readinessPasses ? "ready" : "doctor failed" }),
  platform: "darwin",
});

const policy = {
  filesystem: { allowedReadRoots: [root], allowedWriteRoots: [root], deniedReadRoots: [] },
  process: { allowSubprocesses: true },
  network: { mode: "deny" as const, allowedDomains: [] },
};

const completeAnswers = (): OnboardingAnswers => ({
  auth: { kind: "credential", provider: "fake", credential: { type: "api_key", key: "test-secret" } },
  model: { provider: "fake", model: "deterministic-model" },
  resources: {
    acknowledgedCatalogIds: catalogIds(AGENT_RESOURCE_CATALOG),
    skillPolicy: { mode: "bundled", allowlist: [] },
    approveWorkspaceContext: true,
  },
  capabilities: { permissionMode: "ask" },
  protectedPaths: { paths: [], repos: [] },
  sandbox: { policy },
  service: { choice: "declined" },
});

try {
  const blockedHome = join(root, "blocked-home");
  writeFileSync(blockedHome, "not a directory");
  await assert.rejects(
    runOnboarding({}, { ...dependencies(), home: blockedHome }),
    (error) => error instanceof OnboardingStageError && error.stage === "home",
  );

  const missingAuthHome = join(root, "missing-auth");
  await assert.rejects(
    runOnboarding({}, { ...dependencies(), home: missingAuthHome }),
    (error) => error instanceof OnboardingStageError && error.stage === "auth",
  );
  const missingAuthProgress = JSON.parse(
    readFileSync(harnessPaths(missingAuthHome).onboardingProgress, "utf8"),
  ) as OnboardingProgress;
  assert.deepEqual(Object.keys(missingAuthProgress.stages), ["home"]);
  assert.equal(existsSync(harnessPaths(missingAuthHome).onboardingMarker), false);

  const missingModelHome = join(root, "missing-model");
  await assert.rejects(
    runOnboarding({ auth: completeAnswers().auth }, { ...dependencies(), home: missingModelHome }),
    (error) => error instanceof OnboardingStageError && error.stage === "model",
  );

  const loginHome = join(root, "provider-login");
  let loginProvider = "";
  await assert.rejects(
    runOnboarding(
      { auth: { kind: "login", provider: "fake-login" } },
      {
        ...dependencies(),
        home: loginHome,
        providerLogin: async (paths, provider) => {
          loginProvider = provider;
          writeFileSync(paths.piAuth, JSON.stringify({ [provider]: { type: "api_key", key: "login-secret" } }));
        },
      },
    ),
    (error) => error instanceof OnboardingStageError && error.stage === "model",
  );
  assert.equal(loginProvider, "fake-login");

  const resumeHome = join(root, "resume");
  await assert.rejects(
    runOnboarding({
      auth: completeAnswers().auth,
      model: completeAnswers().model,
    }, { ...dependencies(), home: resumeHome }),
    (error) => error instanceof OnboardingStageError && error.stage === "resources",
  );
  const partial = JSON.parse(readFileSync(harnessPaths(resumeHome).onboardingProgress, "utf8")) as OnboardingProgress;
  assert.deepEqual(Object.keys(partial.stages), ["home", "auth", "model"]);
  assert.equal(existsSync(harnessPaths(resumeHome).onboardingMarker), false);

  const missingCapabilitiesHome = join(root, "missing-capabilities");
  const throughResources = completeAnswers();
  delete throughResources.capabilities;
  delete throughResources.protectedPaths;
  delete throughResources.sandbox;
  delete throughResources.service;
  await assert.rejects(
    runOnboarding(throughResources, { ...dependencies(), home: missingCapabilitiesHome }),
    (error) => error instanceof OnboardingStageError && error.stage === "capabilities",
  );

  const missingProtectedHome = join(root, "missing-protected");
  const throughCapabilities = completeAnswers();
  delete throughCapabilities.protectedPaths;
  delete throughCapabilities.sandbox;
  delete throughCapabilities.service;
  await assert.rejects(
    runOnboarding(throughCapabilities, { ...dependencies(), home: missingProtectedHome }),
    (error) => error instanceof OnboardingStageError && error.stage === "protected-paths",
  );

  const missingServiceHome = join(root, "missing-service");
  const throughSandbox = completeAnswers();
  delete throughSandbox.service;
  await assert.rejects(
    runOnboarding(throughSandbox, { ...dependencies(), home: missingServiceHome }),
    (error) => error instanceof OnboardingStageError && error.stage === "service",
  );

  const completed = await runOnboarding(completeAnswers(), { ...dependencies(), home: resumeHome });
  assert.equal(completed.complete, true);
  assert.equal(completed.marker?.version, ONBOARDING_VERSION);
  assert.ok(existsSync(harnessPaths(resumeHome).onboardingMarker));

  const sandboxHome = join(root, "sandbox-failure");
  sandboxPasses = false;
  await assert.rejects(
    runOnboarding(completeAnswers(), { ...dependencies(), home: sandboxHome }),
    (error) => error instanceof OnboardingStageError && error.stage === "sandbox",
  );
  const sandboxProgress = JSON.parse(readFileSync(harnessPaths(sandboxHome).onboardingProgress, "utf8")) as OnboardingProgress;
  assert.equal(sandboxProgress.stages.sandbox, undefined);
  assert.equal(existsSync(harnessPaths(sandboxHome).onboardingMarker), false);
  sandboxPasses = true;

  const readinessHome = join(root, "readiness-failure");
  readinessPasses = false;
  await assert.rejects(
    runOnboarding(completeAnswers(), { ...dependencies(), home: readinessHome }),
    (error) => error instanceof OnboardingStageError && error.stage === "readiness",
  );
  assert.equal(existsSync(harnessPaths(readinessHome).onboardingMarker), false);
  readinessPasses = true;

  writeFileSync(harnessPaths(resumeHome).onboardingProgress, JSON.stringify({ version: 0, stages: { readiness: "old" } }));
  writeFileSync(harnessPaths(resumeHome).onboardingMarker, JSON.stringify({ version: 0, completedAt: "old" }));
  const reopened = await runOnboarding(completeAnswers(), { ...dependencies(), home: resumeHome });
  assert.equal(reopened.progress.version, ONBOARDING_VERSION);
  assert.equal(Object.keys(reopened.progress.stages)[0], "home");
  assert.equal(reopened.marker?.version, ONBOARDING_VERSION);

  process.stdout.write("ok — onboarding resumes durably, fails closed, marks last, and reopens old versions\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
