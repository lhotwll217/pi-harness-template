// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { appFetch, StubEventSource, StubResizeObserver, type AppCall } from "@/test/app-fetch";
import { startFakeGateway, type FakeGateway } from "@/test/fake-gateway";


const { WorkspaceShell, DAEMON_DOWN_MESSAGE } = await import("./workspace-shell");

const at = (minute: number) => `2026-10-17T10:${String(minute).padStart(2, "0")}:00.000Z`;
const summary = (id: string, title: string, minute: number) =>
  ({ id, title, createdAt: at(minute), updatedAt: at(minute), messageCount: 2, running: false });

const realFetch = globalThis.fetch;
let gateway: FakeGateway;
let calls: AppCall[];

beforeEach(async () => {
  gateway = await startFakeGateway();
  process.env.PI_TEMPLATE_HOME = gateway.home;
  gateway.chats = [summary("c2", "Lunch plans", 2), summary("c1", "Warm-up", 1)];
  gateway.transcripts.set("c2", { ...gateway.chats[0]!, messages: [
    { role: "user", text: "where to eat?" },
    { role: "assistant", parts: [{ type: "text", text: "Try the noodle bar." }], status: "completed" },
  ] });
  gateway.transcripts.set("c1", { ...gateway.chats[1]!, messages: [
    { role: "user", text: "hello" },
    { role: "assistant", parts: [{ type: "text", text: "Hello there." }], status: "completed" },
  ] });
  calls = [];
  StubEventSource.instances = [];
  vi.stubGlobal("EventSource", StubEventSource);
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  vi.stubGlobal("scrollTo", () => undefined);
  vi.stubGlobal("fetch", appFetch(realFetch, calls));
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  delete process.env.PI_TEMPLATE_HOME;
  await gateway.close();
});

const renderShell = () => render(<TooltipProvider><WorkspaceShell /></TooltipProvider>);
const events = () => StubEventSource.instances[0]!;
const thread = () => document.querySelector<HTMLElement>('[data-slot="chat-pane"]')!;
const chatLoads = (id: string) => calls.filter((call) => call.method === "GET" && call.url === `/api/chats/${id}`).length;
const chatLabels = () => screen.getAllByRole("treeitem").map((item) => item.textContent);

