// Protected paths: directories and repos the owner declared OFF-LIMITS — never read,
// never stored, never shown; no flag bypasses it. Lives at <home>/protected_paths.json:
//
//   { "paths": ["/Users/you/Documents/Personal"], "repos": ["Personal"] }
//
// `paths` block a directory TREE — the directory and everything nested beneath it.
// `repos` block by resolved repo name (case-insensitive) — the safety net for worktrees of
// a protected repo that live elsewhere. Direct file-tool guards consume this policy; OS
// enforcement owns the stronger process boundary (docs/security.md#protected-paths).

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface ProtectedPaths {
  paths: string[];
  repos: string[];
}

/** Load <home>/protected_paths.json. Missing or invalid → an empty (block-nothing) list. */
export function loadProtectedPaths(home: string): ProtectedPaths {
  try {
    const raw = JSON.parse(readFileSync(join(home, "protected_paths.json"), "utf8"));
    const strings = (v: unknown) =>
      (Array.isArray(v) ? v : []).filter((s): s is string => typeof s === "string" && !!s.trim());
    return {
      paths: strings(raw?.paths).map((p) => p.replace(/\/+$/, "")),
      repos: strings(raw?.repos),
    };
  } catch {
    return { paths: [], repos: [] };
  }
}

/** Why protected_paths.json cannot supply the owner's lists; undefined when it records them or is missing. */
export function unreadableProtectedPaths(home: string): string | undefined {
  const path = join(home, "protected_paths.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? undefined : `protected paths are unreadable at ${path}`;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return `protected paths are not valid JSON at ${path}`;
  }
  const strings = (list: unknown) => list === undefined || (Array.isArray(list) && list.every((item) => typeof item === "string"));
  const record = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  return record && strings(record.paths) && strings(record.repos)
    ? undefined
    : `protected paths must list paths and repos as strings at ${path}`;
}

const fold = (s: unknown) => String(s ?? "").toLowerCase();

/** Lexical and filesystem-resolved identities for one protected path. */
export function pathIdentities(path: string): string[] {
  let ancestor = path;
  for (;;) {
    try {
      const canonical = resolve(realpathSync.native(ancestor), relative(ancestor, path));
      return canonical === path ? [path] : [path, canonical];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return [path];
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return [path];
    ancestor = parent;
  }
}

/**
 * Is a location off-limits? True when its cwd sits inside any protected tree, or its
 * resolved repo name matches. Case-insensitive throughout — macOS's default filesystem
 * is, and a casing mismatch must over-block, never leak.
 */
export function isProtected(
  policy: ProtectedPaths | undefined,
  { cwd, repo }: { cwd?: string; repo?: string } = {},
): boolean {
  if (!policy || (!policy.paths.length && !policy.repos.length)) return false;
  if (repo && policy.repos.some((r) => fold(r) === fold(repo))) return true;
  if (cwd) {
    const c = fold(cwd);
    if (policy.paths.some((p) => c === fold(p) || c.startsWith(fold(p) + "/"))) return true;
  }
  return false;
}
