import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  ONBOARDING_STAGES,
  ONBOARDING_VERSION,
  ensureHarnessWorkspace,
  harnessPaths,
  isPermissionMode,
  loadHarnessSettings,
  loadProtectedPaths,
  nextOnboardingStage,
  reconcilePermissionSettings,
  saveHarnessSettings,
  savePermissionMode,
  unreadableProtectedPaths,
  type HarnessPaths,
  type OnboardingMarker,
  type OnboardingProgress,
  type OnboardingStage,
  type PermissionMode,
  type ProtectedPaths,
  type SkillPolicy,
} from "@pi-template/contracts";
import { createLaunchdServiceAdapter, type DaemonServiceAdapter } from "../daemon/ensure";
import { readAuthFile } from "./auth-file";
import { runDoctor } from "./doctor";
import { AGENT_DEFINITION, definitionIds } from "./agent-definition";
import {
  createSandboxAdapter,
  homeInWriteRootsProblem,
  readSandboxPolicy,
  sandboxPolicyPath,
  type SandboxAdapter,
  type SandboxPolicy,
  type SandboxVerification,
} from "./sandbox";

type JsonObject = Record<string, unknown>;

export interface OnboardingAnswers {
  auth?:
    | { kind: "credential"; provider: string; credential: Credential }
    | {
        kind: "import";
        sourceAuthPath: string;
        sourceSettingsPath?: string;
        sourceModelsPath?: string;
      }
    | { kind: "login"; provider: string };
  model?: { provider: string; model: string };
  resources?: {
    acknowledgedDefinitionIds: string[];
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
  modelVerifier?: (paths: HarnessPaths, selection: { provider: string; model: string }) => boolean | Promise<boolean>;
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

/** Pi 1.0.3 renamed provider azure-openai-responses to azure without migrating auth.json (earendil-works/pi#9714). */
export function readStandaloneCredentials(path: string): JsonObject {
  const credentials = readAuthFile(path);
  const { "azure-openai-responses": legacyAzure, ...rest } = credentials;
  return legacyAzure === undefined || "azure" in rest ? credentials : { ...rest, azure: legacyAzure };
}

function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode });
  renameSync(temporary, path);
}

function copyFileAtomic(source: string, destination: string, mode = 0o600): void {
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, readFileSync(source), { mode });
  renameSync(temporary, destination);
}

