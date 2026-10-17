import { describe, expect, it } from "vitest";
import type { WorkspaceTree } from "./gateway-contracts";
import { flattenVisible, treeKeyIntent, treeRowKey } from "./workspace-tree";

const at = "2026-10-17T10:00:00.000Z";
const tree: WorkspaceTree = {
  truncated: false,
  entries: [
    { path: "notes", kind: "directory", size: 0, modifiedAt: at },
    { path: "notes/a.md", kind: "file", size: 1, modifiedAt: at },
    { path: "hello.md", kind: "file", size: 3, modifiedAt: at },
  ],
};
const chats = [{ id: "c1", title: "say hi", createdAt: at, updatedAt: at, messageCount: 2, running: false }];
const labels = (expanded: string[]) => flattenVisible(tree, new Set(expanded), chats).map((row) => `${row.depth}:${row.label}`);

describe("flattenVisible", () => {
  it("shows a file only when every folder above it is open", () => {
    expect(labels(["files", "chats"])).toEqual(["0:Files", "1:notes", "1:hello.md", "0:Chats", "1:say hi"]);
    expect(labels(["files", "chats", "entry:notes"])).toEqual(["0:Files", "1:notes", "2:a.md", "1:hello.md", "0:Chats", "1:say hi"]);
    expect(labels([])).toEqual(["0:Files", "0:Chats"]);
  });

  it("marks a chat minted on the page as local", () => {
    const rows = flattenVisible(undefined, new Set(["chats"]), chats, new Set(["c1"]));
    expect(rows.at(-1)).toMatchObject({ key: "chat:c1", local: true });
  });
});

describe("treeKeyIntent", () => {
  it("opens a folder, steps into it, and back out", () => {
    const expanded = new Set(["files", "chats"]);
    const rows = flattenVisible(tree, expanded, chats);
    const folder = { kind: "entry", path: "notes" } as const;
    expect(treeKeyIntent(rows, folder, "ArrowRight")).toEqual({ kind: "toggle", id: folder });

    const opened = flattenVisible(tree, new Set([...expanded, treeRowKey(folder)]), chats);
    expect(treeKeyIntent(opened, folder, "ArrowRight")).toEqual({ kind: "focus", id: { kind: "entry", path: "notes/a.md" } });
    expect(treeKeyIntent(opened, { kind: "entry", path: "notes/a.md" }, "ArrowLeft")).toEqual({ kind: "focus", id: folder });
    expect(treeKeyIntent(opened, { kind: "chat", chatId: "c1" }, "Enter")).toEqual({ kind: "activate", id: { kind: "chat", chatId: "c1" } });
  });
});
