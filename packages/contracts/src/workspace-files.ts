import { GatewayRouteError, MAX_REQUEST_BODY_CHARS } from "./protocol";

export interface WorkspaceEntry {
  /** Relative to the workspace, `/`-separated. */
  path: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: string;
}

export interface WorkspaceTree {
  entries: WorkspaceEntry[];
  /** The listing stopped at MAX_WORKSPACE_TREE_ENTRIES. */
  truncated: boolean;
}

export interface WorkspaceFile {
  path: string;
  content: string;
  /** `sha256:<hex>` of the bytes; a write may name it as `baseRevision`. */
  revision: string;
  modifiedAt: string;
}

export interface WorkspaceFileWrite {
  content: string;
  /** The revision the client last read; a different current revision refuses the write. Omitted: create or overwrite. */
  baseRevision?: string;
}

export interface WorkspaceFileWriteResult {
  path: string;
  revision: string;
  modifiedAt: string;
  created: boolean;
}

export const MAX_WORKSPACE_TREE_ENTRIES = 5_000;
export const MAX_WORKSPACE_FILE_CHARS = MAX_REQUEST_BODY_CHARS;

/** The file routes neither list nor serve these root entries. */
export const RESERVED_WORKSPACE_ROOT_NAMES = Object.freeze(["AGENTS.md", "artifacts", "skills"] as const);

// macOS volumes are case-insensitive and may store either Unicode normalization.
const fold = (name: string): string => name.normalize("NFC").toLowerCase();
const RESERVED = new Set(RESERVED_WORKSPACE_ROOT_NAMES.map(fold));

export const isReservedWorkspaceRootName = (name: string): boolean => RESERVED.has(fold(name));

/**
 * The segments of a workspace-relative path, or a refusal: 400 `invalid_path` for an empty or
 * absolute path, a NUL or backslash, an empty, `.`, or `..` segment, or a hidden name; 403
 * `reserved_path` under a reserved root entry.
 */
export function parseWorkspacePath(raw: string): string[] {
  const invalid = (why: string) => new GatewayRouteError(400, "invalid_path", `${JSON.stringify(raw)} ${why}`);
  if (!raw) throw invalid("is empty");
  if (raw.startsWith("/")) throw invalid("is absolute; paths are relative to the workspace");
  if (raw.includes("\0") || raw.includes("\\")) throw invalid("holds a NUL or a backslash");
  const segments = raw.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") throw invalid("holds an empty, '.', or '..' segment");
    if (segment.startsWith(".")) throw invalid("names a hidden entry");
  }
  if (isReservedWorkspaceRootName(segments[0]!)) {
    throw new GatewayRouteError(403, "reserved_path", `${segments[0]} belongs to the harness; the file routes do not serve it`);
  }
  return segments;
}
