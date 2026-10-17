// Chats and workspace files through the real daemon and Gateway, with Pi's faux provider as the
// model: streamed replies, list/rename/delete, cancel, one writer per chat, live events, the
// session start checks on every turn, and shutdown mid-turn.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  GatewayEventKind,
  ONBOARDING_VERSION,
  ensureHarnessWorkspace,
  harnessPaths,
  saveHarnessSettings,
  savePermissionMode,
  type ChatStreamEvent,
  type DaemonInfo,
  type GatewayEvent,
} from "@pi-template/contracts";
import { seedFauxProviderHome } from "../../test/helpers/faux-provider";
import { acknowledgeAgentDefinition } from "../../test/helpers/onboarding";
import { startDaemon } from "./lifecycle";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-chats-")));
const home = join(root, "home");
const previousHome = process.env.PI_TEMPLATE_HOME;
process.env.PI_TEMPLATE_HOME = home;
const faux = registerFauxProvider({ tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } });
const paths = ensureHarnessWorkspace(home);
seedFauxProviderHome(paths, faux.getModel());
acknowledgeAgentDefinition(paths);
saveHarnessSettings(home, { alwaysOn: "declined" });
writeFileSync(paths.sandboxPolicy, JSON.stringify({ enabled: false, filesystem: { allowedReadRoots: [], allowedWriteRoots: [], deniedReadRoots: [] },
  process: { allowSubprocesses: true }, network: { mode: "deny", allowedDomains: [] } }));
writeFileSync(paths.onboardingMarker, JSON.stringify({ version: ONBOARDING_VERSION, completedAt: "2026-10-17T00:00:00.000Z" }));

let daemon = await startDaemon({ port: 0, fingerprintIntervalMs: 60_000, scheduler: { wakeIntervalMs: 60_000 } });
const info = (): DaemonInfo => JSON.parse(readFileSync(paths.daemonInfo, "utf8")) as DaemonInfo;
const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${info().authToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
};

/** Send a chat message; `onLine` sees each NDJSON line as it arrives. */
async function send(chatId: string, text: string, onLine?: (event: ChatStreamEvent) => void | Promise<void>) {
  const response = await fetch(`http://127.0.0.1:${daemon.port}/chats/${chatId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${info().authToken}`, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (response.status !== 200) return { status: response.status, body: await response.json() as any, events: [] as ChatStreamEvent[] };
  assert.equal(response.headers.get("content-type"), "application/x-ndjson");
  const events: ChatStreamEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
      const event = JSON.parse(buffer.slice(0, newline)) as ChatStreamEvent;
      buffer = buffer.slice(newline + 1);
      events.push(event);
      await onLine?.(event);
    }
  }
  return { status: 200, body: undefined, events };
}

