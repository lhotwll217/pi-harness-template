import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  DAEMON_PROBE_TIMEOUT_MS,
  ONBOARDING_VERSION,
  ensureHarnessWorkspace,
  loadHarnessSettings,
  loadProtectedPaths,
  type OnboardingProgress,
  type SkillPolicy,
} from "@pi-template/contracts";
import { agentDefinitionSummary, unacknowledgedDefinitionMessage } from "./agent-definition";
import { readAuthFile } from "./auth-file";
import { inspectWorkspaceSkills, protectedPathsProblem, unacknowledgedResources, type SkippedSkillEntry, type SkippedSkillLink } from "./runtime";
import { GatewayRequestError, probeAgentGateway } from "../gateway/client";
import { checkoutRoot, homeInWriteRootsProblem, readSandboxPolicy } from "./sandbox";

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
  platform?: NodeJS.Platform;
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
    provider: { available: boolean; configuredCount: number; problem?: string };
    model: { available: boolean; selected: string | null };
    resources: {
      reviewed: boolean;
      unacknowledged: string[];
      bundled: string[];
      skillPolicy: SkillPolicy;
      workspaceSkills: string[];
      brokenSkillLinksNotLoaded: Array<{ name: string; target: string }>;
      skippedSkillLinks: SkippedSkillLink[];
      skippedSkillEntries: SkippedSkillEntry[];
      skillNameCollisionsNotLoaded: Array<{ name: string; path: string; winner: string }>;
      workspaceContext: boolean;
      notices: string[];
    };
    permission: { configured: boolean; mode: string; configPath: string };
    protectedPaths: { readable: boolean; reason: string };
    sandbox: { enabled: boolean; verified: boolean; reason: string };
    daemon: { configured: boolean; configuration: "installed" | "declined" | "not-configured" };
    agentCli: { reachable: boolean; reason: string };
  };
}

// sun_path holds 104 bytes on macOS and 108 on Linux, NUL included.
const maxSocketPathBytes = (platform: NodeJS.Platform): number => platform === "darwin" ? 103 : 107;

