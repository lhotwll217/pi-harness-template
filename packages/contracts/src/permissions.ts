// Reconciles the owner's chosen permission mode and protected paths into the Pi
// permission-system config, preserving owner-authored JSONC rules and comments. The
// permission decision layer only — OS enforcement is a separate control and passing here
// never proves sandboxing (docs/security.md).

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  SyntaxKind,
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  type Node,
} from "jsonc-parser";
import { AGENT_CLI_COMMANDS } from "./agent-cli";
import { loadProtectedPaths, pathIdentities } from "./protected-paths";
import {
  DEFAULT_PERMISSION_MODE,
  ensureHarnessWorkspace,
  harnessControlPaths,
  harnessPaths,
  isPermissionMode,
  loadHarnessSettings,
  saveHarnessSettings,
  type PermissionMode,
} from "./harness-home";

export type PiPermissionState = "allow" | "ask" | "deny";
export interface PiDenyRule {
  action: "deny";
  reason?: string;
}
export type PiPermissionPatternMap = Record<string, PiPermissionState | PiDenyRule>;
export interface PiPermissionConfig {
  permission: Record<string, PiPermissionState | PiPermissionPatternMap>;
  [key: string]: unknown;
}

const PROTECTED_REASON = "Pi Template protected paths";
// Keep these explicit defaults aligned with the agent tool catalog. Unlisted tools safely fall
// back to the selected mode; the lists identify known reads and risky generic changes separately.
const READ_SURFACES = ["read", "grep", "find", "ls", "skill"];
const CHANGE_SURFACES = ["edit", "write"];
const MANAGED_SURFACES = [...READ_SURFACES, ...CHANGE_SURFACES, "external_directory", "bash"];
/** Surfaces of tools the agent definition no longer has; reconciling removes their keys. */
const RETIRED_SURFACES = ["query_database", "save_note"];
/** Allowed in every mode, read-only included, so the agent reaches its CLI. One rule per command,
 * not `pi-template *`, which would let read-only run `onboard --permission allow`. */
const AGENT_CLI_RULES: readonly string[] = AGENT_CLI_COMMANDS.map((command) => `pi-template ${command} *`);
const JSON_FORMAT = { insertSpaces: true, tabSize: 2, eol: "\n" };

type JsonRecord = Record<string, unknown>;

function readDocument(path: string): { raw: string; value: JsonRecord } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { raw: "{}\n", value: {} };
    throw new Error(`cannot read Pi permission config at ${path}`, { cause: error });
  }
  const errors: unknown[] = [];
  const value = parse(raw, errors as never);
  if (errors.length || !isRecord(value)) throw new Error(`invalid Pi permission config at ${path}`);
  return { raw, value };
}

function writeTextAtomic(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value.endsWith("\n") ? value : `${value}\n`);
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* no temporary file to remove */ }
    throw error;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function patternMap(value: unknown): PiPermissionPatternMap {
  return isRecord(value) && !("action" in value) ? { ...(value as PiPermissionPatternMap) } : {};
}

function isPatternMap(value: unknown): value is PiPermissionPatternMap {
  return isRecord(value) && !("action" in value);
}

function withDefault(value: unknown, action: PiPermissionState): PiPermissionPatternMap {
  const rules = patternMap(value);
  delete rules["*"];
  return { "*": action, ...rules };
}

function isGeneratedProtectedRule(value: unknown): value is PiDenyRule {
  return isRecord(value) && value.action === "deny" && value.reason === PROTECTED_REASON;
}

function changeAction(mode: PermissionMode): PiPermissionState {
  return mode === "allow" ? "allow" : mode === "read-only" ? "deny" : "ask";
}

/** The owner's bash rules after `*` and the generated CLI rules, so the last matching rule, an owner deny, wins. */
function withAgentCliRules(rules: PiPermissionPatternMap): PiPermissionPatternMap {
  const { "*": fallback, ...ownerRules } = rules;
  const generated = Object.fromEntries(AGENT_CLI_RULES.filter((rule) => !(rule in ownerRules)).map((rule) => [rule, "allow" as const]));
  return { "*": fallback, ...generated, ...ownerRules };
}

