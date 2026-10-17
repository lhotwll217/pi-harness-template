import { readUIMessageStream } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_TOKEN, localRequest, routeParams, startFakeGateway, type FakeGateway } from "@/test/fake-gateway";


const chats = await import("./chats/route");
const chat = await import("./chats/[id]/route");
const messages = await import("./chats/[id]/messages/route");
const cancel = await import("./chats/[id]/cancel/route");
const events = await import("./events/route");
const status = await import("./status/route");
const tree = await import("./workspace/tree/route");
const file = await import("./workspace/file/route");

const summary = { id: "c1", title: "say hi", createdAt: "2026-10-17T10:00:00.000Z", updatedAt: "2026-10-17T10:00:01.000Z", messageCount: 2, running: false };
const EVIL = "http://evil.example";

let gateway: FakeGateway;
beforeEach(async () => {
  gateway = await startFakeGateway();
  process.env.PI_TEMPLATE_HOME = gateway.home;
});
afterEach(async () => {
  delete process.env.PI_TEMPLATE_HOME;
  await gateway.close();
});

const send = (text: string, init: { origin?: string } = {}) => messages.POST(localRequest("/api/chats/c1/messages", {
  method: "POST",
  body: JSON.stringify({ messages: [{ id: "m1", role: "user", parts: [{ type: "text", text }] }] }),
  ...init,
}), routeParams("c1"));

async function streamParts(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text.split("\n\n").filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
    .map((frame) => JSON.parse(frame.slice("data: ".length)) as unknown);
}

describe("POST /api/chats/:id/messages", () => {
  it("re-encodes the Gateway's NDJSON reply as the UI message stream, sending only the newest text", async () => {
    gateway.reply = [
      { type: "turn.started", chatId: "c1", turnId: "t1" },
      { type: "text.delta", delta: "hi" },
      { type: "turn.finished", status: "completed" },
    ];

    const response = await send("say hi");

    expect(response.status).toBe(200);
    expect(await streamParts(response)).toEqual([
      { type: "start", messageId: "t1-assistant" },
      { type: "data-turn", id: "turn", data: { chatId: "c1", turnId: "t1" }, transient: true },
      { type: "text-start", id: "t1-assistant-text-0" },
      { type: "text-delta", id: "t1-assistant-text-0", delta: "hi" },
      { type: "text-end", id: "t1-assistant-text-0" },
      { type: "data-terminal", id: "terminal", data: { status: "completed" } },
      { type: "finish", finishReason: "stop" },
    ]);
    expect(gateway.requests.at(-1)).toEqual({ method: "POST", path: "/chats/c1/messages", authorization: `Bearer ${FAKE_TOKEN}`, body: { text: "say hi" } });
  });

  it("streams a tool call as a part that settles in place, and a cancelled turn as an abort", async () => {
    gateway.reply = [
      { type: "turn.started", chatId: "c1", turnId: "t2" },
      { type: "tool.started", callId: "call-1", name: "write", args: { path: "hello.md", content: "hi" } },
      { type: "tool.finished", callId: "call-1", isError: false },
      { type: "text.delta", delta: "Wrote it" },
      { type: "turn.finished", status: "cancelled" },
    ];

    const message = await lastMessage(await send("write hello.md"));

    expect(message.parts).toEqual([
      { type: "data-tool", id: "call-1", data: { callId: "call-1", tool: "write", status: "completed", summary: "hello.md" } },
      { type: "text", text: "Wrote it", state: "done" },
      { type: "data-terminal", id: "terminal", data: { status: "cancelled" } },
    ]);
  });

  it("passes a busy chat's refusal on with its status and message", async () => {
    gateway.refuseSend = { status: 409, error: "chat c1 is replying; cancel it or wait", code: "chat_busy" };

    const response = await send("again");

    expect(response.status).toBe(409);
    expect(await response.text()).toBe("chat c1 is replying; cancel it or wait");
  });

  it("refuses a non-local Origin before calling the Gateway", async () => {
    const response = await send("say hi", { origin: EVIL });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Cross-origin requests are not allowed.");
    expect(gateway.requests).toEqual([]);
  });

  it("says the daemon is not running when daemon.json is missing", async () => {
    process.env.PI_TEMPLATE_HOME = "/nonexistent/pi-template-home";

    const response = await send("say hi");

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("The pi-template daemon is not running.");
  });
});

async function lastMessage(response: Response) {
  let last: { parts: unknown[] } = { parts: [] };
  const parts = await streamParts(response);
  const stream: Parameters<typeof readUIMessageStream>[0]["stream"] = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part as never);
      controller.close();
    },
  });
  for await (const message of readUIMessageStream({ stream })) last = message;
  return last;
}

