import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import {
  GatewayRouteError,
  MAX_WORKSPACE_FILE_CHARS,
  MAX_WORKSPACE_TREE_ENTRIES,
  RESERVED_WORKSPACE_ROOT_NAMES,
  isReservedWorkspaceRootName,
  parseWorkspacePath,
  type WorkspaceEntry,
  type WorkspaceFile,
  type WorkspaceFileWrite,
  type WorkspaceFileWriteResult,
  type WorkspaceTree,
} from "@pi-template/contracts";

export interface WorkspaceFiles {
  tree(): Promise<WorkspaceTree>;
  read(path: string): Promise<WorkspaceFile>;
  write(path: string, input: WorkspaceFileWrite): Promise<WorkspaceFileWriteResult>;
}

const MAX_UTF8_BYTES_PER_CODE_POINT = 4;
/** macOS PATH_MAX (sys/syslimits.h) is 1024 bytes including the terminating NUL. */
const MAX_PATH_BYTES = 1_023;
const temporaryName = (): string => `.pi-template-${randomBytes(6).toString("hex")}.tmp`;
const TEMPORARY_NAME_BYTES = temporaryName().length;

const revisionOf = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

const tooLarge = (path: string) =>
  new GatewayRouteError(413, "too_large", `${path} is longer than ${MAX_WORKSPACE_FILE_CHARS} characters`);

const linkRefusal = (path: string) =>
  new GatewayRouteError(400, "symlink_rejected", `${path} passes through a link; the file routes follow none`);

const reservedRefusal = (name: string) =>
  new GatewayRouteError(403, "reserved_path", `${name} belongs to the harness; the file routes do not serve it`);

/** A filesystem error as a refusal that names the workspace path, never the absolute one. */
function refusalOf(path: string, error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (error instanceof GatewayRouteError || typeof code !== "string") return error;
  if (code === "ENOENT") return new GatewayRouteError(404, "not_found", `${path} does not exist`);
  if (code === "ELOOP") return linkRefusal(path);
  if (code === "ENAMETOOLONG") return new GatewayRouteError(400, "invalid_path", `${path} is longer than the filesystem allows`);
  return new GatewayRouteError(500, "filesystem_error", `${path}: ${code}`);
}

async function identityAt(path: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path, { bigint: true });
    return `${stats.dev}:${stats.ino}`;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

/**
 * The filesystem decides which names reach a reserved entry: a name that resolves to the same
 * (dev, inode) as AGENTS.md, artifacts, or skills is that entry, whatever its spelling.
 */
async function reservedIdentities(root: string): Promise<Set<string>> {
  const found = await Promise.all(RESERVED_WORKSPACE_ROOT_NAMES.map((name) => identityAt(join(root, name))));
  return new Set(found.filter((identity): identity is string => identity !== undefined));
}

async function refuseReserved(root: string, name: string): Promise<void> {
  const identity = await identityAt(join(root, name));
  if (identity !== undefined && (await reservedIdentities(root)).has(identity)) throw reservedRefusal(name);
}

/**
 * Node has no openat or renameat: a local process that swaps a checked folder for a link
 * between the walk and the rename can still redirect a write (docs/security.md).
 */
