// The harness home (~/.pi-template) and agent workspace: root layout, owner settings, and
// the rule that entry points may create missing harness-owned files but never overwrite
// owner-authored workspace content. See docs/architecture.md#runtime-roots.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SkillPolicy =
  | { mode: "bundled"; allowlist: [] }
  | { mode: "all-workspace"; allowlist: [] }
  | { mode: "allowlist"; allowlist: string[] };

export type PermissionMode = "ask" | "allow" | "read-only";

export interface HarnessSettings {
  skillPolicy: SkillPolicy;
  toolPosture: string[];
  permissionMode: PermissionMode;
  alwaysOn?: "installed" | "declined";
}

export const DEFAULT_SKILL_POLICY: SkillPolicy = Object.freeze({ mode: "bundled", allowlist: [] as [] });
export const DEFAULT_TOOL_POSTURE: readonly string[] = Object.freeze([
  "read", "grep", "find", "ls", "bash", "edit", "write",
]);
export const DEFAULT_PERMISSION_MODE: PermissionMode = "read-only";

const SKILL_MODES = new Set(["bundled", "all-workspace", "allowlist"]);
const TOOL_NAMES = new Set(DEFAULT_TOOL_POSTURE);
const PERMISSION_MODES = new Set<string>(["ask", "allow", "read-only"]);
const defaultHome = () => process.env.PI_TEMPLATE_HOME ?? join(homedir(), ".pi-template");

export interface HarnessPaths {
  home: string;
  workspace: string;
  workspaceInstructions: string;
  workspaceMemory: string;
  workspaceSkills: string;
  workspaceArtifacts: string;
  piAgentDir: string;
  piAuth: string;
  piSettings: string;
  piModels: string;
  piPermissionConfig: string;
  settings: string;
  onboardingMarker: string;
  onboardingProgress: string;
  protectedPaths: string;
  stateDb: string;
  daemonInfo: string;
  logsDir: string;
}

export function harnessPaths(home = defaultHome()): HarnessPaths {
  const workspace = join(home, "workspace");
  const piAgentDir = join(home, "pi");
  return {
    home,
    workspace,
    workspaceInstructions: join(workspace, "AGENTS.md"),
    workspaceMemory: join(workspace, "MEMORY.md"),
    workspaceSkills: join(workspace, "skills"),
    workspaceArtifacts: join(workspace, "artifacts"),
    piAgentDir,
    piAuth: join(piAgentDir, "auth.json"),
    piSettings: join(piAgentDir, "settings.json"),
    piModels: join(piAgentDir, "models.json"),
    piPermissionConfig: join(piAgentDir, "extensions", "pi-permission-system", "config.json"),
    settings: join(home, "settings.json"),
    onboardingMarker: join(home, "onboarded.json"),
    onboardingProgress: join(home, "onboarding-progress.json"),
    protectedPaths: join(home, "protected_paths.json"),
    stateDb: join(home, "state.db"),
    daemonInfo: join(home, "daemon.json"),
    logsDir: join(home, "logs"),
  };
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && PERMISSION_MODES.has(value);
}

function writeMissing(path: string, content: string): void {
  try {
    writeFileSync(path, content, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
  }
}

export function ensureHarnessWorkspace(home = defaultHome()): HarnessPaths {
  const paths = harnessPaths(home);
  mkdirSync(paths.workspaceSkills, { recursive: true });
  mkdirSync(paths.workspaceArtifacts, { recursive: true });
  mkdirSync(paths.piAgentDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  writeMissing(paths.workspaceInstructions, "# Pi Template instructions\n\nRecord persistent owner instructions for the harness agent here.\n");
  writeMissing(paths.workspaceMemory, "# Memory\n\nRecord durable facts for the harness agent here.\n");
  return paths;
}

function readJson(path: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

const cleanStrings = (values: unknown): string[] => [...new Set(
  (Array.isArray(values) ? values : []).map((value) => String(value ?? "").trim()).filter(Boolean),
)];

function skillPolicy(value: unknown): SkillPolicy {
  const raw = value as { mode?: string; allowlist?: unknown } | undefined;
  const mode = raw?.mode && SKILL_MODES.has(raw.mode) ? raw.mode : DEFAULT_SKILL_POLICY.mode;
  return mode === "allowlist"
    ? { mode, allowlist: cleanStrings(raw?.allowlist) }
    : { mode: mode as "bundled" | "all-workspace", allowlist: [] };
}

export function loadHarnessSettings(home = defaultHome()): HarnessSettings {
  const raw = readJson(harnessPaths(home).settings);
  const posture = cleanStrings(raw.toolPosture).filter((name) => TOOL_NAMES.has(name));
  return {
    skillPolicy: skillPolicy(raw.skillPolicy),
    toolPosture: posture.length ? posture : [...DEFAULT_TOOL_POSTURE],
    permissionMode: isPermissionMode(raw.permissionMode) ? raw.permissionMode : DEFAULT_PERMISSION_MODE,
    alwaysOn: raw.alwaysOn === "installed" || raw.alwaysOn === "declined" ? raw.alwaysOn : undefined,
  };
}

export function saveHarnessSettings(
  home: string | undefined = undefined,
  patch: Partial<HarnessSettings> = {},
): HarnessSettings {
  const paths = ensureHarnessWorkspace(home ?? defaultHome());
  const current = readJson(paths.settings);
  const merged = {
    ...current,
    ...patch,
    ...(patch.skillPolicy ? { skillPolicy: skillPolicy(patch.skillPolicy) } : {}),
    ...(patch.toolPosture
      ? { toolPosture: cleanStrings(patch.toolPosture).filter((name) => TOOL_NAMES.has(name)) }
      : {}),
    ...(patch.permissionMode && isPermissionMode(patch.permissionMode)
      ? { permissionMode: patch.permissionMode }
      : {}),
  };
  if (Object.hasOwn(patch, "alwaysOn") && patch.alwaysOn !== "installed" && patch.alwaysOn !== "declined") {
    throw new Error('alwaysOn must be "installed" or "declined"');
  }
  writeFileSync(paths.settings, JSON.stringify(merged, null, 2) + "\n");
  return loadHarnessSettings(paths.home);
}
