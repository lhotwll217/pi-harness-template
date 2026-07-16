import {
  AGENT_RESOURCE_CATALOG,
  catalogIds,
  type OnboardingAnswers,
  type OnboardingDependencies,
} from "../../src/agent";

export function testOnboardingAnswers(root: string): OnboardingAnswers {
  return {
    auth: { kind: "credential", provider: "fake", credential: { type: "api_key", key: "test-secret" } },
    model: { provider: "fake", model: "deterministic-model" },
    resources: {
      acknowledgedCatalogIds: catalogIds(AGENT_RESOURCE_CATALOG),
      skillPolicy: { mode: "bundled", allowlist: [] },
      approveWorkspaceContext: false,
    },
    capabilities: { permissionMode: "ask" },
    protectedPaths: { paths: [], repos: [] },
    sandbox: {
      policy: {
        filesystem: { allowedReadRoots: [root], allowedWriteRoots: [root], deniedReadRoots: [] },
        process: { allowSubprocesses: true },
        network: { mode: "deny", allowedDomains: [] },
      },
    },
    service: { choice: "declined" },
  };
}

export function passingOnboardingDependencies(home?: string): OnboardingDependencies {
  let configuredService = "";
  return {
    home,
    authVerifier: () => true,
    modelVerifier: () => true,
    sandbox: {
      async execute() { throw new Error("not used by onboarding"); },
      async verify() {
        return {
          ok: true,
          unavailable: false,
          reason: "test verifier passed",
          checks: { allowedRootReadPermitted: true, canaryReadDenied: true, networkDenied: true },
        };
      },
    },
    service: {
      async configure(choice) { configuredService = choice; },
      async verify(choice) { return configuredService === choice; },
    },
    readiness: async () => ({ ok: true, reason: "test readiness passed" }),
    platform: "darwin",
  };
}