async function healthProblem(socketPath: string): Promise<string | undefined> {
  try {
    await probeAgentGateway(socketPath, { signal: AbortSignal.timeout(DAEMON_PROBE_TIMEOUT_MS) });
    return undefined;
  } catch (error) {
    if (error instanceof GatewayRequestError) return `HTTP ${error.status}`;
    return (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
  }
}

async function agentCliReach(socketPath: string, sandboxOn: boolean, platform: NodeJS.Platform): Promise<DoctorReport["checks"]["agentCli"]> {
  for (const program of [join(checkoutRoot, "pi-template"), join(dirname(process.execPath), "node")]) {
    try {
      accessSync(program, constants.X_OK);
    } catch {
      return { reachable: false, reason: `${program} is missing or not executable, so the agent's bash cannot run pi-template` };
    }
  }
  if (Buffer.byteLength(socketPath) > maxSocketPathBytes(platform)) {
    return {
      reachable: false,
      reason: `the agent socket ${socketPath} is longer than a unix socket path may be; move the harness home to a shorter path`,
    };
  }
  const problem = await healthProblem(socketPath);
  if (problem) return { reachable: false, reason: `the daemon does not answer on the agent socket ${socketPath} (${problem})` };
  if (sandboxOn && platform !== "darwin") {
    return {
      reachable: false,
      reason: `the sandbox admits one unix socket only on macOS, so sandboxed bash on ${platform} cannot reach the daemon`,
    };
  }
  return { reachable: true, reason: `the agent's bash reaches the daemon through ${socketPath}` };
}

export const setupReady = ({ checks }: DoctorReport): boolean =>
  checks.roots.ok && checks.provider.available && checks.model.available &&
  checks.resources.reviewed && checks.permission.configured &&
  checks.protectedPaths.readable &&
  (checks.sandbox.verified || !checks.sandbox.enabled) && checks.daemon.configured;

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const paths = ensureHarnessWorkspace(options.home);
  const settings = loadHarnessSettings(paths.home);
  let providerCheck: DoctorReport["checks"]["provider"];
  try {
    const configuredCount = Object.keys(readAuthFile(paths.piAuth)).length;
    providerCheck = { available: configuredCount > 0, configuredCount };
  } catch (error) {
    providerCheck = { available: false, configuredCount: 0, problem: error instanceof Error ? error.message : String(error) };
  }
  const piSettings = readObject(paths.piSettings);
  const provider = typeof piSettings.defaultProvider === "string" ? piSettings.defaultProvider : "";
  const model = typeof piSettings.defaultModel === "string" ? piSettings.defaultModel : "";
  const selected = provider && model ? `${provider}/${model}` : null;
  const progress = readObject(paths.onboardingProgress) as Partial<OnboardingProgress>;
  const verification = readObject(paths.sandboxVerification);
  let sandbox: DoctorReport["checks"]["sandbox"];
  try {
    const policy = readSandboxPolicy(paths.home);
    const writeRootProblem = policy && homeInWriteRootsProblem(paths.home, policy);
    sandbox = writeRootProblem
      ? { enabled: true, verified: false, reason: writeRootProblem }
      : !policy
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
  const protectedProblem = protectedPathsProblem(paths.home);
  const recordedProtected = loadProtectedPaths(paths.home);
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const protectedPaths: DoctorReport["checks"]["protectedPaths"] = protectedProblem
    ? { readable: false, reason: protectedProblem }
    : existsSync(paths.protectedPaths)
    ? { readable: true, reason: `${count(recordedProtected.paths.length, "path")}, ${count(recordedProtected.repos.length, "repo")}` }
    : { readable: true, reason: "none recorded" };
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
  const unacknowledged = unacknowledgedResources(paths.home);
  const skills = inspectWorkspaceSkills(paths.home);
  const staleMemory = resolve(paths.workspace, "MEMORY.md");
  const notices = [
    ...(unacknowledged.length ? [unacknowledgedDefinitionMessage(unacknowledged)] : []),
    ...(skills.unreadable ? [`${paths.workspaceSkills} is unreadable (${skills.unreadable}), so no workspace skill loads`] : []),
    ...(existsSync(staleMemory) ? [`${staleMemory} is no longer loaded; ${paths.workspaceInstructions} is the instructions file`] : []),
    ...(settings.skillPolicy.mode === "bundled"
      ? ["skill policy is bundled, so no workspace skill loads; load them with " +
        "`pi-template onboard --non-interactive --acknowledge-resources --workspace-skills all`"]
      : []),
  ];
  const checks: DoctorReport["checks"] = {
    roots: {
      ok: existsSync(paths.home) && existsSync(paths.workspace),
      installRoot: resolve(options.installRoot ?? process.cwd()),
      harnessHome: paths.home,
      workspace: paths.workspace,
      taskCwd: resolve(options.taskCwd ?? process.cwd()),
    },
    provider: providerCheck,
    model: { available: modelAvailable, selected },
    resources: {
      reviewed: progress.version === ONBOARDING_VERSION && !!progress.stages?.resources && !unacknowledged.length,
      unacknowledged,
      bundled: agentDefinitionSummary().map(({ id }) => id),
      skillPolicy: settings.skillPolicy,
      workspaceSkills: skills.loaded,
      brokenSkillLinksNotLoaded: skills.brokenLinks,
      skippedSkillLinks: skills.skippedLinks,
      skippedSkillEntries: skills.skippedEntries,
      skillNameCollisionsNotLoaded: skills.collisions,
      workspaceContext: readObject(paths.resourceApprovals).workspaceContext === true,
      notices,
    },
    permission: {
      configured: existsSync(paths.piPermissionConfig),
      mode: settings.permissionMode,
      configPath: paths.piPermissionConfig,
    },
    protectedPaths,
    sandbox,
    daemon: {
      configured: service === "installed" || service === "declined",
      configuration: service,
    },
    agentCli: await agentCliReach(paths.agentSocket, sandbox.enabled, options.platform ?? process.platform),
  };
  const report = { ok: false, checks };
  report.ok = setupReady(report) && checks.agentCli.reachable;
  return report;
}

export function formatDoctorReport(report: DoctorReport): string {
  const { checks } = report;
  const policy = checks.resources.skillPolicy;
  return [
    `Status: ${report.ok ? "ready" : "not ready"}`,
    `Install root: ${checks.roots.installRoot}`,
    `Harness home: ${checks.roots.harnessHome}`,
    `Workspace: ${checks.roots.workspace}`,
    `Task cwd: ${checks.roots.taskCwd}`,
    `Providers: ${checks.provider.problem ? `unreadable (${checks.provider.problem})` : `${checks.provider.configuredCount} configured`}`,
    `Model: ${checks.model.selected ?? "not configured"} (${checks.model.available ? "available" : "unavailable"})`,
    `Bundled resources: ${checks.resources.bundled.join(", ")}`,
    `Workspace skills (${policy.mode}${policy.allowlist.length ? `: ${policy.allowlist.join(", ")}` : ""}): ${checks.resources.workspaceSkills.join(", ") || "none"}`,
    ...checks.resources.brokenSkillLinksNotLoaded.map(({ name, target }) => `  broken link, not loaded: ${name} -> ${target}`),
    ...checks.resources.skippedSkillLinks.map(({ name, target, reason }) => `  skipped link, not loaded: ${name} -> ${target} (${reason})`),
    ...checks.resources.skippedSkillEntries.map(({ name, reason }) => `  skipped entry, not loaded: ${name} (${reason})`),
    ...checks.resources.skillNameCollisionsNotLoaded.map(({ path, winner }) => `  name collision, not loaded: ${path} (${winner} wins)`),
    `Workspace context: ${checks.resources.workspaceContext ? "approved" : "not approved"}`,
    `Permission mode: ${checks.permission.mode} (${checks.permission.configured ? "configured" : "not configured"})`,
    `Protected paths: ${checks.protectedPaths.readable ? checks.protectedPaths.reason : `unreadable (${checks.protectedPaths.reason})`}`,
    `Sandbox: ${checks.sandbox.enabled ? `on, ${checks.sandbox.verified ? "verified" : "not verified"}` : "off"} (${checks.sandbox.reason})`,
    `Daemon: ${checks.daemon.configuration}`,
    `Agent CLI: ${checks.agentCli.reachable ? "reachable" : "unreachable"} (${checks.agentCli.reason})`,
    ...checks.resources.notices.map((notice) => `Notice: ${notice}`),
  ].join("\n") + "\n";
}