const heard: GatewayEvent[] = [];
const events = new AbortController();
async function listen(): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${daemon.port}/events`, {
    headers: { authorization: `Bearer ${info().authToken}` }, signal: events.signal,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith("data: ")) heard.push(JSON.parse(frame.slice(6)) as GatewayEvent);
      }
    }
  } catch {
    // Aborted at the end of the test.
  }
}

/** Every event heard after `from`, up to the `notes.changed` a note added now produces; the bus delivers in order. */
async function eventsUntilNote(from: number): Promise<GatewayEvent[]> {
  assert.equal((await call("POST", "/notes", { body: "marker" })).status, 201);
  for (let waited = 0; !heard.slice(from).some((event) => event.kind === GatewayEventKind.NotesChanged); waited += 10) {
    if (waited > 5_000) throw new Error("notes.changed never arrived");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const slice = heard.slice(from);
  return slice.slice(0, slice.findIndex((event) => event.kind === GatewayEventKind.NotesChanged));
}

const types = (stream: ChatStreamEvent[]) => stream.map((event) => event.type);
const text = (stream: ChatStreamEvent[]) => stream.flatMap((event) => event.type === "text.delta" ? [event.delta] : []).join("");
const chatFiles = () => readdirSync(paths.chatTranscripts).sort();
const LONG_REPLY = "word ".repeat(400).trim();

try {
  void listen();
  while (heard.length === 0 && (await call("POST", "/notes", { body: "warm-up" })).status === 201) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  // AC1, lane 2: a message over the Gateway streams the reply back.
  let mark = heard.length;
  faux.setResponses([fauxAssistantMessage("hi")]);
  const hi = await send("c1", "say hi");
  assert.equal(hi.status, 200);
  assert.deepEqual(types(hi.events), ["turn.started", "text.delta", "turn.finished"]);
  assert.deepEqual(hi.events.map((event) => event.seq), [0, 1, 2]);
  assert.equal(text(hi.events), "hi");
  const started = hi.events[0] as Extract<ChatStreamEvent, { type: "turn.started" }>;
  assert.equal(started.chatId, "c1");
  assert.deepEqual(hi.events.at(-1), { seq: 2, type: "turn.finished", status: "completed" });
  // AC4: a send invalidates the chat twice, when the message is saved and when the turn ends.
  assert.deepEqual(await eventsUntilNote(mark), [
    { kind: GatewayEventKind.ChatChanged, chatId: "c1" },
    { kind: GatewayEventKind.ChatChanged, chatId: "c1" },
  ]);

  // AC2, lanes 3 and 4: list, open, rename, delete.
  const listed = await call("GET", "/chats");
  assert.deepEqual(listed.body.map(({ id, title, messageCount, running }: any) => ({ id, title, messageCount, running })),
    [{ id: "c1", title: "say hi", messageCount: 2, running: false }]);
  assert.deepEqual((await call("GET", "/chats/c1")).body.messages, [
    { role: "user", text: "say hi" },
    { role: "assistant", parts: [{ type: "text", text: "hi" }], status: "completed" },
  ]);
  assert.equal((await call("GET", "/chats/absent")).status, 404);
  assert.equal((await call("PATCH", "/chats/c1", { title: "Greeting" })).body.title, "Greeting");
  assert.equal((await call("GET", "/chats")).body[0].title, "Greeting");
  assert.equal((await call("PATCH", "/chats/c1", { title: "x".repeat(201) })).status, 400);
  faux.setResponses([fauxAssistantMessage("again")]);
  assert.equal(text((await send("c1", "once more")).events), "again");
  assert.deepEqual((await call("GET", "/chats/c1")).body.messages.map((message: any) => message.role), ["user", "assistant", "user", "assistant"]);
  assert.equal((await call("GET", "/chats")).body[0].title, "Greeting", "a later turn keeps the name");
  assert.deepEqual((await call("DELETE", "/chats/c1")).body, { ok: true });
  assert.deepEqual((await call("GET", "/chats")).body, []);
  assert.equal(chatFiles().length, 1);
  assert.match(chatFiles()[0]!, /_c1\.jsonl\.deleted-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/);
  assert.equal((await call("DELETE", "/chats/c1")).status, 404);

  // AC2, lane 5: cancel mid-reply keeps the partial reply.
  faux.setResponses([fauxAssistantMessage(LONG_REPLY)]);
  let cancelled: { status: number; body: any } | undefined;
  const long = await send("c2", "tell me a long story", async (event) => {
    if (event.type === "text.delta" && !cancelled) cancelled = await call("POST", "/chats/c2/cancel", {});
  });
  assert.deepEqual(cancelled?.body, { cancelled: true });
  assert.deepEqual(long.events.at(-1), { seq: long.events.length - 1, type: "turn.finished", status: "cancelled" });
  const partial = (await call("GET", "/chats/c2")).body.messages;
  assert.equal(partial[1].status, "cancelled");
  assert.ok(partial[1].parts[0].text.length > 0 && partial[1].parts[0].text.length < LONG_REPLY.length, "the partial reply is kept");
  assert.deepEqual((await call("POST", "/chats/c2/cancel", {})).body, { cancelled: false }, "cancel is a no-op when idle");

  // AC3, lane 6: a second writer is refused while the first turn runs; the transcript stays whole.
  faux.setResponses([fauxAssistantMessage(LONG_REPLY)]);
  let second: Awaited<ReturnType<typeof send>> | undefined;
  let deleteDuring: { status: number; body: any } | undefined;
  const first = await send("c3", "first writer", async (event) => {
    if (event.type !== "text.delta" || second) return;
    second = await send("c3", "second writer");
    deleteDuring = await call("DELETE", "/chats/c3");
    assert.equal((await call("GET", "/chats/c3")).body.running, true);
  });
  assert.deepEqual([second?.status, second?.body], [409, { error: "chat c3 is replying; cancel it or wait", code: "chat_busy" }]);
  assert.equal(deleteDuring?.status, 409);
  assert.equal(text(first.events), LONG_REPLY);
  assert.deepEqual((await call("GET", "/chats/c3")).body.messages, [
    { role: "user", text: "first writer" },
    { role: "assistant", parts: [{ type: "text", text: LONG_REPLY }], status: "completed" },
  ]);

  // AC4, lane 8: one workspace.changed per file write, and per file-changing tool call in a chat.
  mark = heard.length;
  const saved = await call("PUT", "/workspace/file?path=notes/today.md", { content: "# today\n" });
  assert.deepEqual([saved.status, saved.body.created], [200, true]);
  assert.deepEqual(await eventsUntilNote(mark), [{ kind: GatewayEventKind.WorkspaceChanged }]);
  mark = heard.length;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "hello.md", content: "hello\n" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("wrote hello.md"),
  ]);
  const wrote = await send("c4", "write hello.md");
  assert.deepEqual(types(wrote.events).filter((type) => type.startsWith("tool.")), ["tool.started", "tool.finished"]);
  assert.equal(readFileSync(join(paths.workspace, "hello.md"), "utf8"), "hello\n");
  assert.deepEqual((await eventsUntilNote(mark)).filter((event) => event.kind === GatewayEventKind.WorkspaceChanged),
    [{ kind: GatewayEventKind.WorkspaceChanged }]);
  const tree = (await call("GET", "/workspace/tree")).body;
  assert.deepEqual([tree.entries.map((entry: any) => entry.path), tree.truncated], [["notes", "notes/today.md", "hello.md"], false]);
  assert.deepEqual((await call("GET", "/workspace/file?path=../daemon.json")).body.code, "invalid_path");
  assert.deepEqual((await call("GET", "/chats/c4")).body.messages[1].parts.map((part: any) => [part.type, part.status ?? ""]),
    [["tool", "done"], ["text", ""]]);

  // Ask mode: a headless chat has no one to ask, so a call that would ask is denied, as a tool result.
  savePermissionMode(home, "ask");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "denied.md", content: "x" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("could not write"),
  ]);
  const asked = await send("c5", "write denied.md");
  assert.deepEqual(asked.events.filter((event) => event.type === "tool.finished").map((event: any) => event.isError), [true]);
  assert.equal(existsSync(join(paths.workspace, "denied.md")), false);
  savePermissionMode(home, "allow");

  // Every turn runs the session start checks: an unreadable protected_paths.json refuses the send and writes nothing.
  writeFileSync(paths.protectedPaths, "{ not json");
  const before = chatFiles();
  const refused = await send("c6", "hello");
  assert.deepEqual([refused.status, refused.body.code], [503, "session_refused"]);
  assert.match(refused.body.error, /protected_paths\.json/);
  assert.deepEqual(chatFiles(), before);
  rmSync(paths.protectedPaths);

  // Stopping the daemon mid-turn cancels the turn and keeps the partial reply.
  faux.setResponses([fauxAssistantMessage(LONG_REPLY)]);
  let closing: Promise<void> | undefined;
  const interrupted = await send("c7", "long again", (event) => {
    if (event.type === "text.delta" && !closing) closing = daemon.close();
  });
  await closing;
  assert.deepEqual(interrupted.events.at(-1)?.type === "turn.finished" ? (interrupted.events.at(-1) as any).status : "none", "cancelled");
  daemon = await startDaemon({ port: 0, fingerprintIntervalMs: 60_000, scheduler: { wakeIntervalMs: 60_000 } });
  const afterRestart = (await call("GET", "/chats/c7")).body;
  assert.equal(afterRestart.running, false);
  assert.equal(afterRestart.messages[1].status, "cancelled");

  process.stdout.write("ok — chats stream, list, rename, delete, and cancel over the Gateway; one writer per chat; events fire once per change\n");
} finally {
  events.abort();
  await daemon.close();
  if (previousHome === undefined) delete process.env.PI_TEMPLATE_HOME;
  else process.env.PI_TEMPLATE_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
}