function importModelSettings(source: string, destination: string): void {
  const imported = readObject(source);
  const defaultProvider = typeof imported.defaultProvider === "string" ? imported.defaultProvider : undefined;
  const defaultModel = typeof imported.defaultModel === "string" ? imported.defaultModel : undefined;
  const defaultThinkingLevel = typeof imported.defaultThinkingLevel === "string"
    ? imported.defaultThinkingLevel
    : undefined;
  const enabledModels = Array.isArray(imported.enabledModels) && imported.enabledModels.every((model) => typeof model === "string")
    ? imported.enabledModels
    : undefined;
  if (!defaultProvider && !defaultModel && !defaultThinkingLevel && !enabledModels) return;
  writeJsonAtomic(destination, {
    ...readObject(destination),
    ...(defaultProvider ? { defaultProvider } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
    ...(enabledModels ? { enabledModels } : {}),
  });
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
  return Object.keys(readAuthFile(paths.piAuth)).length > 0;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function verifyHome(paths: HarnessPaths): boolean {
  return [paths.home, paths.workspace, paths.workspaceSkills, paths.workspaceArtifacts, paths.piAgentDir, paths.logsDir]
    .every((path) => existsSync(path) && statSync(path).isDirectory()) &&
    [paths.workspaceInstructions, paths.workspaceMemory].every((path) => existsSync(path) && statSync(path).isFile());
}

/** The answers onboarding wrote to a home; an answer it never wrote is undefined, never a default. */
export function recordedAnswers(home?: string): OnboardingAnswers {
  const paths = harnessPaths(home);
  const settings = readObject(paths.settings);
  const approvals = readObject(paths.resourceApprovals);
  const acknowledged = approvals.acknowledgedDefinitionIds;
  let sandbox: SandboxPolicy | undefined;
  try {
    sandbox = readSandboxPolicy(paths.home);
  } catch {
    sandbox = undefined;
  }
  return {
    model: selectedModel(paths),
    resources: typeof approvals.workspaceContext === "boolean"
      ? {
          acknowledgedDefinitionIds: Array.isArray(acknowledged)
            ? acknowledged.filter((id): id is string => typeof id === "string")
            : [],
          skillPolicy: loadHarnessSettings(paths.home).skillPolicy,
          approveWorkspaceContext: approvals.workspaceContext,
        }
      : undefined,
    capabilities: isPermissionMode(settings.permissionMode) ? { permissionMode: settings.permissionMode } : undefined,
    protectedPaths: existsSync(paths.protectedPaths) && !unreadableProtectedPaths(paths.home)
      ? loadProtectedPaths(paths.home)
      : undefined,
    sandbox: sandbox ? { policy: sandbox } : undefined,
    service: settings.alwaysOn === "installed" || settings.alwaysOn === "declined"
      ? { choice: settings.alwaysOn }
      : undefined,
  };
}

const ANSWERED_STAGES = {
  resources: "resources",
  capabilities: "capabilities",
  "protected-paths": "protectedPaths",
  sandbox: "sandbox",
  service: "service",
} as const satisfies Partial<Record<OnboardingStage, keyof OnboardingAnswers>>;

function requireAnswer<T>(stage: OnboardingStage, answer: T | undefined): T {
  if (answer === undefined) throw new OnboardingStageError(stage, "explicit owner input is required");
  return answer;
}

function assertRerunCanFinish(answers: OnboardingAnswers, hasCredentials: () => boolean): void {
  if (!answers.auth && !hasCredentials()) {
    throw new OnboardingStageError("auth", "no usable provider credentials are configured");
  }
  requireAnswer("model", answers.model);
  for (const [stage, key] of Object.entries(ANSWERED_STAGES) as [OnboardingStage, keyof OnboardingAnswers][]) {
    requireAnswer(stage, answers[key]);
  }
  if (!sameJson(answers.resources!.acknowledgedDefinitionIds, definitionIds(AGENT_DEFINITION))) {
    throw new OnboardingStageError("resources", "resource review must acknowledge the exact agent definition");
  }
}

/** Versioned, resumable setup. A stage timestamp is durable only after its predicate passes.
 * On a completed home every stage runs again; an omitted answer keeps the recorded one. */
export async function runOnboarding(
  explicitAnswers: OnboardingAnswers,
  dependencies: OnboardingDependencies = {},
): Promise<OnboardingResult> {
  const paths = harnessPaths(dependencies.home);
  const recorded = recordedAnswers(paths.home);
  const answers: OnboardingAnswers = {
    auth: explicitAnswers.auth,
    model: explicitAnswers.model ?? recorded.model,
    resources: explicitAnswers.resources ?? recorded.resources,
    capabilities: explicitAnswers.capabilities ?? recorded.capabilities,
    protectedPaths: explicitAnswers.protectedPaths ?? recorded.protectedPaths,
    sandbox: explicitAnswers.sandbox ?? recorded.sandbox,
    service: explicitAnswers.service ?? recorded.service,
  };
  const now = dependencies.now ?? (() => new Date().toISOString());
  const authVerifier = dependencies.authVerifier ?? defaultAuthVerifier;
  const modelVerifier = dependencies.modelVerifier ?? (async (ownedPaths, selection) => {
    const runtime = await ModelRuntime.create({ authPath: ownedPaths.piAuth, modelsPath: ownedPaths.piModels });
    return (await runtime.getAvailable(selection.provider)).some(({ id }) => id === selection.model);
  });
  const sandbox = dependencies.sandbox ?? createSandboxAdapter();
  const service = dependencies.service ?? createLaunchdServiceAdapter({ platform: dependencies.platform });
  const readiness = dependencies.readiness ?? (async (home) => {
    const report = await runDoctor({ home });
    return { ok: report.ok, reason: report.ok ? "doctor passed" : "one or more doctor checks failed" };
  });
  const writeRootProblem = answers.sandbox && homeInWriteRootsProblem(paths.home, answers.sandbox.policy);
  if (writeRootProblem) throw new OnboardingStageError("sandbox", writeRootProblem);
  let progress = currentProgress(paths.onboardingProgress);
  const existingMarker = readObject(paths.onboardingMarker) as Partial<OnboardingMarker>;
  if (
    existingMarker.version === ONBOARDING_VERSION &&
    typeof existingMarker.completedAt === "string" &&
    ONBOARDING_STAGES.every((stage) => !!progress.stages[stage])
  ) {
    assertRerunCanFinish(answers, () => authVerifier(paths));
    rmSync(paths.onboardingMarker, { force: true });
    progress = { version: ONBOARDING_VERSION, stages: {} };
    writeJsonAtomic(paths.onboardingProgress, progress);
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
            // Pi does not export its file-backed credential store; merge so every other provider stays.
            writeJsonAtomic(paths.piAuth, { ...readAuthFile(paths.piAuth), [answer.provider]: answer.credential });
          } else if (answer?.kind === "import") {
            const imported = readStandaloneCredentials(answer.sourceAuthPath);
            if (!Object.keys(imported).length) throw new Error("approved credential import contains no providers");
            writeJsonAtomic(paths.piAuth, imported);
            if (answer.sourceSettingsPath && existsSync(answer.sourceSettingsPath)) {
              importModelSettings(answer.sourceSettingsPath, paths.piSettings);
            }
            if (answer.sourceModelsPath && existsSync(answer.sourceModelsPath)) {
              copyFileAtomic(answer.sourceModelsPath, paths.piModels);
            }
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
          const enabledModels = Array.isArray(existing.enabledModels) && existing.enabledModels.every((model) => typeof model === "string")
            ? [...new Set([...existing.enabledModels, `${answer.provider}/${answer.model}`])]
            : undefined;
          writeJsonAtomic(paths.piSettings, {
            ...existing,
            defaultProvider: answer.provider,
            defaultModel: answer.model,
            ...(enabledModels ? { enabledModels } : {}),
          });
          const selection = selectedModel(paths);
          if (!selection || !(await modelVerifier(paths, selection))) throw new Error("selected model is unavailable or unauthorized");
          break;
        }
        case "resources": {
          const answer = requireAnswer(stage, answers.resources);
          const expected = definitionIds(AGENT_DEFINITION);
          if (!sameJson(answer.acknowledgedDefinitionIds, expected)) {
            throw new Error("resource review must acknowledge the exact agent definition");
          }
          saveHarnessSettings(paths.home, { skillPolicy: answer.skillPolicy });
          writeJsonAtomic(paths.resourceApprovals, {
            acknowledgedDefinitionIds: answer.acknowledgedDefinitionIds,
            workspaceContext: answer.approveWorkspaceContext,
          });
          if (
            !sameJson(loadHarnessSettings(paths.home).skillPolicy, answer.skillPolicy) ||
            readObject(paths.resourceApprovals).workspaceContext !== answer.approveWorkspaceContext
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
          writeJsonAtomic(sandboxPolicyPath(paths.home), policy);
          if (!policy.enabled) {
            rmSync(paths.sandboxVerification, { force: true });
            break;
          }
          sandboxResult = await sandbox.verify(policy);
          writeJsonAtomic(paths.sandboxVerification, {
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
          const keepsInstall = answer.choice === "installed" && answer.executable === undefined &&
            loadHarnessSettings(paths.home).alwaysOn === "installed";
          if (!keepsInstall) {
            const configuration = answer.choice === "installed"
              ? {
                  home: paths.home,
                  executable: requireAnswer(stage, answer.executable),
                  workingDirectory: requireAnswer(stage, answer.workingDirectory),
                }
              : undefined;
            await service.configure(answer.choice, configuration);
          }
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
