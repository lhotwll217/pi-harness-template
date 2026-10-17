"use client";

import { PanelLeftCloseIcon, PanelLeftOpenIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatApp } from "@/components/chat-app";
import { FileEditor } from "@/components/file-editor";
import { GatewayEventsContext, type PageEvent } from "@/components/gateway-events";
import { ThemeButton } from "@/components/theme-button";
import { WorkspaceSidebar } from "@/components/workspace-sidebar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { deleteChat, fetchChats, renameChat } from "@/lib/chat-client";
import type { AppStatus, DaemonState } from "@/lib/chat-types";
import type { ChatId, ChatSummary, GatewayEvent, WorkspaceTree } from "@/lib/gateway-contracts";
import { cn } from "@/lib/utils";
import { fetchWorkspaceTree, writeWorkspaceFile } from "@/lib/workspace-client";
import { nextAvailableName, pathName } from "@/lib/workspace-paths";
import { treeRowKey, type TreeRowId } from "@/lib/workspace-tree";

export type MainPane = { readonly kind: "chat" } | { readonly kind: "file"; readonly path: string };

const SIDEBAR_PREFERENCE_KEY = "pi-template.workspace.sidebar";
const OPEN_ON_LOAD: readonly TreeRowId[] = [{ kind: "files" }, { kind: "chats" }];
const NEW_CHAT_TITLE = "New chat";

const BANNERS = {
  down: { text: "The harness is unreachable. Start it with", command: "./pi-template status" },
  setup: { text: "Setup is incomplete. Run", command: "./pi-template onboard" },
} as const;

export const DAEMON_DOWN_MESSAGE = `${BANNERS.down.text} ${BANNERS.down.command}.`;

function readSidebarPreference(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_PREFERENCE_KEY) !== "collapsed";
  } catch {
    return true;
  }
}

function localChat(id: ChatId): ChatSummary {
  const now = new Date().toISOString();
  return { id, title: NEW_CHAT_TITLE, createdAt: now, updatedAt: now, messageCount: 0, running: false };
}

function parseGatewayEvent(data: string): GatewayEvent | undefined {
  try {
    const event = JSON.parse(data) as { kind?: unknown };
    return typeof event.kind === "string" ? event as GatewayEvent : undefined;
  } catch {
    return undefined;
  }
}

