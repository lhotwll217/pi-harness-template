import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  ONBOARDING_VERSION,
  ensureHarnessWorkspace,
  loadHarnessSettings,
  type OnboardingProgress,
} from "@pi-template/contracts";
import { agentDefinitionSummary } from "./agent-definition";
import { configuredWorkspaceSkillNames } from "./runtime";
import { readSandboxPolicy } from "./sandbox";

type JsonObject = Record<string, unknown>;

function readObject(path: string): JsonObject {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export interface DoctorOptions {
  home?: string;
  installRoot?: string;
  taskCwd?: string;
  providerModelVerifier?: (provider: string, model: string) => boolean;
}

export interface DoctorReport {
  ok: boolean;
  checks: {
    roots: {
      ok: boolean;
      installRoot: string;
      harnessHome: string;
      workspace: string;
      taskCwd: string;
    };
    provider: { available: boolean; configuredCount: number };
    model: { available: boolean; selected: string | null };
    resources: { reviewed: boolean; bundled: string[]; workspaceSkills: string[]; workspaceContext: boolean };
    permission: { configured: boolean; mode: string; configPath: string };
    sandbox: { enabled: boolean; verified: boolean; reason: string };
    daemon: { configured: boolean; configuration: "installed" | "declined" | "not-configured" };
  };
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const paths = ensureHarnessWorkspace(options.home);
  const settings = loadHarnessSettings(paths.home);
  const auth = readObject(paths.piAuth);
  const piSettings = readObject(paths.piSettings);
  const provider = typeof piSettings.defaultProvider === "string" ? piSettings.defaultProvider : "";
  const model = typeof piSettings.defaultModel === "string" ? piSettings.defaultModel : "";
  const selected = provider && model ? `${provider}/${model}` : null;
  const progress = readObject(paths.onboardingProgress) as Partial<OnboardingProgress>;
  const verification = readObject(paths.sandboxVerification);
  let sandbox: DoctorReport["checks"]["sandbox"];
  try {
    const policy = readSandboxPolicy(paths.home);
    sandbox = !policy
      ? { enabled: false, verified: false, reason: "no sandbox policy; bash runs on the host" }
      : !policy.enabled
      ? { enabled: false, verified: false, reason: "turned off in sandbox.json; bash runs on the host" }
      : {
          enabled: true,
          verified: verification.ok === true,
          reason: typeof verification.reason === "string" ? verification.reason : "not verified",
        };
  } catch (error) {
    sandbox = { enabled: true, verified: false, reason: error instanceof Error ? error.message : String(error) };
  }
  let modelAvailable = false;
  if (selected) {
    if (options.providerModelVerifier) {
      modelAvailable = options.providerModelVerifier(provider, model);
    } else {
      try {
        const runtime = await ModelRuntime.create({ authPath: paths.piAuth, modelsPath: paths.piModels });
        modelAvailable = (await runtime.getAvailable(provider)).some(({ id }) => id === model);
      } catch {
        modelAvailable = false;
      }
    }
  }
  const service = settings.alwaysOn ?? "not-configured";
  const checks: DoctorReport["checks"] = {
    roots: {
      ok: existsSync(paths.home) && existsSync(paths.workspace),
      installRoot: resolve(options.installRoot ?? process.cwd()),
      harnessHome: paths.home,
      workspace: paths.workspace,
      taskCwd: resolve(options.taskCwd ?? process.cwd()),
    },
    provider: { available: Object.keys(auth).length > 0, configuredCount: Object.keys(auth).length },
    model: { available: modelAvailable, selected },
    resources: {
      reviewed: progress.version === ONBOARDING_VERSION && !!progress.stages?.resources,
      bundled: agentDefinitionSummary().map(({ id }) => id),
      workspaceSkills: configuredWorkspaceSkillNames(paths.home),
      workspaceContext: readObject(paths.resourceApprovals).workspaceContext === true,
    },
    permission: {
      configured: existsSync(paths.piPermissionConfig),
      mode: settings.permissionMode,
      configPath: paths.piPermissionConfig,
    },
    sandbox,
    daemon: {
      configured: service === "installed" || service === "declined",
      configuration: service,
    },
  };
  const ok = checks.roots.ok && checks.provider.available && checks.model.available &&
    checks.resources.reviewed && checks.permission.configured &&
    (checks.sandbox.verified || !checks.sandbox.enabled) && checks.daemon.configured;
  return { ok, checks };
}

export function formatDoctorReport(report: DoctorReport): string {
  const { checks } = report;
  return [
    `Status: ${report.ok ? "ready" : "not ready"}`,
    `Install root: ${checks.roots.installRoot}`,
    `Harness home: ${checks.roots.harnessHome}`,
    `Workspace: ${checks.roots.workspace}`,
    `Task cwd: ${checks.roots.taskCwd}`,
    `Providers: ${checks.provider.configuredCount} configured`,
    `Model: ${checks.model.selected ?? "not configured"} (${checks.model.available ? "available" : "unavailable"})`,
    `Bundled resources: ${checks.resources.bundled.join(", ")}`,
    `Workspace skills: ${checks.resources.workspaceSkills.join(", ") || "none"}`,
    `Workspace context: ${checks.resources.workspaceContext ? "approved" : "not approved"}`,
    `Permission mode: ${checks.permission.mode} (${checks.permission.configured ? "configured" : "not configured"})`,
    `Sandbox: ${checks.sandbox.enabled ? `on, ${checks.sandbox.verified ? "verified" : "not verified"}` : "off"} (${checks.sandbox.reason})`,
    `Daemon: ${checks.daemon.configuration}`,
  ].join("\n") + "\n";
}
