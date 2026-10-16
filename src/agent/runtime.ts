import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createBashToolDefinition,
  createLocalBashOperations,
  createAgentSessionFromServices,
  createAgentSessionServices,
  loadSkills,
  SessionManager,
  SettingsManager,
  type AgentSessionServices,
  type BashOperations,
  type ResourceLoader,
  type SessionStartEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
  ensureHarnessWorkspace,
  harnessControlPaths,
  harnessPaths,
  loadHarnessSettings,
  reconcilePermissionSettings,
  unreadableProtectedPaths,
  type AgentToolId,
} from "@pi-template/contracts";
import {
  AGENT_DEFINITION,
  definitionIds,
  piTemplateIdentityPrompt,
  unacknowledgedDefinitionIds,
  unacknowledgedDefinitionMessage,
  type AgentToolDependencies,
} from "./agent-definition";
import {
  commandEnvironment,
  createSandboxAdapter,
  homeInWriteRootsProblem,
  kernelPath,
  readSandboxPolicy,
  type SandboxAdapter,
  type SandboxPolicy,
} from "./sandbox";

export interface AgentResourceOptions extends AgentToolDependencies {
  home?: string;
  cwd: string;
  systemPromptOverride?: () => string;
}

export interface LoadedAgentResources {
  loader: ResourceLoader;
  settingsManager: SettingsManager;
  tools: ToolDefinition[];
  loadedIds: string[];
  approvedWorkspaceSkillPaths: string[];
}

export interface HarnessSessionServices {
  services: AgentSessionServices;
  tools: ToolDefinition[];
  loadedIds: string[];
  approvedWorkspaceSkillPaths: string[];
}

export interface SkippedSkillLink {
  name: string;
  target: string;
  reason: string;
}

/** Workspace skill entries under the home's skill policy. Pi follows linked directories without a
 * cycle check, so a link back to workspace/skills or above, or a second link to one folder, is skipped. */
function workspaceSkillEntries(home: string): { paths: string[]; skipped: SkippedSkillLink[] } {
  const paths = ensureHarnessWorkspace(home);
  const policy = loadHarnessSettings(home).skillPolicy;
  if (policy.mode === "bundled") return { paths: [], skipped: [] };
  const root = resolve(paths.workspaceSkills);
  const names = policy.mode === "all-workspace"
    ? readdirSync(root).filter((name) => !name.startsWith(".") && name !== "node_modules").sort()
    : policy.allowlist.filter((name) => /^[A-Za-z0-9._-]+$/.test(name));
  const candidates = names
    .map((name) => ({ name, path: resolve(root, name) }))
    .filter(({ path }) => path.startsWith(root + sep) && existsSync(path))
    .map((entry) => ({ ...entry, link: lstatSync(entry.path).isSymbolicLink(), real: realpathSync(entry.path) }));
  const realRoot = realpathSync(root);
  const seen = new Map<string, string>();
  const selected: string[] = [];
  const skipped: SkippedSkillLink[] = [];
  for (const entry of [...candidates.filter(({ link }) => !link), ...candidates.filter(({ link }) => link)]) {
    const fromEntryToRoot = relative(entry.real, realRoot);
    if (fromEntryToRoot !== ".." && !fromEntryToRoot.startsWith(`..${sep}`) && !isAbsolute(fromEntryToRoot)) {
      skipped.push({ name: entry.name, target: readlinkSync(entry.path), reason: "loops back to workspace/skills" });
    } else if (seen.has(entry.real)) {
      skipped.push({ name: entry.name, target: readlinkSync(entry.path), reason: `repeats ${seen.get(entry.real)}` });
    } else {
      seen.set(entry.real, entry.name);
      selected.push(entry.path);
    }
  }
  return { paths: selected, skipped: skipped.sort((left, right) => left.name.localeCompare(right.name)) };
}