export function createWorkspaceFiles(options: { root: string; onWrite: () => void }): WorkspaceFiles {
  let writes: Promise<unknown> = Promise.resolve();

  /** The workspace's real path and the path's segments, refused before any folder is touched. */
  async function locate(path: string): Promise<{ root: string; segments: string[] }> {
    const segments = parseWorkspacePath(path);
    const root = await realpath(options.root);
    const name = Buffer.byteLength(segments.at(-1)!);
    const folder = Buffer.byteLength(join(root, ...segments.slice(0, -1)));
    if (folder + 1 + Math.max(name, TEMPORARY_NAME_BYTES) > MAX_PATH_BYTES) {
      throw new GatewayRouteError(400, "invalid_path", `${path} is longer than the filesystem allows`);
    }
    return { root, segments };
  }

  /** Walks to the path's folder; with `created`, makes missing folders and records each it made. */
  async function parentOf(path: string, root: string, segments: string[], created?: string[]): Promise<string> {
    let folder = root;
    for (const [index, segment] of segments.slice(0, -1).entries()) {
      folder = join(folder, segment);
      let stats = await lstatOrUndefined(folder);
      if (!stats && created) {
        try {
          await mkdir(folder, { mode: 0o700 });
          created.push(folder);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        stats = await lstat(folder);
      }
      if (!stats) throw new GatewayRouteError(404, "not_found", `${path} does not exist`);
      if (index === 0) await refuseReserved(root, segment);
      if (stats.isSymbolicLink()) throw linkRefusal(path);
      if (!stats.isDirectory()) throw new GatewayRouteError(400, "invalid_path", `${path} names a file as a folder`);
    }
    return folder;
  }

  async function readCurrent(path: string, target: string): Promise<{ bytes: Uint8Array; stats: Stats } | undefined> {
    const stats = await lstatOrUndefined(target);
    if (!stats) return undefined;
    if (stats.isSymbolicLink()) throw linkRefusal(path);
    if (!stats.isFile()) throw new GatewayRouteError(400, "invalid_path", `${path} is not a file`);
    if (stats.size > MAX_UTF8_BYTES_PER_CODE_POINT * MAX_WORKSPACE_FILE_CHARS) throw tooLarge(path);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return { bytes: await handle.readFile(), stats: await handle.stat() };
    } finally {
      await handle.close();
    }
  }

  async function tree(): Promise<WorkspaceTree> {
    const root = await realpath(options.root);
    const reserved = await reservedIdentities(root);
    const entries: WorkspaceEntry[] = [];
    const visit = async (folder: string, prefix: string): Promise<boolean> => {
      const children = (await readdir(folder, { withFileTypes: true }))
        .filter((child) => !child.name.startsWith(".") && !(prefix === "" && isReservedWorkspaceRootName(child.name)))
        .filter((child) => child.isDirectory() || child.isFile())
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const child of children) {
        if (entries.length === MAX_WORKSPACE_TREE_ENTRIES) return false;
        const path = `${prefix}${child.name}`;
        const stats = await lstatOrUndefined(join(folder, child.name));
        if (!stats || stats.isSymbolicLink()) continue;
        if (prefix === "" && reserved.has(await identityAt(join(folder, child.name)) ?? "")) continue;
        const directory = stats.isDirectory();
        entries.push({ path, kind: directory ? "directory" : "file", size: directory ? 0 : stats.size, modifiedAt: stats.mtime.toISOString() });
        if (directory && !await visit(join(folder, child.name), `${path}/`)) return false;
      }
      return true;
    };
    const complete = await visit(root, "");
    return { entries, truncated: !complete };
  }

  async function read(path: string): Promise<WorkspaceFile> {
    const { root, segments } = await locate(path);
    const name = segments.at(-1)!;
    const folder = await parentOf(path, root, segments);
    if (segments.length === 1) await refuseReserved(root, name);
    const current = await readCurrent(path, join(folder, name));
    if (!current) throw new GatewayRouteError(404, "not_found", `${path} does not exist`);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(current.bytes);
    } catch {
      throw new GatewayRouteError(415, "not_text", `${path} is not UTF-8 text`);
    }
    if (content.length > MAX_WORKSPACE_FILE_CHARS) throw tooLarge(path);
    return { path, content, revision: revisionOf(current.bytes), modifiedAt: current.stats.mtime.toISOString() };
  }

  async function writeNow(path: string, input: WorkspaceFileWrite): Promise<WorkspaceFileWriteResult> {
    const { root, segments } = await locate(path);
    if (typeof input?.content !== "string") throw new GatewayRouteError(400, "invalid_request", "content must be a string");
    if (input.content.length > MAX_WORKSPACE_FILE_CHARS) throw tooLarge(path);
    if (input.baseRevision !== undefined && typeof input.baseRevision !== "string") {
      throw new GatewayRouteError(400, "invalid_request", "baseRevision must be a string");
    }
    const name = segments.at(-1)!;
    const createdFolders: string[] = [];
    let placeholder: string | undefined;
    try {
      const folder = await parentOf(path, root, segments, createdFolders);
      const target = join(folder, name);
      if (segments.length === 1) await refuseReserved(root, name);
      const current = await readCurrent(path, target);
      const currentRevision = current ? revisionOf(current.bytes) : null;
      if (input.baseRevision !== undefined && input.baseRevision !== currentRevision) {
        throw new GatewayRouteError(409, "file_changed", `${path} changed since revision ${input.baseRevision}`, {
          current: { revision: currentRevision },
        });
      }
      if (!current && segments.length === 1) {
        // Only an entry that exists can be compared, so a new root file is created empty first.
        await (await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)).close();
        placeholder = target;
        await refuseReserved(root, name);
      }
      const bytes = new TextEncoder().encode(input.content);
      const temporary = join(folder, temporaryName());
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        try {
          if (current) await handle.chmod(current.stats.mode & 0o777);
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      placeholder = undefined;
      createdFolders.length = 0;
      const written = await lstat(target);
      options.onWrite();
      return { path, revision: revisionOf(bytes), modifiedAt: written.mtime.toISOString(), created: !current };
    } finally {
      if (placeholder) await rm(placeholder, { force: true });
      for (const folder of createdFolders.reverse()) await rmdir(folder).catch(() => undefined);
    }
  }

  const refused = <T>(path: string, attempt: () => Promise<T>): Promise<T> =>
    attempt().catch((error: unknown) => { throw refusalOf(path, error); });

  return {
    tree: () => refused("the workspace", tree),
    read: (path) => refused(path, () => read(path)),
    write(path, input) {
      const result = writes.then(() => refused(path, () => writeNow(path, input)));
      writes = result.catch(() => undefined);
      return result;
    },
  };
}