/** Read-only denies every write a path names, so a bash redirect cannot write; the harness owns the `*` key. */
function pathWriteRules(existing: unknown, mode: PermissionMode): PiPermissionPatternMap | undefined {
  if (mode === "read-only") return withDefault(existing, "deny");
  const { "*": _harnessDefault, ...ownerRules } = patternMap(existing);
  return Object.keys(ownerRules).length ? ownerRules : undefined;
}

function permissionPolicy(
  existing: JsonRecord,
  home: string,
  mode: PermissionMode,
): Record<string, PiPermissionState | PiPermissionPatternMap> {
  const action = changeAction(mode);
  const next: Record<string, PiPermissionState | PiPermissionPatternMap> = {
    ...(existing as Record<string, PiPermissionState | PiPermissionPatternMap>),
    "*": action,
  };
  for (const surface of RETIRED_SURFACES) delete next[surface];
  for (const surface of READ_SURFACES) next[surface] = withDefault(existing[surface], "allow");
  for (const surface of CHANGE_SURFACES) next[surface] = withDefault(existing[surface], action);
  next.external_directory = withDefault(existing.external_directory, "allow");
  next.bash = withAgentCliRules(withDefault(existing.bash, action));
  const pathWrite = pathWriteRules(existing.path_write, mode);
  if (pathWrite) next.path_write = pathWrite;
  else delete next.path_write;

  const currentPathRules = patternMap(existing.path);
  const ownerPathRules: PiPermissionPatternMap = {};
  for (const [pattern, value] of Object.entries(currentPathRules)) {
    if (pattern !== "*" && !isGeneratedProtectedRule(value)) ownerPathRules[pattern] = value;
  }
  const generatedRule: PiDenyRule = { action: "deny", reason: PROTECTED_REASON };
  const pathRules: PiPermissionPatternMap = { "*": "allow" };
  for (const blocked of [...harnessControlPaths(harnessPaths(home)), ...loadProtectedPaths(home).paths]) {
    for (const identity of pathIdentities(blocked)) {
      pathRules[identity] = generatedRule;
      pathRules[`${identity}/*`] = generatedRule;
    }
  }
  Object.assign(pathRules, ownerPathRules);
  next.path = pathRules;
  return next;
}

function setJsoncValue(text: string, path: (string | number)[], value: unknown, first = false): string {
  return applyEdits(text, modify(text, path, value, {
    formattingOptions: JSON_FORMAT,
    ...(first ? { getInsertionIndex: () => 0 } : {}),
  }));
}

function jsoncProperty(text: string, path: (string | number)[]) {
  const root = parseTree(text);
  const value = root ? findNodeAtLocation(root, path) : undefined;
  const property = value?.parent;
  const siblings = property?.parent?.children;
  if (property?.type !== "property" || !siblings) return undefined;
  return { property, siblings, index: siblings.indexOf(property) };
}

function commaEdit(text: string, start: number, end: number) {
  const scanner = createScanner(text);
  scanner.setPosition(start);
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (scanner.getTokenOffset() >= end) return undefined;
    if (token === SyntaxKind.CommaToken) {
      return { offset: scanner.getTokenOffset(), length: scanner.getTokenLength(), content: "" };
    }
  }
  return undefined;
}

// jsonc-parser's removal range includes neighboring comments. Remove only the property and its
// separator so owner comments are not part of the deletion range.
function removeJsoncProperty(text: string, path: (string | number)[]): string {
  const located = jsoncProperty(text, path);
  if (!located) return text;
  const { property, siblings, index } = located;
  const edits: { offset: number; length: number; content: string }[] = [
    { offset: property.offset, length: property.length, content: "" },
  ];
  const next: Node | undefined = siblings[index + 1];
  const previous: Node | undefined = siblings[index - 1];
  const separator = index < siblings.length - 1 && next
    ? commaEdit(text, property.offset + property.length, next.offset)
    : index > 0 && previous
      ? commaEdit(text, previous.offset + previous.length, property.offset)
      : undefined;
  if (separator) edits.push(separator);
  return applyEdits(text, edits);
}

