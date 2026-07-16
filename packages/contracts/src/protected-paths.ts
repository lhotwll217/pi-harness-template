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
