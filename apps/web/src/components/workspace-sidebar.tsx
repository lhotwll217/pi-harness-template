"use client";

import {
  ChevronRightIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  MessagesSquareIcon,
  MoreHorizontalIcon,
  NotebookIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { ChatId, ChatSummary, WorkspaceTree } from "@/lib/gateway-contracts";
import {
  flattenVisible,
  sameTreeRow,
  treeKeyIntent,
  treeRowKey,
  type TreeRow,
  type TreeRowId,
} from "@/lib/workspace-tree";
import { cn } from "@/lib/utils";

/** The Gateway's bound on a chat title. */
const TITLE_LIMIT = 200;

export interface WorkspaceSidebarProps {
  readonly tree?: WorkspaceTree;
  readonly chats?: readonly ChatSummary[];
  /** Chats minted on this page and not stored yet: they cannot be renamed or deleted. */
  readonly localChats: ReadonlySet<ChatId>;
  readonly loading: boolean;
  readonly errorMessage?: string;
  readonly activeKey: string;
  readonly expanded: ReadonlySet<string>;
  readonly focused?: TreeRowId;
  readonly onFocusRow: (id: TreeRowId) => void;
  /** Expands or collapses the Chats group, the Files group, or a folder. */
  readonly onToggle: (id: TreeRowId) => void;
  readonly onActivateRow: (id: TreeRowId) => void;
  readonly onNewChat: () => void;
  readonly onNewFile: () => void;
  readonly onRenameChat: (id: ChatId, title: string) => void;
  readonly onDeleteChat: (id: ChatId) => void;
}

export function WorkspaceSidebar({
  tree,
  chats,
  localChats,
  loading,
  errorMessage,
  activeKey,
  expanded,
  focused,
  onFocusRow,
  onToggle,
  onActivateRow,
  onNewChat,
  onNewFile,
  onRenameChat,
  onDeleteChat,
}: WorkspaceSidebarProps) {
  const [chatRenaming, setChatRenaming] = useState<{ readonly id: ChatId; readonly was: string; readonly title: string }>();
  const [chatDeleting, setChatDeleting] = useState<{ readonly id: ChatId; readonly title: string }>();
  const rowsRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => flattenVisible(tree, expanded, chats, localChats), [chats, expanded, localChats, tree]);
  const cursor = focused ?? rows[0]?.id;

  // The roving tabindex owns focus: move the DOM focus whenever the cursor moves inside the tree.
  useEffect(() => {
    if (!cursor || !rowsRef.current?.contains(document.activeElement)) return;
    rowsRef.current.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(treeRowKey(cursor))}"]`)?.focus();
  }, [cursor]);

  const commitChatRename = useCallback(() => {
    const active = chatRenaming;
    setChatRenaming(undefined);
    if (active) onRenameChat(active.id, active.title.trim());
  }, [chatRenaming, onRenameChat]);

  const chatRenameReady = chatRenaming !== undefined
    && chatRenaming.title.trim() !== ""
    && chatRenaming.title.trim() !== chatRenaming.was;

  const activateRow = useCallback((row: TreeRow) => {
    if (row.isDirectory) onToggle(row.id);
    else onActivateRow(row.id);
  }, [onActivateRow, onToggle]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return;
    const intent = treeKeyIntent(rows, cursor, event.key);
    if (!intent) return;
    event.preventDefault();
    if (intent.kind === "focus") onFocusRow(intent.id);
    else if (intent.kind === "toggle") onToggle(intent.id);
    else {
      const row = rows.find((candidate) => sameTreeRow(candidate.id, intent.id));
      if (row) activateRow(row);
    }
  }, [activateRow, cursor, onFocusRow, onToggle, rows]);

  const filesExpanded = expanded.has(treeRowKey({ kind: "files" }));
  const filesEmpty = tree !== undefined && tree.entries.length === 0 && filesExpanded;
  const filesActions = (
    <Button aria-label="New file" className="shrink-0" onClick={onNewFile} size="icon-xs" tabIndex={-1} variant="ghost"><FilePlusIcon /></Button>
  );
  const chatsActions = (
    <Button aria-label="New chat" className="shrink-0" onClick={onNewChat} size="icon-xs" tabIndex={-1} variant="ghost">
      <MessageSquarePlusIcon />
    </Button>
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div aria-label="Workspace" className="flex flex-col gap-0.5" onKeyDown={onKeyDown} ref={rowsRef} role="tree">
          {rows.map((row) => (
            <SidebarRow
              activeKey={activeKey}
              cursorKey={cursor ? treeRowKey(cursor) : undefined}
              key={row.key}
              onActivate={() => activateRow(row)}
              onChatDelete={(id) => setChatDeleting({ id, title: row.label })}
              onChatRename={(id) => setChatRenaming({ id, was: row.label, title: row.label })}
              onFocusRow={onFocusRow}
              onToggle={onToggle}
              row={row}
              trailing={row.id.kind === "files" ? filesActions : row.id.kind === "chats" ? chatsActions : undefined}
            />
          ))}
        </div>

        {loading && !tree && <p className="px-2 py-3 text-xs text-muted-foreground">Reading the files folder…</p>}
        {errorMessage && <p className="px-2 py-3 text-xs text-destructive" role="alert">{errorMessage}</p>}
        {filesEmpty && <p className="py-1 pl-10 text-xs text-muted-foreground">No files yet.</p>}
        {tree?.truncated && filesExpanded && <p className="py-1 pl-10 text-xs text-muted-foreground">Only the first files are listed.</p>}
      </div>

      <Dialog onOpenChange={(open) => { if (!open) setChatRenaming(undefined); }} open={chatRenaming !== undefined}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
            <DialogDescription>Give this chat a name of your own.</DialogDescription>
          </DialogHeader>
          {/* A real form, so Enter submits the way it does in every other name field. */}
          <form onSubmit={(event) => { event.preventDefault(); if (chatRenameReady) commitChatRename(); }}>
            <Input
              aria-label="Chat name"
              autoFocus
              maxLength={TITLE_LIMIT}
              onChange={(event) => setChatRenaming((current) => (current ? { ...current, title: event.target.value } : current))}
              value={chatRenaming?.title ?? ""}
            />
            <DialogFooter className="mt-4">
              <Button onClick={() => setChatRenaming(undefined)} type="button" variant="outline">Cancel</Button>
              <Button disabled={!chatRenameReady} type="submit">Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog onOpenChange={(open) => { if (!open) setChatDeleting(undefined); }} open={chatDeleting !== undefined}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {chatDeleting?.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              It leaves the sidebar, but the transcript is archived rather than erased, so it can be recovered.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { const active = chatDeleting; setChatDeleting(undefined); if (active) onDeleteChat(active.id); }}
              variant="destructive"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface SidebarRowProps {
  readonly row: TreeRow;
  readonly activeKey: string;
  readonly cursorKey?: string;
  /** Section actions rendered after the label, always visible. */
  readonly trailing?: ReactNode;
  readonly onActivate: () => void;
  readonly onFocusRow: (id: TreeRowId) => void;
  readonly onToggle: (id: TreeRowId) => void;
  readonly onChatRename: (id: ChatId) => void;
  readonly onChatDelete: (id: ChatId) => void;
}

function rowIcon(row: TreeRow): ReactNode {
  switch (row.id.kind) {
    case "chats": return <MessagesSquareIcon className="size-3.5 shrink-0" />;
    case "files": return <NotebookIcon className="size-3.5 shrink-0" />;
    case "chat": return <MessageSquareIcon className="size-3.5 shrink-0" />;
    case "entry":
      if (!row.isDirectory) return <FileTextIcon className="size-3.5 shrink-0" />;
      return row.isExpanded ? <FolderOpenIcon className="size-3.5 shrink-0" /> : <FolderIcon className="size-3.5 shrink-0" />;
  }
}

function SidebarRow({ row, activeKey, cursorKey, trailing, onActivate, onFocusRow, onToggle, onChatRename, onChatDelete }: SidebarRowProps) {
  const chatId = row.id.kind === "chat" && !row.local ? row.id.chatId : undefined;
  return (
    <div
      aria-expanded={row.isDirectory ? row.isExpanded : undefined}
      aria-level={row.depth + 1}
      aria-selected={row.key === activeKey}
      className={cn(
        "group flex items-center gap-1 rounded-lg pr-1 text-sm",
        row.key === activeKey ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
      )}
      role="treeitem"
      style={{ paddingLeft: `${row.depth * 12}px` }}
    >
      {row.isDirectory ? (
        <button
          aria-label={row.isExpanded ? `Collapse ${row.label}` : `Expand ${row.label}`}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          onClick={() => onToggle(row.id)}
          tabIndex={-1}
          type="button"
        >
          <ChevronRightIcon className={cn("size-3.5 transition-transform", row.isExpanded && "rotate-90")} />
        </button>
      ) : <span className="size-5 shrink-0" />}

      <button
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        data-row-key={row.key}
        onClick={() => { onFocusRow(row.id); onActivate(); }}
        onFocus={() => onFocusRow(row.id)}
        tabIndex={cursorKey === row.key ? 0 : -1}
        type="button"
      >
        {rowIcon(row)}
        <span className="truncate">{row.label}</span>
      </button>

      {trailing}
      {chatId && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* Opacity rather than `hidden` keeps the trigger in the tab order while it is unrevealed. */}
            <Button
              aria-label={`Actions for ${row.label}`}
              className={cn(
                "shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                row.key === activeKey && "opacity-100",
              )}
              size="icon-xs"
              variant="ghost"
            >
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onChatRename(chatId)}>Rename</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onChatDelete(chatId)} variant="destructive">Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