export function WorkspaceShell() {
  const [daemon, setDaemon] = useState<DaemonState>();
  const [tree, setTree] = useState<WorkspaceTree>();
  const [stored, setStored] = useState<readonly ChatSummary[]>();
  const [unstoredChats, setUnstoredChats] = useState<readonly ChatSummary[]>([]);
  const [openChatId, setOpenChatId] = useState<ChatId>();
  const [treeError, setTreeError] = useState<string>();
  const [chatsError, setChatsError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [pane, setPane] = useState<MainPane>({ kind: "chat" });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(OPEN_ON_LOAD.map(treeRowKey)));
  const [focused, setFocused] = useState<TreeRowId>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [invalidationToken, setInvalidationToken] = useState(0);
  const listeners = useRef(new Set<(event: PageEvent) => void>());

  const subscribe = useCallback((listener: (event: PageEvent) => void) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);
  const publish = useCallback((event: PageEvent) => {
    for (const listener of listeners.current) listener(event);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setRailOpen(readSidebarPreference()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const refreshDaemon = useCallback(async () => {
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      if (!response.ok) throw new Error("status unavailable");
      setDaemon((await response.json() as AppStatus).daemon);
    } catch {
      setDaemon("down");
    }
  }, []);

  const refreshTree = useCallback(async () => {
    try {
      setTree(await fetchWorkspaceTree());
      setTreeError(undefined);
    } catch (error: unknown) {
      setTreeError(error instanceof Error ? error.message : "The app could not read the files.");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshChats = useCallback(async () => {
    try {
      const next = await fetchChats();
      setStored(next);
      setUnstoredChats((current) => current.filter((chat) => !next.some((candidate) => candidate.id === chat.id)));
      setChatsError(undefined);
    } catch (error: unknown) {
      setChatsError(error instanceof Error ? error.message : "The app could not list the chats.");
    }
  }, []);

  const resync = useCallback(() => {
    void refreshDaemon();
    void refreshTree();
    void refreshChats();
    setInvalidationToken((token) => token + 1);
    publish({ kind: "resync" });
  }, [publish, refreshChats, refreshDaemon, refreshTree]);

  const resyncRef = useRef(resync);
  useEffect(() => { resyncRef.current = resync; }, [resync]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshTree(); void refreshChats(); void refreshDaemon(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshChats, refreshTree, refreshDaemon]);

  const handlers = useRef({ refreshChats, refreshTree, refreshDaemon, publish });
  useEffect(() => { handlers.current = { refreshChats, refreshTree, refreshDaemon, publish }; }, [publish, refreshChats, refreshDaemon, refreshTree]);

  useEffect(() => {
    let opened = false;
    const source = new EventSource("/api/events");
    source.onopen = () => {
      if (opened) resyncRef.current();
      else void handlers.current.refreshDaemon();
      opened = true;
    };
    source.onerror = () => setDaemon("down");
    source.addEventListener("daemon", () => setDaemon("down"));
    source.onmessage = (message: MessageEvent<string>) => {
      const event = parseGatewayEvent(message.data);
      if (!event) return;
      if (event.kind === "chat.changed") void handlers.current.refreshChats();
      if (event.kind === "workspace.changed" || event.kind === "schedule-run.changed") {
        void handlers.current.refreshTree();
        setInvalidationToken((token) => token + 1);
      }
      handlers.current.publish(event);
    };
    const onFocus = () => resyncRef.current();
    const onVisible = () => { if (document.visibilityState === "visible") resyncRef.current(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      source.close();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const chats = useMemo(
    () => (stored ? [...unstoredChats.filter((chat) => !stored.some((candidate) => candidate.id === chat.id)), ...stored] : undefined),
    [unstoredChats, stored],
  );

  const openPane = useCallback((next: MainPane) => {
    setPane(next);
    setDrawerOpen(false);
  }, []);

  const startChat = useCallback(() => {
    const id = crypto.randomUUID();
    setUnstoredChats((current) => [localChat(id), ...current]);
    setOpenChatId(id);
    setFocused({ kind: "chat", chatId: id });
    openPane({ kind: "chat" });
  }, [openPane]);

  useEffect(() => {
    if (openChatId || !stored) return;
    const timer = window.setTimeout(() => {
      if (stored[0]) setOpenChatId(stored[0].id);
      else startChat();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [openChatId, startChat, stored]);

  const switchChat = useCallback((id: ChatId) => {
    setOpenChatId(id);
    openPane({ kind: "chat" });
  }, [openPane]);

  const renameChatTitle = useCallback(async (id: ChatId, title: string) => {
    try {
      const renamed = await renameChat(id, title);
      setStored((current) => current?.map((chat) => (chat.id === id ? renamed : chat)));
      setChatsError(undefined);
    } catch (error: unknown) {
      setChatsError(error instanceof Error ? error.message : "The app could not rename that chat.");
    }
  }, []);

  const removeChat = useCallback(async (id: ChatId) => {
    try {
      await deleteChat(id);
      setChatsError(undefined);
    } catch (error: unknown) {
      setChatsError(error instanceof Error ? error.message : "The app could not delete that chat.");
      return;
    }
    const remaining = (stored ?? []).filter((chat) => chat.id !== id);
    setStored(remaining);
    if (id !== openChatId) return;
    const next = unstoredChats[0] ?? remaining[0];
    if (next) switchChat(next.id);
    else startChat();
  }, [unstoredChats, openChatId, startChat, stored, switchChat]);

  const createFile = useCallback(async () => {
    const taken = (tree?.entries ?? []).filter((entry) => !entry.path.includes("/")).map((entry) => entry.path);
    const path = nextAvailableName(taken, "Untitled", ".md");
    try {
      await writeWorkspaceFile(path, "");
      setTreeError(undefined);
    } catch (error: unknown) {
      setTreeError(error instanceof Error ? error.message : "The app could not create that file.");
      return;
    }
    await refreshTree();
    openPane({ kind: "file", path });
    setFocused({ kind: "entry", path });
  }, [openPane, refreshTree, tree]);

  const activateRow = useCallback((id: TreeRowId) => {
    if (id.kind === "chats" || id.kind === "files") return;
    setFocused(id);
    if (id.kind === "chat") {
      switchChat(id.chatId);
      return;
    }
    const entry = tree?.entries.find((candidate) => candidate.path === id.path);
    if (entry?.kind === "file") openPane({ kind: "file", path: id.path });
  }, [openPane, switchChat, tree]);

  const toggleRow = useCallback((id: TreeRowId) => {
    const key = treeRowKey(id);
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const toggleRail = useCallback(() => {
    setRailOpen((open) => {
      try { window.localStorage.setItem(SIDEBAR_PREFERENCE_KEY, open ? "collapsed" : "open"); } catch { /* a private window is not a failure */ }
      return !open;
    });
  }, []);

  const activeKey = pane.kind === "chat"
    ? (openChatId ? treeRowKey({ kind: "chat", chatId: openChatId }) : "")
    : treeRowKey({ kind: "entry", path: pane.path });

  const siblingNames = useMemo(() => {
    if (pane.kind !== "file" || !tree) return [];
    const parent = pane.path.includes("/") ? pane.path.slice(0, pane.path.lastIndexOf("/") + 1) : "";
    return tree.entries
      .filter((entry) => entry.path.startsWith(parent) && !entry.path.slice(parent.length).includes("/"))
      .map((entry) => pathName(entry.path));
  }, [pane, tree]);

  const localIds = useMemo(() => new Set(unstoredChats.map((chat) => chat.id)), [unstoredChats]);
  const openChat = chats?.find((chat) => chat.id === openChatId);

  const sidebar = (
    <WorkspaceSidebar
      activeKey={activeKey}
      chats={chats}
      errorMessage={[treeError, chatsError].filter(Boolean).join(" ") || undefined}
      expanded={expanded}
      focused={focused}
      loading={loading}
      localChats={localIds}
      onActivateRow={activateRow}
      onDeleteChat={(id) => { void removeChat(id); }}
      onFocusRow={setFocused}
      onNewChat={startChat}
      onNewFile={() => { void createFile(); }}
      onRenameChat={(id, title) => { void renameChatTitle(id, title); }}
      onToggle={toggleRow}
      tree={tree}
    />
  );

  const chatOpen = pane.kind === "chat";
  const banner = daemon === "down" || daemon === "setup" ? BANNERS[daemon] : undefined;
  return (
    <GatewayEventsContext.Provider value={subscribe}>
      <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-background text-foreground">
        <aside
          className={cn(
            "hidden shrink-0 md:flex",
            railOpen ? "w-[260px] border-r border-sidebar-border" : "w-0 overflow-hidden",
          )}
          data-slot="workspace-rail"
        >
          {railOpen && sidebar}
        </aside>

        <Sheet onOpenChange={setDrawerOpen} open={drawerOpen}>
          <SheetContent aria-describedby={undefined} className="p-0">
            <SheetTitle className="sr-only">Workspace</SheetTitle>
            {sidebar}
          </SheetContent>
        </Sheet>

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="z-30 flex h-12 shrink-0 items-center justify-between border-b bg-background px-2" data-slot="shell-controls">
            <div className="flex items-center gap-1">
              <Button aria-label="Open workspace" className="md:hidden" onClick={() => setDrawerOpen(true)} size="icon-sm" variant="ghost">
                <PanelLeftOpenIcon />
              </Button>
              <Button
                aria-label={railOpen ? "Collapse workspace" : "Expand workspace"}
                className="hidden md:inline-flex"
                onClick={toggleRail}
                size="icon-sm"
                variant="ghost"
              >
                {railOpen ? <PanelLeftCloseIcon /> : <PanelLeftOpenIcon />}
              </Button>
            </div>
            <div className="flex items-center gap-1">
              <span className="mr-1 inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] text-muted-foreground" data-slot="daemon-status">
                <span className={cn("size-1.5 rounded-full", daemon === "ready" ? "bg-emerald-500" : "bg-amber-500")} />
                {daemon === "ready" ? "Daemon ready" : daemon === "setup" ? "Setup needed" : daemon === "down" ? "Daemon offline" : "Checking daemon"}
              </span>
              <ThemeButton />
            </div>
          </header>

          {banner && (
            <div className="flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-4 py-2 text-sm" data-slot="daemon-banner" role="alert">
              <TriangleAlertIcon aria-hidden className="size-4 shrink-0 text-amber-600 dark:text-amber-500" />
              <span>{banner.text} <code className="rounded bg-muted px-1 font-mono text-xs">{banner.command}</code>.</span>
            </div>
          )}

          <div className="relative min-h-0 flex-1">
            {/* The chat never unmounts on a file switch: `visibility: hidden` keeps its scroll box,
                and therefore its scroll position, exactly where the owner left it. */}
            <div
              className="absolute inset-0 flex min-h-0 flex-col"
              data-slot="chat-pane"
              inert={!chatOpen}
              style={{ visibility: chatOpen ? "visible" : "hidden" }}
            >
              {openChatId && <ChatApp chatId={openChatId} key={openChatId} title={openChat?.title ?? NEW_CHAT_TITLE} />}
            </div>

            {pane.kind === "file" && (
              <div className="absolute inset-0 z-10 flex min-h-0 flex-col" data-slot="file-pane">
                <FileEditor
                  invalidationToken={invalidationToken}
                  key={pane.path}
                  onBackToChat={() => openPane({ kind: "chat" })}
                  onFileCreated={() => { void refreshTree(); }}
                  path={pane.path}
                  siblingNames={siblingNames}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </GatewayEventsContext.Provider>
  );
}
