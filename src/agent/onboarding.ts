import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  type AuthCredential,
} from "@earendil-works/pi-coding-agent";
import {
  ONBOARDING_STAGES,
  ONBOARDING_VERSION,
  ensureHarnessWorkspace,
  harnessPaths,
  loadHarnessSettings,
  loadProtectedPaths,
  nextOnboardingStage,
  reconcilePermissionSettings,
  saveHarnessSettings,
  savePermissionMode,
  type HarnessPaths,
  type OnboardingMarker,
  type OnboardingProgress,
  type OnboardingStage,
  type PermissionMode,
  type ProtectedPaths,
  type SkillPolicy,
} from "@pi-template/contracts";
import { createLaunchdServiceAdapter, type DaemonServiceAdapter } from "../daemon/ensure";
import { runDoctor } from "./doctor";
import { AGENT_RESOURCE_CATALOG, catalogIds } from "./resource-catalog";
import { createSandboxAdapter, type SandboxAdapter, type SandboxPolicy, type SandboxVerification } from "./sandbox";

type JsonObject = Record<string, unknown>;

export interface OnboardingAnswers {
  auth?:
    | { kind: "credential"; provider: string; credential: AuthCredential }
    | { kind: "import"; sourceAuthPath: string }
    | { kind: "login"; provider: string };
  model?: { provider: string; model: string };
  resources?: {
    acknowledgedCatalogIds: string[];
    skillPolicy: SkillPolicy;
    approveWorkspaceContext: boolean;
  };
  capabilities?: { permissionMode: PermissionMode };
  protectedPaths?: ProtectedPaths;
  sandbox?: { policy: SandboxPolicy };
  service?: {
    choice: "installed" | "declined";
    executable?: string;
    workingDirectory?: string;
  };
}

export interface OnboardingDependencies {
  home?: string;
  now?: () => string;
  authVerifier?: (paths: HarnessPaths) => boolean;
  providerLogin?: (paths: HarnessPaths, provider: string) => Promise<void>;
  modelVerifier?: (paths: HarnessPaths, selection: { provider: string; model: string }) => boolean;
  sandbox?: SandboxAdapter;
  service?: DaemonServiceAdapter;
  readiness?: (home: string) => Promise<{ ok: boolean; reason: string }>;
  platform?: NodeJS.Platform;
}

export interface OnboardingResult {
  complete: boolean;
  progress: OnboardingProgress;
  marker?: OnboardingMarker;
}

export class OnboardingStageError extends Error {
  constructor(readonly stage: OnboardingStage, message: string, options?: ErrorOptions) {
    super(`${stage}: ${message}`, options);
    this.name = "OnboardingStageError";
  }
}

function readObject(path: string): JsonObject {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode });
  renameSync(temporary, path);
}

function currentProgress(path: string): OnboardingProgress {
  const value = readObject(path) as Partial<OnboardingProgress>;
  if (value.version !== ONBOARDING_VERSION || !value.stages || typeof value.stages !== "object") {
    return { version: ONBOARDING_VERSION, stages: {} };
  }
  return { version: ONBOARDING_VERSION, stages: { ...value.stages } };
}

function selectedModel(paths: HarnessPaths): { provider: string; model: string } | undefined {
  const settings = readObject(paths.piSettings);
  const provider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : "";
  const model = typeof settings.defaultModel === "string" ? settings.defaultModel : "";
  return provider && model ? { provider, model } : undefined;
}