function setJsoncDefaultFirst(text: string, path: (string | number)[], value: unknown): string {
  const located = jsoncProperty(text, path);
  const withoutLateDefault = located && located.index > 0 ? removeJsoncProperty(text, path) : text;
  return setJsoncValue(withoutLateDefault, path, value, true);
}

function setJsoncAfterDefault(text: string, path: (string | number)[], value: unknown): string {
  return applyEdits(text, modify(text, path, value, {
    formattingOptions: JSON_FORMAT,
    getInsertionIndex: (properties) => Math.max(0, properties.indexOf("*") + 1),
  }));
}

function reconcilePermissionDocument(
  text: string,
  existingPermission: unknown,
  nextPermission: Record<string, PiPermissionState | PiPermissionPatternMap>,
): string {
  if (!isRecord(existingPermission)) return setJsoncValue(text, ["permission"], nextPermission);

  let nextText = setJsoncValue(text, ["permission", "*"], nextPermission["*"], true);
  for (const surface of RETIRED_SURFACES) nextText = removeJsoncProperty(nextText, ["permission", surface]);
  for (const surface of MANAGED_SURFACES) {
    const nextSurface = nextPermission[surface] as PiPermissionPatternMap;
    nextText = isPatternMap(existingPermission[surface])
      ? setJsoncDefaultFirst(nextText, ["permission", surface, "*"], nextSurface["*"])
      : setJsoncValue(nextText, ["permission", surface], nextSurface);
  }
  const existingBash = existingPermission.bash;
  if (isPatternMap(existingBash)) {
    // Each insertion lands directly after `*`, so inserting in reverse keeps the generated order.
    for (const rule of [...AGENT_CLI_RULES].reverse()) {
      if (!(rule in existingBash)) nextText = setJsoncAfterDefault(nextText, ["permission", "bash", rule], "allow");
    }
  }
  const nextPathWrite = nextPermission.path_write as PiPermissionPatternMap | undefined;
  if (!nextPathWrite) {
    nextText = removeJsoncProperty(nextText, ["permission", "path_write"]);
  } else if (isPatternMap(existingPermission.path_write)) {
    nextText = "*" in nextPathWrite
      ? setJsoncDefaultFirst(nextText, ["permission", "path_write", "*"], nextPathWrite["*"])
      : removeJsoncProperty(nextText, ["permission", "path_write", "*"]);
  } else {
    nextText = setJsoncValue(nextText, ["permission", "path_write"], nextPathWrite);
  }

  const existingPath = existingPermission.path;
  const nextPath = nextPermission.path as PiPermissionPatternMap;
  if (!isPatternMap(existingPath)) return setJsoncValue(nextText, ["permission", "path"], nextPath);

  nextText = setJsoncDefaultFirst(nextText, ["permission", "path", "*"], nextPath["*"]);
  for (const [pattern, value] of Object.entries(existingPath)) {
    if (isGeneratedProtectedRule(value)) {
      nextText = removeJsoncProperty(nextText, ["permission", "path", pattern]);
    }
  }
  for (const [pattern, value] of Object.entries(nextPath)) {
    if (isGeneratedProtectedRule(value)) {
      nextText = setJsoncAfterDefault(nextText, ["permission", "path", pattern], value);
    }
  }
  return nextText;
}

export function reconcilePermissionSettings(home?: string): PiPermissionConfig {
  const paths = ensureHarnessWorkspace(home);
  const { raw, value: existing } = readDocument(paths.piPermissionConfig);
  const existingPermission = isRecord(existing.permission) ? existing.permission : {};
  const mode = loadHarnessSettings(paths.home).permissionMode;
  const nextPermission = permissionPolicy(existingPermission, paths.home, mode);
  const next = { ...existing, permission: nextPermission } as PiPermissionConfig;
  writeTextAtomic(
    paths.piPermissionConfig,
    reconcilePermissionDocument(raw, existing.permission, nextPermission),
  );
  return next;
}

export function savePermissionMode(home: string | undefined, mode: PermissionMode = DEFAULT_PERMISSION_MODE): PiPermissionConfig {
  if (!isPermissionMode(mode)) throw new Error(`invalid permission mode "${mode}"`);
  saveHarnessSettings(home, { permissionMode: mode });
  return reconcilePermissionSettings(home);
}