function recordedApprovals(home: string): { acknowledgedDefinitionIds?: unknown; workspaceContext?: unknown } {
  try {
    const value = JSON.parse(readFileSync(harnessPaths(home).resourceApprovals, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/** Entries of the current agent definition the home's recorded resource review does not cover. */
export function unacknowledgedResources(home?: string): string[] {
  const { acknowledgedDefinitionIds } = recordedApprovals(harnessPaths(home).home);
  return unacknowledgedDefinitionIds(Array.isArray(acknowledgedDefinitionIds) ? acknowledgedDefinitionIds : []);
}

/** Why no session may start over this home's protected_paths.json, with the recovery; undefined when none. */
export function protectedPathsProblem(home: string): string | undefined {
  const problem = unreadableProtectedPaths(home);
  return problem && `${problem}; the agent will not start without the owner's protected paths. ` +
    "Fix the file, or record them again with `pi-template onboard` " +
    "(non-interactive: `pi-template onboard --non-interactive --protected-path <dir>`)";
}

function assertSessionCanStart(home: string): void {
  const protectedProblem = protectedPathsProblem(home);
  if (protectedProblem) throw new Error(protectedProblem);
  const policy = readSandboxPolicy(home);
  const writeRootProblem = policy && homeInWriteRootsProblem(home, policy);
  if (writeRootProblem) throw new Error(writeRootProblem);
  const unacknowledged = unacknowledgedResources(home);
  if (unacknowledged.length) throw new Error(unacknowledgedDefinitionMessage(unacknowledged));
}

/** Build Pi's cwd-bound services with every ambient resource source disabled. */
export async function createHarnessSessionServices(
  options: AgentResourceOptions,
): Promise<HarnessSessionServices> {
  const paths = ensureHarnessWorkspace(options.home);
  assertSessionCanStart(paths.home);
  process.env.PI_CODING_AGENT_DIR = paths.piAgentDir;
  reconcilePermissionSettings(paths.home);
  const settingsManager = SettingsManager.create(paths.workspace, paths.piAgentDir, { projectTrusted: false });
  const approvedWorkspaceSkillPaths = workspaceSkillEntries(paths.home).paths;
  const extensions = AGENT_DEFINITION.filter((entry) => entry.kind === "extension").map((entry) => entry.path());
  const skills = AGENT_DEFINITION.filter((entry) => entry.kind === "skill").map((entry) => entry.path);
  const tools = AGENT_DEFINITION
    .filter((entry) => entry.kind === "tool")
    .map((entry) => entry.create(options)) as ToolDefinition[];
  const approvedContext = recordedApprovals(paths.home).workspaceContext === true && existsSync(paths.workspaceInstructions)
    ? [{ path: paths.workspaceInstructions, content: readFileSync(paths.workspaceInstructions, "utf8") }]
    : [];

  const services = await createAgentSessionServices({
    cwd: options.cwd,
    agentDir: paths.piAgentDir,
    settingsManager,
    resourceLoaderOptions: {
      noContextFiles: true,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalExtensionPaths: extensions,
      additionalSkillPaths: [...skills, ...approvedWorkspaceSkillPaths],
      systemPromptOverride: options.systemPromptOverride ?? piTemplateIdentityPrompt,
      appendSystemPromptOverride: () => [],
      agentsFilesOverride: () => ({ agentsFiles: approvedContext }),
    },
  });
  const extensionErrors = services.resourceLoader.getExtensions().errors;
  if (extensionErrors.length) {
    throw new Error(`failed to load approved Pi extensions: ${extensionErrors.map(({ error }) => error).join("; ")}`);
  }
  return {
    services,
    tools,
    loadedIds: definitionIds(AGENT_DEFINITION),
    approvedWorkspaceSkillPaths,
  };
}

export async function createAgentResources(options: AgentResourceOptions): Promise<LoadedAgentResources> {
  const prepared = await createHarnessSessionServices(options);
  return {
    loader: prepared.services.resourceLoader,
    settingsManager: prepared.services.settingsManager,
    tools: prepared.tools,
    loadedIds: prepared.loadedIds,
    approvedWorkspaceSkillPaths: prepared.approvedWorkspaceSkillPaths,
  };
}

export interface HarnessSessionOptions extends AgentResourceOptions {
  sessionManager?: SessionManager;
  sessionStartEvent?: SessionStartEvent;
  toolsAllow?: readonly AgentToolId[];
  ephemeral?: boolean;
  sandbox?: SandboxAdapter;
  headless?: boolean;
  model?: Model<any>;
}

function assertHeadlessApprovalPolicy(home: string): void {
  const permissionConfig = reconcilePermissionSettings(home);
  if (permissionConfig.yoloMode === true) {
    throw new Error("headless execution is denied while permission auto-approval is enabled");
  }
}

export function enforcedSandboxPolicy(home: string, policy: SandboxPolicy): SandboxPolicy {
  // The sandbox resolves symlinks only in paths that exist; a control file not yet written
  // must still be denied under the path the kernel matches.
  const paths = harnessPaths(kernelPath(home));
  return {
    ...policy,
    filesystem: {
      ...policy.filesystem,
      deniedReadRoots: [...new Set([...policy.filesystem.deniedReadRoots, paths.piAgentDir])],
      deniedWriteRoots: harnessControlPaths(paths),
    },
  };
}

const MAX_TIMEOUT_MS = 2_147_483_647;

/** Pi's bash timeout rule (pi-coding-agent bash.js resolveTimeoutMs, not exported): Node timers overflow past 2^31-1 ms. */
function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
  return timeoutMs;
}

function bashOperations(home: string, sandbox: SandboxAdapter): BashOperations {
  const policy = readSandboxPolicy(home);
  if (!policy?.enabled) {
    const local = createLocalBashOperations();
    return {
      exec: async (command, cwd, execution) =>
        await local.exec(command, cwd, { ...execution, env: commandEnvironment(execution.env ?? process.env) }),
    };
  }
  const enforced = enforcedSandboxPolicy(home, policy);
  return {
    exec: async (command, cwd, execution) => {
      const timeoutMs = resolveTimeoutMs(execution.timeout);
      const { exitCode, timedOut } = await sandbox.execute(enforced, {
        command,
        cwd,
        env: execution.env,
        signal: execution.signal,
        timeoutMs,
        onOutput: execution.onData,
      });
      // Pi's bash tool turns these messages into "Command aborted" and "Command timed out after N seconds".
      if (execution.signal?.aborted) throw new Error("aborted");
      if (timedOut) throw new Error(`timeout:${execution.timeout}`);
      return { exitCode };
    },
  };
}

export async function createHarnessSession(options: HarnessSessionOptions) {
  const paths = ensureHarnessWorkspace(options.home);
  assertSessionCanStart(paths.home);
  if (options.headless) assertHeadlessApprovalPolicy(paths.home);
  const resources = await createHarnessSessionServices(options);
  const definedToolNames = resources.tools.map(({ name }) => name);
  const configuredNames = [...loadHarnessSettings(paths.home).toolPosture, ...definedToolNames];
  const enabledNames = options.toolsAllow
    ? options.toolsAllow.filter((name) => configuredNames.includes(name))
    : configuredNames;
  const sandbox = options.sandbox ?? createSandboxAdapter();
  const customTools: Array<ToolDefinition<any, any, any>> = [...resources.tools];
  if (enabledNames.includes("bash")) {
    customTools.push(createBashToolDefinition(options.cwd, { operations: bashOperations(paths.home, sandbox) }));
  }
  const sessionManager = options.sessionManager ?? (options.ephemeral
    ? SessionManager.inMemory(options.cwd)
    : SessionManager.create(options.cwd, join(paths.home, "transcripts")));
  const result = await createAgentSessionFromServices({
    services: resources.services,
    sessionManager,
    customTools,
    tools: enabledNames,
    sessionStartEvent: options.sessionStartEvent,
    model: options.model,
  });
  return {
    ...result,
    services: resources.services,
    diagnostics: resources.services.diagnostics,
    sessionManager,
    toolNames: enabledNames,
    loadedResourceIds: resources.loadedIds,
  };
}

export interface WorkspaceSkillReport {
  loaded: string[];
  brokenLinks: Array<{ name: string; target: string }>;
  skippedLinks: SkippedSkillLink[];
  collisions: Array<{ name: string; path: string; winner: string }>;
}

/** What a session loads from workspace/skills under the home's skill policy, and what it leaves out. */
export function inspectWorkspaceSkills(home?: string): WorkspaceSkillReport {
  const paths = ensureHarnessWorkspace(home);
  const entries = workspaceSkillEntries(paths.home);
  const bundled = AGENT_DEFINITION.filter((entry) => entry.kind === "skill");
  const { skills, diagnostics } = loadSkills({
    cwd: paths.workspace,
    agentDir: paths.piAgentDir,
    skillPaths: [...bundled.map(({ path }) => path), ...entries.paths],
    includeDefaults: false,
  });
  const bundledNames = new Set(bundled.map(({ name }) => name));
  return {
    loaded: skills.map(({ name }) => name).filter((name) => !bundledNames.has(name)).sort(),
    // Pi skips a link whose target is gone without a diagnostic.
    brokenLinks: readdirSync(paths.workspaceSkills, { withFileTypes: true })
      .filter((entry) => entry.isSymbolicLink() && !existsSync(join(paths.workspaceSkills, entry.name)))
      .map(({ name }) => ({ name, target: readlinkSync(join(paths.workspaceSkills, name)) }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    skippedLinks: entries.skipped,
    collisions: diagnostics.flatMap(({ collision }) => collision
      ? [{ name: collision.name, path: collision.loserPath, winner: collision.winnerPath }]
      : []),
  };
}