describe("chat list, history, rename, delete, cancel", () => {
  it("lists the Gateway's chats and shows a stored transcript as UI messages", async () => {
    gateway.chats = [summary];
    gateway.transcripts.set("c1", {
      ...summary,
      messages: [
        { role: "user", text: "say hi" },
        { role: "assistant", parts: [{ type: "text", text: "hi" }], status: "completed" },
      ],
    });

    expect(await (await chats.GET(localRequest("/api/chats"))).json()).toEqual([summary]);
    expect(await (await chat.GET(localRequest("/api/chats/c1"), routeParams("c1"))).json()).toEqual({
      chatId: "c1",
      running: false,
      messages: [
        { id: "c1-0", role: "user", metadata: {}, parts: [{ type: "text", text: "say hi" }] },
        { id: "c1-1", role: "assistant", metadata: {}, parts: [{ type: "text", text: "hi" }, { type: "data-terminal", data: { status: "completed" } }] },
      ],
    });
  });

  it("opens a chat id the Gateway has not stored yet as an empty chat", async () => {
    expect(await (await chat.GET(localRequest("/api/chats/new-id"), routeParams("new-id"))).json())
      .toEqual({ chatId: "new-id", messages: [], running: false });
  });

  it("renames and deletes through the Gateway", async () => {
    gateway.chats = [summary];

    const renamed = await chat.PATCH(localRequest("/api/chats/c1", { method: "PATCH", body: JSON.stringify({ title: " Greeting " }) }), routeParams("c1"));
    expect(await renamed.json()).toEqual({ ...summary, title: "Greeting" });

    const deleted = await chat.DELETE(localRequest("/api/chats/c1", { method: "DELETE" }), routeParams("c1"));
    expect(await deleted.json()).toEqual({ ok: true });
    expect(gateway.chats).toEqual([]);
  });

  it("cancels the named turn", async () => {
    const response = await cancel.POST(localRequest("/api/chats/c1/cancel", { method: "POST", body: JSON.stringify({ turnId: "t1" }) }), routeParams("c1"));

    expect(await response.json()).toEqual({ cancelled: true });
    expect(gateway.requests.at(-1)).toMatchObject({ method: "POST", path: "/chats/c1/cancel", body: { turnId: "t1" } });
  });

  it("refuses every mutation from a non-local Origin", async () => {
    const refused = await Promise.all([
      chat.PATCH(localRequest("/api/chats/c1", { method: "PATCH", body: "{}", origin: EVIL }), routeParams("c1")),
      chat.DELETE(localRequest("/api/chats/c1", { method: "DELETE", origin: EVIL }), routeParams("c1")),
      cancel.POST(localRequest("/api/chats/c1/cancel", { method: "POST", body: "{}", origin: EVIL }), routeParams("c1")),
      file.PUT(localRequest("/api/workspace/file?path=a.md", { method: "PUT", body: "{}", origin: EVIL })),
    ]);

    expect(refused.map((response) => response.status)).toEqual([403, 403, 403, 403]);
    expect(gateway.requests).toEqual([]);
  });

  it("never hands the Gateway token to the browser", async () => {
    gateway.chats = [summary];
    const bodies = await Promise.all([
      chats.GET(localRequest("/api/chats")),
      chat.GET(localRequest("/api/chats/c1"), routeParams("c1")),
      status.GET(localRequest("/api/status")),
      tree.GET(localRequest("/api/workspace/tree")),
    ].map(async (pending) => {
      const response = await pending;
      return `${JSON.stringify([...response.headers])}${await response.text()}`;
    }));

    for (const body of bodies) expect(body).not.toContain(FAKE_TOKEN);
  });
});

describe("GET /api/status", () => {
  it("reports ready, setup, and down", async () => {
    expect(await (await status.GET(localRequest("/api/status"))).json()).toEqual({ daemon: "ready" });

    gateway.ready = { ready: false, setupRequired: true };
    expect(await (await status.GET(localRequest("/api/status"))).json()).toEqual({ daemon: "setup" });

    process.env.PI_TEMPLATE_HOME = "/nonexistent/pi-template-home";
    const down = await status.GET(localRequest("/api/status"));
    expect(down.status).toBe(200);
    expect(await down.json()).toEqual({ daemon: "down" });
  });
});

describe("GET /api/events", () => {
  it("pipes the Gateway's invalidation frames", async () => {
    const response = await events.GET(localRequest("/api/events"));
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    expect((await reader.read()).value).toBe(":ready\n\n");

    gateway.publish({ kind: "workspace.changed" });

    expect((await reader.read()).value).toBe('data: {"kind":"workspace.changed"}\n\n');
    await reader.cancel();
  });

  it("answers an unreachable daemon with a daemon-down frame instead of an error status", async () => {
    process.env.PI_TEMPLATE_HOME = "/nonexistent/pi-template-home";

    const response = await events.GET(localRequest("/api/events"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe('retry: 2000\nevent: daemon\ndata: {"state":"down"}\n\n');
  });
});

describe("workspace files", () => {
  const hello = { path: "hello.md", content: "hi\n", revision: "sha256:1", modifiedAt: "2026-10-17T10:00:00.000Z" };

  it("passes the tree and a file through", async () => {
    gateway.tree = { entries: [{ path: "hello.md", kind: "file", size: 3, modifiedAt: hello.modifiedAt }], truncated: false };
    gateway.files.set("hello.md", hello);

    expect(await (await tree.GET(localRequest("/api/workspace/tree"))).json()).toEqual(gateway.tree);
    expect(await (await file.GET(localRequest("/api/workspace/file?path=hello.md"))).json()).toEqual(hello);
  });

  it("saves with the base revision, and answers a stale one with the file on disk", async () => {
    gateway.files.set("hello.md", hello);
    const save = (baseRevision: string) => file.PUT(localRequest("/api/workspace/file?path=hello.md", {
      method: "PUT",
      body: JSON.stringify({ content: "edited\n", baseRevision }),
    }));

    const written = await save("sha256:1");
    expect(written.status).toBe(200);
    expect(await written.json()).toMatchObject({ path: "hello.md", created: false });
    expect(gateway.files.get("hello.md")?.content).toBe("edited\n");

    const stale = await save("sha256:1");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: { message: "This file changed on disk." }, current: gateway.files.get("hello.md") });
  });

  it("refuses a save that is not JSON", async () => {
    const response = await file.PUT(localRequest("/api/workspace/file?path=a.md", {
      method: "PUT",
      body: "content",
      headers: { "content-type": "text/plain" },
    }));

    expect(response.status).toBe(415);
  });
});
