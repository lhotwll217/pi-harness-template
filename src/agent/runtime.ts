import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  AuthStorage,
  createBashToolDefinition,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  ensureHarnessWorkspace,
  loadHarnessSettings,
  reconcilePermissionSettings,
  type AgentToolId,
} from "@pi-template/contracts";
import {
  AGENT_RESOURCE_CATALOG,
  catalogIds,
  type CatalogToolDependencies,
} from "./resource-catalog";
import { createSandboxAdapter, type SandboxAdapter, type SandboxPolicy } from "./sandbox";

export interface AgentResourceOptions extends CatalogToolDependencies {
  home?: string;
  cwd: string;
}

export interface LoadedAgentResources {
  loader: DefaultResourceLoader;
  settingsManager: SettingsManager;
  tools: ToolDefinition[];
  loadedIds: string[];
  approvedWorkspaceSkillPaths: string[];
}

function safeWorkspaceSkillPaths(home: string): string[] {
  const paths = ensureHarnessWorkspace(home);
  const policy = loadHarnessSettings(home).skillPolicy;
  if (policy.mode === "bundled") return [];
  if (policy.mode === "all-workspace") return [paths.workspaceSkills];
  const root = resolve(paths.workspaceSkills);
  return policy.allowlist
    .filter((name) => /^[A-Za-z0-9._-]+$/.test(name))
    .map((name) => resolve(root, name))
    .filter((path) => path.startsWith(root + sep) && existsSync(path));
}

function workspaceContextApproved(home: string): boolean {
  try {
    const value = JSON.parse(readFileSync(join(home, "resource-approvals.json"), "utf8"));
    return value?.workspaceContext === true;
  } catch {
    return false;
  }
}

function sandboxPolicy(home: string): SandboxPolicy {
  try {
    const value = JSON.parse(readFileSync(join(home, "sandbox.json"), "utf8")) as SandboxPolicy;
    if (!value?.filesystem || !value.process || !value.network) throw new Error("invalid sandbox policy");
    return value;
  } catch (error) {
    throw new Error(`sandbox policy is unavailable under ${home}`, { cause: error });
  }
}

export async function createAgentResources(options: AgentResourceOptions): Promise<LoadedAgentResources> {
  const paths = ensureHarnessWorkspace(options.home);
  process.env.PI_CODING_AGENT_DIR = paths.piAgentDir;
  reconcilePermissionSettings(paths.home);
  const settingsManager = SettingsManager.create(paths.workspace, paths.piAgentDir, { projectTrusted: false });
  const approvedWorkspaceSkillPaths = safeWorkspaceSkillPaths(paths.home);
  const extensions = AGENT_RESOURCE_CATALOG.filter((entry) => entry.kind === "extension").map((entry) => entry.path());
  const skills = AGENT_RESOURCE_CATALOG.filter((entry) => entry.kind === "skill").map((entry) => entry.path);
  const prompts = AGENT_RESOURCE_CATALOG.filter((entry) => entry.kind === "prompt").map((entry) => entry.path);
  const tools = AGENT_RESOURCE_CATALOG
    .filter((entry) => entry.kind === "tool")
    .map((entry) => entry.create(options)) as ToolDefinition[];
  const approvedContext = workspaceContextApproved(paths.home)
    ? [paths.workspaceInstructions, paths.workspaceMemory]
        .filter(existsSync)
        .map((path) => ({ path, content: readFileSync(path, "utf8") }))
    : [];

  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: paths.piAgentDir,
    settingsManager,
    noContextFiles: true,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: extensions,
    additionalSkillPaths: [...skills, ...approvedWorkspaceSkillPaths],
    additionalPromptTemplatePaths: prompts,
    agentsFilesOverride: () => ({ agentsFiles: approvedContext }),
  });
  await loader.reload();
  const extensionErrors = loader.getExtensions().errors;
  if (extensionErrors.length) {
    throw new Error(`failed to load approved Pi extensions: ${extensionErrors.map(({ error }) => error).join("; ")}`);
  }
  return {
    loader,
    settingsManager,
    tools,
    loadedIds: catalogIds(AGENT_RESOURCE_CATALOG),
    approvedWorkspaceSkillPaths,
  };
}

export interface HarnessSessionOptions extends AgentResourceOptions {
  sessionManager?: SessionManager;
  toolsAllow?: readonly AgentToolId[];
  ephemeral?: boolean;
  sandbox?: SandboxAdapter;
  headless?: boolean;
}

function assertHeadlessApprovalPolicy(home: string): void {
  const permissionConfig = reconcilePermissionSettings(home);
  if (permissionConfig.yoloMode === true) {
    throw new Error("headless execution is denied while permission auto-approval is enabled");
  }
}

export async function createHarnessSession(options: HarnessSessionOptions) {
  const paths = ensureHarnessWorkspace(options.home);
  if (options.headless) assertHeadlessApprovalPolicy(paths.home);
  const resources = await createAgentResources(options);
  const authStorage = AuthStorage.create(paths.piAuth);
  const modelRegistry = ModelRegistry.create(authStorage, paths.piModels);
  const catalogToolNames = resources.tools.map(({ name }) => name);
  const configuredNames = [...loadHarnessSettings(paths.home).toolPosture, ...catalogToolNames];
  const enabledNames = options.toolsAllow
    ? options.toolsAllow.filter((name) => configuredNames.includes(name))
    : configuredNames;
  const sandbox = options.sandbox ?? createSandboxAdapter();
  const customTools: Array<ToolDefinition<any, any, any>> = [...resources.tools];
  if (enabledNames.includes("bash")) {
    const policy = sandboxPolicy(paths.home);
    customTools.push(createBashToolDefinition(options.cwd, {
      operations: {
        exec: async (command, cwd, execution) => await sandbox.execute(policy, {
          command,
          cwd,
          env: execution.env,
          signal: execution.signal,
          timeoutMs: execution.timeout,
          onOutput: execution.onData,
        }),
      },
    }));
  }
  const sessionManager = options.sessionManager ?? (options.ephemeral
    ? SessionManager.inMemory(options.cwd)
    : SessionManager.create(options.cwd, join(paths.home, "transcripts")));
  const result = await createAgentSession({
    cwd: options.cwd,
    agentDir: paths.piAgentDir,
    authStorage,
    modelRegistry,
    settingsManager: resources.settingsManager,
    resourceLoader: resources.loader,
    sessionManager,
    customTools,
    tools: enabledNames,
  });
  return { ...result, sessionManager, toolNames: enabledNames, loadedResourceIds: resources.loadedIds };
}

export function configuredWorkspaceSkillNames(home?: string): string[] {
  const paths = ensureHarnessWorkspace(home);
  const roots = safeWorkspaceSkillPaths(paths.home);
  if (roots.length === 1 && roots[0] === paths.workspaceSkills) {
    return readdirSync(paths.workspaceSkills, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => name)
      .sort();
  }
  return roots.map((path) => path.slice(path.lastIndexOf(sep) + 1)).sort();
}
