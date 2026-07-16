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
import { loadProtectedPaths, pathIdentities } from "./protected-paths";
import {
  DEFAULT_PERMISSION_MODE,
  ensureHarnessWorkspace,
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
// back to the selected mode; the lists identify known reads, bounded harness state changes, and
// risky generic changes separately.
const READ_SURFACES = ["read", "grep", "find", "ls", "skill", "query_database"];
const NATIVE_STATE_SURFACES = ["save_note"];
const CHANGE_SURFACES = ["edit", "write"];
const MANAGED_SURFACES = [...READ_SURFACES, ...NATIVE_STATE_SURFACES, ...CHANGE_SURFACES, "external_directory", "bash"];
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

function nativeStateAction(mode: PermissionMode): PiPermissionState {
  return mode === "read-only" ? "deny" : "allow";
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
  for (const surface of READ_SURFACES) next[surface] = withDefault(existing[surface], "allow");
  for (const surface of NATIVE_STATE_SURFACES) {
    next[surface] = withDefault(existing[surface], nativeStateAction(mode));
  }
  for (const surface of CHANGE_SURFACES) next[surface] = withDefault(existing[surface], action);
  next.external_directory = withDefault(existing.external_directory, "allow");
  next.bash = withDefault(existing.bash, action);

  const currentPathRules = patternMap(existing.path);
  const ownerPathRules: PiPermissionPatternMap = {};
  for (const [pattern, value] of Object.entries(currentPathRules)) {
    if (pattern !== "*" && !isGeneratedProtectedRule(value)) ownerPathRules[pattern] = value;
  }
  const generatedRule: PiDenyRule = { action: "deny", reason: PROTECTED_REASON };
  const pathRules: PiPermissionPatternMap = { "*": "allow" };
  for (const blocked of loadProtectedPaths(home).paths) {
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
  for (const surface of MANAGED_SURFACES) {
    const nextSurface = nextPermission[surface] as PiPermissionPatternMap;
    nextText = isPatternMap(existingPermission[surface])
      ? setJsoncDefaultFirst(nextText, ["permission", surface, "*"], nextSurface["*"])
      : setJsoncValue(nextText, ["permission", surface], nextSurface);
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
