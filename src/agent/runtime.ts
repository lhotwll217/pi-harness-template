import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
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

export interface SkippedSkillEntry {
  name: string;
  reason: string;
}

const containsRealPath = (folder: string, path: string): boolean =>
  path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);

const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? String(error);
const unreadableEntry = (name: string, error: unknown): SkippedSkillEntry =>
  ({ name, reason: `unreadable (${errorCode(error)}), so nothing in it loads` });

function linkTarget(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

/** Pi follows linked folders with no visited set, so stacked links multiply its walk; a workspace
 * skill entry that would make Pi walk more folders than this stays out. */
const MAX_SKILL_ENTRY_FOLDERS = 5000;

// Pi 1.3.0 dist/core/skills.js:12-56 (not exported): ignore files apply below the folder holding them.
const toPosixPath = (path: string) => path.split(sep).join("/");
function prefixIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) return null;
  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const prefixed = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${prefixed}` : prefixed;
}
function addIgnoreRules(ig: Ignore, dir: string, rootDir: string): void {
  const relativeDir = relative(rootDir, dir);
  const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";
  for (const filename of [".gitignore", ".ignore", ".fdignore"]) {
    const ignorePath = join(dir, filename);
    if (!existsSync(ignorePath)) continue;
    try {
      const patterns = readFileSync(ignorePath, "utf-8")
        .split(/\r?\n/)
        .map((line) => prefixIgnorePattern(line, prefix))
        .filter((line): line is string => Boolean(line));
      if (patterns.length > 0) ig.add(patterns);
    } catch {}
  }
}

interface SkillFolderChild {
  name: string;
  path: string;
  link: boolean;
  directory: boolean;
  file: boolean;
}

/** One folder as Pi 1.3.0 reads it (dist/core/skills.js:125-207): a SKILL.md ends the folder;
 * otherwise Pi visits the children that are not dot entries, node_modules, broken links, or ignored. */
function readSkillFolder(dir: string, root: string, ig: Ignore): { skillFile?: string; children: SkillFolderChild[] } {
  try {
    statSync(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { children: [] };
    throw error;
  }
  addIgnoreRules(ig, dir, root);
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name !== "SKILL.md") continue;
    const path = join(dir, entry.name);
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        isFile = statSync(path).isFile();
      } catch {
        continue;
      }
    }
    if (isFile && !ig.ignores(toPosixPath(relative(root, path)))) return { skillFile: path, children: [] };
  }
  const children: SkillFolderChild[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    let directory = entry.isDirectory();
    let file = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const stats = statSync(path);
        directory = stats.isDirectory();
        file = stats.isFile();
      } catch {
        continue;
      }
    }
    const relativePath = toPosixPath(relative(root, path));
    if (ig.ignores(directory ? `${relativePath}/` : relativePath)) continue;
    children.push({ name: entry.name, path, link: entry.isSymbolicLink(), directory, file });
  }
  return { children };
}

interface SkillWalk {
  root: string;
  ig: Ignore;
  folders: number;
  overCap: boolean;
  files: string[];
  loops: Map<string, { path: string; target: string; loopsTo: string }>;
  unreadable: Map<string, unknown>;
}

/** The skill files Pi would load from one folder, walked path by path as Pi walks; a linked folder
 * that contains a folder on its own walk chain is a loop and is recorded instead of followed. */
function walkSkillFolder(dir: string, realAncestors: string[], walk: SkillWalk, includeRootFiles: boolean): void {
  if (walk.overCap) return;
  if (++walk.folders > MAX_SKILL_ENTRY_FOLDERS) {
    walk.overCap = true;
    return;
  }
  let folder: ReturnType<typeof readSkillFolder>;
  try {
    folder = readSkillFolder(dir, walk.root, walk.ig);
  } catch (error) {
    walk.unreadable.set(dir, error);
    return;
  }
  if (folder.skillFile) {
    walk.files.push(folder.skillFile);
    return;
  }
  for (const child of folder.children) {
    if (child.directory) {
      let real: string;
      try {
        real = child.link ? realpathSync(child.path) : join(realAncestors[realAncestors.length - 1], child.name);
      } catch (error) {
        walk.unreadable.set(child.path, error);
        continue;
      }
      if (realAncestors.some((ancestor) => containsRealPath(real, ancestor))) {
        const key = join(realAncestors[realAncestors.length - 1], child.name);
        if (child.link && !walk.loops.has(key)) {
          walk.loops.set(key, { path: child.path, target: linkTarget(child.path) ?? real, loopsTo: real });
        }
        continue;
      }
      realAncestors.push(real);
      walkSkillFolder(child.path, realAncestors, walk, false);
      realAncestors.pop();
      if (walk.overCap) return;
    } else if (includeRootFiles && child.file && child.name.endsWith(".md")) {
      walk.files.push(child.path);
    }
  }
}

interface WorkspaceSkillSelection {
  /** Skill files in Pi's discovery order, handed to Pi one by one so Pi never walks a folder itself. */
  paths: string[];
  skippedLinks: SkippedSkillLink[];
  skippedEntries: SkippedSkillEntry[];
  unreadable?: string;
}

/** The workspace skill files Pi would load from the skill policy's paths: workspace/skills as one
 * root for all-workspace, each allowlisted entry as its own root for allowlist. An entry with a
 * looping link, or one that would make Pi walk more than MAX_SKILL_ENTRY_FOLDERS folders, stays out. */
function workspaceSkillEntries(home: string): WorkspaceSkillSelection {
  const paths = ensureHarnessWorkspace(home);
  const policy = loadHarnessSettings(home).skillPolicy;
  const selection: WorkspaceSkillSelection = { paths: [], skippedLinks: [], skippedEntries: [] };
  if (policy.mode === "bundled") return selection;
  const root = resolve(paths.workspaceSkills);
  let realRoot: string;
  let top: ReturnType<typeof readSkillFolder>;
  const rootIgnore = ignore();
  try {
    realRoot = realpathSync(root);
    // A folder that can be listed but not entered yields no readable file, so Pi loads nothing from it.
    accessSync(root, constants.R_OK | constants.X_OK);
    top = readSkillFolder(root, root, rootIgnore);
  } catch (error) {
    return { ...selection, unreadable: errorCode(error) };
  }
  const shown = (folder: string) => containsRealPath(realRoot, folder) ? relative(realRoot, folder) || "workspace/skills" : folder;
  const unreadable = (path: string, error: unknown) => selection.skippedEntries.push(unreadableEntry(relative(root, path), error));
  const take = (entry: SkillFolderChild, walkRoot: string, ig: Ignore, includeEntryFiles: boolean) => {
    if (!entry.directory) {
      if (entry.file && entry.name.endsWith(".md")) selection.paths.push(entry.path);
      return;
    }
    let real: string;
    try {
      real = realpathSync(entry.path);
    } catch (error) {
      unreadable(entry.path, error);
      return;
    }
    if (containsRealPath(real, realRoot)) {
      if (entry.link) selection.skippedLinks.push({ name: entry.name, target: linkTarget(entry.path) ?? real, reason: "loops back to workspace/skills" });
      return;
    }
    const walk: SkillWalk = { root: walkRoot, ig, folders: 0, overCap: false, files: [], loops: new Map(), unreadable: new Map() };
    walkSkillFolder(entry.path, [realRoot, real], walk, includeEntryFiles);
    for (const [path, error] of walk.unreadable) unreadable(path, error);
    if (walk.loops.size) {
      selection.skippedLinks.push(...[...walk.loops.values()].map(({ path, target, loopsTo }) => ({
        name: relative(root, path),
        target,
        reason: `loops back to ${shown(loopsTo)}, so ${entry.name} is not loaded`,
      })));
    } else if (walk.overCap) {
      selection.skippedEntries.push({
        name: entry.name,
        reason: `Pi would walk more than ${MAX_SKILL_ENTRY_FOLDERS} folders in ${entry.name}, so ${entry.name} is not loaded`,
      });
    } else {
      selection.paths.push(...walk.files);
    }
  };
  if (policy.mode === "all-workspace") {
    if (top.skillFile) return { ...selection, paths: [top.skillFile] };
    for (const entry of top.children) take(entry, root, rootIgnore, false);
  } else {
    for (const name of policy.allowlist.filter((name) => /^[A-Za-z0-9._-]+$/.test(name))) {
      const path = resolve(root, name);
      if (!path.startsWith(root + sep)) continue;
      let stats: ReturnType<typeof statSync>;
      let link: boolean;
      try {
        stats = statSync(path);
        link = lstatSync(path).isSymbolicLink();
      } catch (error) {
        if (errorCode(error) !== "ENOENT") unreadable(path, error);
        continue;
      }
      take(
        { name, path, link, directory: stats.isDirectory(), file: stats.isFile() },
        path,
        ignore(),
        true,
      );
    }
  }
  const byName = (left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name);
  selection.skippedLinks.sort(byName);
  selection.skippedEntries.sort(byName);
  // Pi 1.3.0's resource loader (mergePaths) drops a second path to the same real file before loading.
  const realFiles = new Set<string>();
  selection.paths = selection.paths.filter((path) => {
    let real = path;
    try {
      real = realpathSync(path);
    } catch {}
    if (realFiles.has(real)) return false;
    realFiles.add(real);
    return true;
  });
  return selection;
}

function recordedApprovals(home: string): { acknowledgedDefinitionIds?: unknown; workspaceContext?: unknown } {
  try {
    const value = JSON.parse(readFileSync(harnessPaths(home).resourceApprovals, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

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
  unreadable?: string;
  brokenLinks: Array<{ name: string; target: string }>;
  skippedLinks: SkippedSkillLink[];
  skippedEntries: SkippedSkillEntry[];
  collisions: Array<{ name: string; path: string; winner: string }>;
}

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
  const brokenLinks: WorkspaceSkillReport["brokenLinks"] = [];
  const skippedEntries = [...entries.skippedEntries];
  if (!entries.unreadable) {
    let links: string[] = [];
    try {
      links = readdirSync(paths.workspaceSkills, { withFileTypes: true }).filter((entry) => entry.isSymbolicLink()).map(({ name }) => name);
    } catch {}
    for (const name of links.filter((name) => !existsSync(join(paths.workspaceSkills, name)))) {
      try {
        brokenLinks.push({ name, target: readlinkSync(join(paths.workspaceSkills, name)) });
      } catch (error) {
        skippedEntries.push(unreadableEntry(name, error));
      }
    }
  }
  const byName = (left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name);
  return {
    loaded: skills.map(({ name }) => name).filter((name) => !bundledNames.has(name)).sort(),
    ...(entries.unreadable ? { unreadable: entries.unreadable } : {}),
    brokenLinks: brokenLinks.sort(byName),
    skippedLinks: entries.skippedLinks,
    skippedEntries: skippedEntries.sort(byName),
    collisions: diagnostics.flatMap(({ collision }) => collision
      ? [{ name: collision.name, path: collision.loserPath, winner: collision.winnerPath }]
      : []),
  };
}