describe("WorkspaceShell chats", () => {
  it("opens the newest chat and switches threads from the list", async () => {
    const user = userEvent.setup();
    renderShell();

    expect(await within(thread()).findByText("Try the noodle bar.")).toBeDefined();
    expect(chatLabels()).toEqual(["Files", "Chats", "Lunch plans", "Warm-up"]);
    expect(screen.getByRole("treeitem", { name: /Lunch plans/ }).getAttribute("aria-selected")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Warm-up" }));

    expect(await within(thread()).findByText("Hello there.")).toBeDefined();
    expect(within(thread()).queryByText("Try the noodle bar.")).toBeNull();
    expect(screen.getByRole("treeitem", { name: /Warm-up/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("renames and deletes a chat in place, without reloading the page", async () => {
    const user = userEvent.setup();
    renderShell();
    await within(thread()).findByText("Try the noodle bar.");
    const rail = document.querySelector('[data-slot="workspace-rail"]');

    await user.click(screen.getByRole("button", { name: "Actions for Warm-up" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const name = await screen.findByRole("textbox", { name: "Chat name" });
    await user.clear(name);
    await user.type(name, "Greeting{Enter}");
    await waitFor(() => expect(chatLabels()).toEqual(["Files", "Chats", "Lunch plans", "Greeting"]));

    await user.click(screen.getByRole("button", { name: "Actions for Lunch plans" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(chatLabels()).toEqual(["Files", "Chats", "Greeting"]));
    // Deleting the open chat opens the newest one left.
    expect(await within(thread()).findByText("Hello there.")).toBeDefined();
    expect(document.querySelector('[data-slot="workspace-rail"]')).toBe(rail);
    expect(calls.filter((call) => call.method !== "GET")).toEqual([
      { method: "PATCH", url: "/api/chats/c1", body: { title: "Greeting" } },
      { method: "DELETE", url: "/api/chats/c2" },
    ]);
  });

  it("starts a new chat that is listed before the Gateway stores it", async () => {
    const user = userEvent.setup();
    renderShell();
    await within(thread()).findByText("Try the noodle bar.");

    await user.click(screen.getByRole("button", { name: "New chat" }));

    expect(await within(thread()).findByText("Start a conversation.")).toBeDefined();
    expect(chatLabels()).toEqual(["Files", "Chats", "New chat", "Lunch plans", "Warm-up"]);
    expect(screen.queryByRole("button", { name: "Actions for New chat" })).toBeNull();
  });

  it("sends a message and streams the reply into the thread", async () => {
    const user = userEvent.setup();
    gateway.reply = [
      { type: "turn.started", chatId: "c2", turnId: "t9" },
      { type: "text.delta", delta: "h" },
      { type: "text.delta", delta: "i" },
      { type: "turn.finished", status: "completed" },
    ];
    renderShell();
    await within(thread()).findByText("Try the noodle bar.");

    await user.type(screen.getByRole("textbox", { name: "Message the agent" }), "say hi{Enter}");

    expect(await within(thread()).findByText("hi")).toBeDefined();
    expect(gateway.requests.find((request) => request.method === "POST")).toMatchObject({ path: "/chats/c2/messages", body: { text: "say hi" } });
  });

  it("reloads the open chat when the Gateway says it changed, and only that chat", async () => {
    renderShell();
    await within(thread()).findByText("Try the noodle bar.");
    const before = chatLoads("c2");
    gateway.transcripts.set("c2", { ...gateway.chats[0]!, messages: [
      ...gateway.transcripts.get("c2")!.messages,
      { role: "user", text: "sent from the CLI" },
      { role: "assistant", parts: [{ type: "text", text: "Answered from the CLI." }], status: "completed" },
    ] });

    events().emit({ kind: "chat.changed", chatId: "c1" });
    await waitFor(() => expect(calls.filter((call) => call.url === "/api/chats").length).toBeGreaterThan(1));
    expect(chatLoads("c2")).toBe(before);

    events().emit({ kind: "chat.changed", chatId: "c2" });
    expect(await within(thread()).findByText("Answered from the CLI.")).toBeDefined();
    expect(within(thread()).getByText("sent from the CLI")).toBeDefined();
  });

  it("shows a reply another client is running and keeps the composer closed until it ends", async () => {
    gateway.chats = [{ ...summary("c2", "Lunch plans", 2), running: true }];
    gateway.transcripts.set("c2", { ...gateway.chats[0]!, turnId: "t5", messages: [{ role: "user", text: "from the CLI" }] });
    renderShell();

    const composer = await screen.findByRole("textbox", { name: "Message the agent" });
    await waitFor(() => expect((composer as HTMLTextAreaElement).disabled).toBe(true));
    expect(within(thread()).getByText("A reply is running in this chat.")).toBeDefined();
    expect(within(thread()).getByText("from the CLI")).toBeDefined();
  });
});

describe("WorkspaceShell files", () => {
  it("shows a file the agent wrote when the Gateway reports a workspace change", async () => {
    renderShell();
    await screen.findByText("No files yet.");

    gateway.tree = { entries: [{ path: "hello.md", kind: "file", size: 3, modifiedAt: at(3) }], truncated: false };
    events().emit({ kind: "workspace.changed" });

    expect(await screen.findByRole("treeitem", { name: /hello\.md/ })).toBeDefined();
  });

  it("creates Untitled.md from the Files section and opens it", async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByText("No files yet.");

    await user.click(screen.getByRole("button", { name: "New file" }));

    expect(await screen.findByRole("region", { name: "File editor" })).toBeDefined();
    expect(gateway.files.get("Untitled.md")?.content).toBe("");
    expect(await screen.findByRole("treeitem", { name: /Untitled\.md/ })).toBeDefined();
  });
});

describe("WorkspaceShell daemon state", () => {
  it("tells the owner when the harness is unreachable, and clears it when the daemon is back", async () => {
    renderShell();
    await screen.findByText("Daemon ready");

    events().emitNamed("daemon");
    expect((await screen.findByRole("alert")).textContent).toBe(DAEMON_DOWN_MESSAGE);
    expect(screen.getByText("Daemon offline")).toBeDefined();

    events().onopen?.();
    events().onopen?.();
    await waitFor(() => expect(document.querySelector('[data-slot="daemon-banner"]')).toBeNull());
  });

  it("shows the banner when the event stream drops", async () => {
    renderShell();
    await screen.findByText("Daemon ready");

    events().onerror?.();

    expect((await screen.findByRole("alert")).textContent).toBe(DAEMON_DOWN_MESSAGE);
  });
});
