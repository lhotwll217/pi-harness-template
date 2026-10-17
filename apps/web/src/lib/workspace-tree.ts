import type { ChatId, ChatSummary, WorkspaceEntry, WorkspaceTree } from "./gateway-contracts";
import { pathName, pathParent } from "./workspace-paths";

/** One identity for every focusable row, so the sidebar navigates one list with one cursor. */
export type TreeRowId =
  | { readonly kind: "chats" }
  | { readonly kind: "chat"; readonly chatId: ChatId }
  | { readonly kind: "files" }
  | { readonly kind: "entry"; readonly path: string };

export interface TreeRow {
  readonly id: TreeRowId;
  readonly key: string;
  readonly label: string;
  readonly depth: number;
  readonly isDirectory: boolean;
  readonly isExpanded: boolean;
  /** A chat the client minted that the Gateway has not stored yet. */
  readonly local?: boolean;
}

export type TreeIntent =
  | { readonly kind: "focus"; readonly id: TreeRowId }
  | { readonly kind: "toggle"; readonly id: TreeRowId }
  | { readonly kind: "activate"; readonly id: TreeRowId };

/** Keys carry their kind, so a folder named `chats` can never collide with the chats group. */
export function treeRowKey(id: TreeRowId): string {
  switch (id.kind) {
    case "chats": return "chats";
    case "chat": return `chat:${id.chatId}`;
    case "files": return "files";
    case "entry": return `entry:${id.path}`;
  }
}

export function sameTreeRow(a: TreeRowId | undefined, b: TreeRowId | undefined): boolean {
  return a !== undefined && b !== undefined && treeRowKey(a) === treeRowKey(b);
}

/** Every ancestor folder of `path` is expanded, so its row is on screen. */
function ancestorsExpanded(path: string, expanded: ReadonlySet<string>): boolean {
  for (let parent = pathParent(path); parent !== undefined; parent = pathParent(parent)) {
    if (!expanded.has(treeRowKey({ kind: "entry", path: parent }))) return false;
  }
  return true;
}

function pushEntries(entries: readonly WorkspaceEntry[], expanded: ReadonlySet<string>, rows: TreeRow[]): void {
  for (const entry of entries) {
    if (!ancestorsExpanded(entry.path, expanded)) continue;
    const id: TreeRowId = { kind: "entry", path: entry.path };
    const isDirectory = entry.kind === "directory";
    rows.push({
      id,
      key: treeRowKey(id),
      label: pathName(entry.path),
      depth: entry.path.split("/").length,
      isDirectory,
      isExpanded: isDirectory && expanded.has(treeRowKey(id)),
    });
  }
}

/**
 * The visible rows in render order: the Files section holding the workspace tree, then the
 * Chats section, newest first. The Gateway lists entries depth-first with folders first, so
 * the flat list already is the render order; a row shows when every folder above it is open.
 * Rendering and keyboard navigation read this one list, so the cursor never lands on a
 * hidden row. `expanded` holds `treeRowKey`s.
 */
export function flattenVisible(
  tree: WorkspaceTree | undefined,
  expanded: ReadonlySet<string>,
  chats?: readonly ChatSummary[],
  localChats: ReadonlySet<ChatId> = new Set(),
): readonly TreeRow[] {
  const rows: TreeRow[] = [];
  if (tree) {
    const files: TreeRowId = { kind: "files" };
    const filesExpanded = expanded.has(treeRowKey(files));
    rows.push({ id: files, key: treeRowKey(files), label: "Files", depth: 0, isDirectory: true, isExpanded: filesExpanded });
    if (filesExpanded) pushEntries(tree.entries, expanded, rows);
  }
  if (chats) {
    const group: TreeRowId = { kind: "chats" };
    const isExpanded = expanded.has(treeRowKey(group));
    rows.push({ id: group, key: treeRowKey(group), label: "Chats", depth: 0, isDirectory: true, isExpanded });
    if (isExpanded) {
      for (const chat of chats) {
        const id: TreeRowId = { kind: "chat", chatId: chat.id };
        rows.push({
          id,
          key: treeRowKey(id),
          label: chat.title,
          depth: 1,
          isDirectory: false,
          isExpanded: false,
          ...(localChats.has(chat.id) ? { local: true } : {}),
        });
      }
    }
  }
  return rows;
}

const indexOfRow = (rows: readonly TreeRow[], focused: TreeRowId | undefined): number =>
  focused === undefined ? -1 : rows.findIndex((row) => sameTreeRow(row.id, focused));

const focusAt = (rows: readonly TreeRow[], index: number): TreeIntent | undefined => {
  const row = rows[Math.max(0, Math.min(index, rows.length - 1))];
  return row ? { kind: "focus", id: row.id } : undefined;
};

function typeahead(rows: readonly TreeRow[], from: number, key: string): TreeIntent | undefined {
  const wanted = key.toLocaleLowerCase();
  for (let step = 1; step <= rows.length; step += 1) {
    const row = rows[(from + step + rows.length) % rows.length];
    if (row && row.label.toLocaleLowerCase().startsWith(wanted)) return { kind: "focus", id: row.id };
  }
  return undefined;
}

/** The whole keyboard contract as one pure function over the visible rows. */
export function treeKeyIntent(rows: readonly TreeRow[], focused: TreeRowId | undefined, key: string): TreeIntent | undefined {
  if (rows.length === 0) return undefined;
  const index = indexOfRow(rows, focused);
  const row = index === -1 ? undefined : rows[index];
  switch (key) {
    case "ArrowDown":
      return focusAt(rows, index + 1);
    case "ArrowUp":
      return index <= 0 ? focusAt(rows, 0) : focusAt(rows, index - 1);
    case "Home":
      return focusAt(rows, 0);
    case "End":
      return focusAt(rows, rows.length - 1);
    case "Enter":
      return row ? { kind: "activate", id: row.id } : undefined;
    case "ArrowRight": {
      if (!row?.isDirectory) return undefined;
      if (!row.isExpanded) return { kind: "toggle", id: row.id };
      const child = rows[index + 1];
      return child && child.depth > row.depth ? { kind: "focus", id: child.id } : undefined;
    }
    case "ArrowLeft": {
      if (!row) return undefined;
      if (row.isDirectory && row.isExpanded) return { kind: "toggle", id: row.id };
      for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
        const parent = rows[candidate];
        if (parent && parent.depth < row.depth) return { kind: "focus", id: parent.id };
      }
      return undefined;
    }
    default:
      return key.length === 1 && key.trim() ? typeahead(rows, index, key) : undefined;
  }
}
