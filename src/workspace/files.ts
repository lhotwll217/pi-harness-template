import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  GatewayRouteError,
  MAX_WORKSPACE_FILE_CHARS,
  MAX_WORKSPACE_TREE_ENTRIES,
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

/**
 * Node has no openat or renameat: a local process that swaps a checked folder for a link
 * between the walk and the rename can still redirect a write (docs/security.md).
 */
export function createWorkspaceFiles(options: { root: string; onWrite: () => void }): WorkspaceFiles {
  let writes: Promise<unknown> = Promise.resolve();

  async function parentOf(path: string, segments: string[], create: boolean): Promise<string> {
    let folder = await realpath(options.root);
    for (const segment of segments.slice(0, -1)) {
      folder = join(folder, segment);
      let stats = await lstatOrUndefined(folder);
      if (!stats && create) {
        await mkdir(folder, { mode: 0o700 }).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
        stats = await lstat(folder);
      }
      if (!stats) throw new GatewayRouteError(404, "not_found", `${path} does not exist`);
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
        const directory = stats.isDirectory();
        entries.push({ path, kind: directory ? "directory" : "file", size: directory ? 0 : stats.size, modifiedAt: stats.mtime.toISOString() });
        if (directory && !await visit(join(folder, child.name), `${path}/`)) return false;
      }
      return true;
    };
    const complete = await visit(await realpath(options.root), "");
    return { entries, truncated: !complete };
  }

  async function read(path: string): Promise<WorkspaceFile> {
    const segments = parseWorkspacePath(path);
    const current = await readCurrent(path, join(await parentOf(path, segments, false), segments.at(-1)!));
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
    const segments = parseWorkspacePath(path);
    if (typeof input?.content !== "string") throw new GatewayRouteError(400, "invalid_request", "content must be a string");
    if (input.content.length > MAX_WORKSPACE_FILE_CHARS) throw tooLarge(path);
    if (input.baseRevision !== undefined && typeof input.baseRevision !== "string") {
      throw new GatewayRouteError(400, "invalid_request", "baseRevision must be a string");
    }
    const name = segments.at(-1)!;
    const folder = await parentOf(path, segments, true);
    const target = join(folder, name);
    const current = await readCurrent(path, target);
    const currentRevision = current ? revisionOf(current.bytes) : null;
    if (input.baseRevision !== undefined && input.baseRevision !== currentRevision) {
      throw new GatewayRouteError(409, "file_changed", `${path} changed since revision ${input.baseRevision}`, {
        current: { revision: currentRevision },
      });
    }
    const bytes = new TextEncoder().encode(input.content);
    const temporary = join(folder, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
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
    const written = await lstat(target);
    options.onWrite();
    return { path, revision: revisionOf(bytes), modifiedAt: written.mtime.toISOString(), created: !current };
  }

  return {
    tree,
    read,
    write(path, input) {
      const result = writes.then(() => writeNow(path, input));
      writes = result.catch(() => undefined);
      return result;
    },
  };
}