function defaultAuthVerifier(paths: HarnessPaths): boolean {
  try {
    return AuthStorage.create(paths.piAuth).list().length > 0;
  } catch {
    return false;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function verifyHome(paths: HarnessPaths): boolean {
  return [paths.home, paths.workspace, paths.workspaceSkills, paths.workspaceArtifacts, paths.piAgentDir, paths.logsDir]
    .every((path) => existsSync(path) && statSync(path).isDirectory()) &&
    [paths.workspaceInstructions, paths.workspaceMemory].every((path) => existsSync(path) && statSync(path).isFile());
}

function requireAnswer<T>(stage: OnboardingStage, answer: T | undefined): T {
  if (answer === undefined) throw new OnboardingStageError(stage, "explicit owner input is required");
  return answer;
}

/** Versioned, resumable setup. A stage timestamp is durable only after its predicate passes. */
export async function runOnboarding(
  answers: OnboardingAnswers,
  dependencies: OnboardingDependencies = {},
): Promise<OnboardingResult> {
  const paths = harnessPaths(dependencies.home);
  const now = dependencies.now ?? (() => new Date().toISOString());
  const authVerifier = dependencies.authVerifier ?? defaultAuthVerifier;
  const modelVerifier = dependencies.modelVerifier ?? ((ownedPaths, selection) => {
    const auth = AuthStorage.create(ownedPaths.piAuth);
    const registry = ModelRegistry.create(auth, ownedPaths.piModels);
    const model = registry.find(selection.provider, selection.model);
    return !!model && registry.hasConfiguredAuth(model);
  });
  const sandbox = dependencies.sandbox ?? createSandboxAdapter();
  const service = dependencies.service ?? createLaunchdServiceAdapter({ platform: dependencies.platform });
  const readiness = dependencies.readiness ?? (async (home) => {
    const report = await runDoctor({ home });
    return { ok: report.ok, reason: report.ok ? "doctor passed" : "one or more doctor checks failed" };
  });
  let progress = currentProgress(paths.onboardingProgress);
  const existingMarker = readObject(paths.onboardingMarker) as Partial<OnboardingMarker>;
  if (
    existingMarker.version === ONBOARDING_VERSION &&
    typeof existingMarker.completedAt === "string" &&
    ONBOARDING_STAGES.every((stage) => !!progress.stages[stage])
  ) {
    return { complete: true, progress, marker: existingMarker as OnboardingMarker };
  }
  let sandboxResult: SandboxVerification | undefined;
  let readinessResult: { ok: boolean; reason: string } | undefined;

  for (let stage = nextOnboardingStage(progress); stage; stage = nextOnboardingStage(progress)) {
    try {
      switch (stage) {
        case "home": {
          ensureHarnessWorkspace(paths.home);
          if (!verifyHome(paths)) throw new Error("harness roots or owner workspace files are unavailable");
          break;
        }
        case "auth": {
          const answer = answers.auth;
          if (answer?.kind === "credential") {
            if (!answer.provider.trim()) throw new Error("provider name is required");
            AuthStorage.create(paths.piAuth).set(answer.provider, answer.credential);
          } else if (answer?.kind === "import") {
            const imported = readObject(answer.sourceAuthPath);
            if (!Object.keys(imported).length) throw new Error("approved credential import contains no providers");
            writeJsonAtomic(paths.piAuth, imported);
          } else if (answer?.kind === "login") {
            if (!answer.provider.trim()) throw new Error("provider name is required");
            if (!dependencies.providerLogin) throw new Error("provider login is not configured for this onboarding surface");
            await dependencies.providerLogin(paths, answer.provider);
          }
          if (!authVerifier(paths)) throw new Error("no usable provider credentials are configured");
          break;
        }
        case "model": {
          const answer = answers.model ?? selectedModel(paths);
          if (!answer?.provider.trim() || !answer.model.trim()) throw new Error("provider and model selection are required");
          const existing = readObject(paths.piSettings);
          writeJsonAtomic(paths.piSettings, {
            ...existing,
            defaultProvider: answer.provider,
            defaultModel: answer.model,
          });
          const selection = selectedModel(paths);
          if (!selection || !modelVerifier(paths, selection)) throw new Error("selected model is unavailable or unauthorized");
          break;
        }
        case "resources": {
          const answer = requireAnswer(stage, answers.resources);
          const expected = catalogIds(AGENT_RESOURCE_CATALOG);
          if (!sameJson(answer.acknowledgedCatalogIds, expected)) {
            throw new Error("resource review must acknowledge the exact ordered catalog");
          }
          saveHarnessSettings(paths.home, { skillPolicy: answer.skillPolicy });
          writeJsonAtomic(resolve(paths.home, "resource-approvals.json"), {
            workspaceContext: answer.approveWorkspaceContext,
          });
          if (
            !sameJson(loadHarnessSettings(paths.home).skillPolicy, answer.skillPolicy) ||
            readObject(resolve(paths.home, "resource-approvals.json")).workspaceContext !== answer.approveWorkspaceContext
          ) {
            throw new Error("approved workspace resource policy was not persisted");
          }
          break;
        }
        case "capabilities": {
          const answer = requireAnswer(stage, answers.capabilities);
          savePermissionMode(paths.home, answer.permissionMode);
          if (loadHarnessSettings(paths.home).permissionMode !== answer.permissionMode || !existsSync(paths.piPermissionConfig)) {
            throw new Error("permission posture was not reconciled into Pi configuration");
          }
          break;
        }
        case "protected-paths": {
          const answer = requireAnswer(stage, answers.protectedPaths);
          writeJsonAtomic(paths.protectedPaths, answer);
          reconcilePermissionSettings(paths.home);
          if (!sameJson(readObject(paths.protectedPaths), answer) || !existsSync(paths.piPermissionConfig)) {
            throw new Error("protected paths were not persisted and reconciled");
          }
          break;
        }
        case "sandbox": {
          const answer = requireAnswer(stage, answers.sandbox);
          const mandatoryDeniedRoots = [
            paths.piAgentDir,
            ...loadProtectedPaths(paths.home).paths,
          ].map((path) => resolve(path));
          const policy: SandboxPolicy = {
            ...answer.policy,
            filesystem: {
              ...answer.policy.filesystem,
              deniedReadRoots: [...new Set([
                ...answer.policy.filesystem.deniedReadRoots.map((path) => resolve(path)),
                ...mandatoryDeniedRoots,
              ])],
              // ASRT read allows override denies. Do not retain a broad allow that would
              // reopen a credential or owner-protected subtree.
              allowedReadRoots: answer.policy.filesystem.allowedReadRoots
                .map((path) => resolve(path))
                .filter((allowed) => !mandatoryDeniedRoots.some((denied) =>
                  denied === allowed || denied.startsWith(allowed + sep))),
            },
          };
          writeJsonAtomic(resolve(paths.home, "sandbox.json"), policy);
          sandboxResult = await sandbox.verify(policy);
          writeJsonAtomic(resolve(paths.home, "sandbox-verification.json"), {
            ...sandboxResult,
            verifiedAt: now(),
          });
          if (!sandboxResult.ok) throw new Error(`sandbox verification failed: ${sandboxResult.reason}`);
          break;
        }
        case "service": {
          const answer = requireAnswer(stage, answers.service);
          if ((dependencies.platform ?? process.platform) !== "darwin" && answer.choice === "installed") {
            throw new Error("always-on service installation is not supported on this platform");
          }
          const configuration = answer.choice === "installed"
            ? {
                home: paths.home,
                executable: requireAnswer(stage, answer.executable),
                workingDirectory: requireAnswer(stage, answer.workingDirectory),
              }
            : undefined;
          await service.configure(answer.choice, configuration);
          saveHarnessSettings(paths.home, { alwaysOn: answer.choice });
          if (!await service.verify(answer.choice) || loadHarnessSettings(paths.home).alwaysOn !== answer.choice) {
            throw new Error("daemon service choice could not be verified");
          }
          break;
        }
        case "readiness": {
          readinessResult = await readiness(paths.home);
          if (!readinessResult.ok) throw new Error(`model-free doctor failed: ${readinessResult.reason}`);
          break;
        }
      }
    } catch (error) {
      if (error instanceof OnboardingStageError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new OnboardingStageError(stage, message, { cause: error });
    }
    progress = {
      version: ONBOARDING_VERSION,
      stages: { ...progress.stages, [stage]: now() },
    };
    writeJsonAtomic(paths.onboardingProgress, progress);
  }

  if (ONBOARDING_STAGES.some((stage) => !progress.stages[stage])) {
    return { complete: false, progress };
  }
  const marker: OnboardingMarker = { version: ONBOARDING_VERSION, completedAt: now() };
  writeJsonAtomic(paths.onboardingMarker, marker);
  return { complete: true, progress, marker };
}
