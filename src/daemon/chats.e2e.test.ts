import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { checkoutRoot } from "../agent/sandbox";
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
/** Every body and stream line the Gateway answered, so the run can check none names an absolute path. */
const answered: string[] = [];
const info = (): DaemonInfo => JSON.parse(readFileSync(paths.daemonInfo, "utf8")) as DaemonInfo;
const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${info().authToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const answer = await response.text();
  answered.push(answer);
  return { status: response.status, body: JSON.parse(answer) as any };
};

/** Send a chat message; `onLine` sees each NDJSON line as it arrives. */
async function send(chatId: string, text: string, onLine?: (event: ChatStreamEvent) => void | Promise<void>) {
  const response = await fetch(`http://127.0.0.1:${daemon.port}/chats/${chatId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${info().authToken}`, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (response.status !== 200) {
    const answer = await response.text();
    answered.push(answer);
    return { status: response.status, body: JSON.parse(answer) as any, events: [] as ChatStreamEvent[] };
  }
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
      answered.push(buffer.slice(0, newline));
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
    return;
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

/** The real CLI against this daemon; `onSpawn` and `onStdout` may signal the child. */
async function cli(args: readonly string[], onStdout?: (chunk: string, child: ReturnType<typeof spawn>) => void,
  onSpawn?: (child: ReturnType<typeof spawn>) => void) {
  return await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(join(checkoutRoot, "pi-template"), args, {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PI_TEMPLATE_HOME: home, PI_TEMPLATE_PORT: "0" },
      timeout: 30_000,
    });
    onSpawn?.(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; onStdout?.(chunk, child); });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolveRun({ status, stdout, stderr }));
  });
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
  assert.deepEqual(await eventsUntilNote(mark), [
    { kind: GatewayEventKind.ChatChanged, chatId: "c1" },
    { kind: GatewayEventKind.ChatChanged, chatId: "c1" },
  ]);

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
  assert.deepEqual((await call("PATCH", "/chats/c1", { title: "bell\u0007" })).body.code, "invalid_request");
  for (const title of ["line\u2028separator", "right\u202eto left", "c1\u0085control"]) {
    const refusedTitle = await call("PATCH", "/chats/c1", { title });
    assert.deepEqual([refusedTitle.status, refusedTitle.body.code], [400, "invalid_request"], JSON.stringify(title));
  }
  assert.equal((await call("PATCH", "/chats/c1", { title: "two\nlines" })).body.title, "two lines");
  assert.equal((await call("PATCH", "/chats/c1", { title: "Greeting" })).body.title, "Greeting");
  faux.setResponses([fauxAssistantMessage("again")]);
  assert.equal(text((await send("c1", "once more")).events), "again");
  assert.deepEqual((await call("GET", "/chats/c1")).body.messages.map((message: any) => message.role), ["user", "assistant", "user", "assistant"]);
  assert.equal((await call("GET", "/chats")).body[0].title, "Greeting", "a later turn keeps the name");
  assert.deepEqual((await call("DELETE", "/chats/c1")).body, { ok: true });
  assert.deepEqual((await call("GET", "/chats")).body, []);
  assert.equal(chatFiles().length, 1);
  assert.match(chatFiles()[0]!, /_c1\.jsonl\.deleted-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/);
  assert.equal((await call("DELETE", "/chats/c1")).status, 404);

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
  const oversized = await call("PUT", "/workspace/file?path=big.md", { content: "\u0001".repeat(1_000_001) });
  assert.deepEqual([oversized.status, oversized.body.code], [413, "too_large"], "an oversized save reaches the file limit");
  const longPath = Array.from({ length: 110 }, () => "a".repeat(48)).join("/");
  const tooLong = await call("PUT", `/workspace/file?path=${longPath}/x.md`, { content: "x" });
  assert.deepEqual([tooLong.status, tooLong.body.code], [400, "invalid_path"]);
  assert.ok(!tooLong.body.error.includes(paths.workspace), "a refusal names no absolute path");
  assert.equal(existsSync(join(paths.workspace, "a".repeat(48))), false);
  assert.deepEqual((await call("GET", "/chats/c4")).body.messages[1].parts.map((part: any) => [part.type, part.status ?? ""]),
    [["tool", "done"], ["text", ""]]);

  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 5" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("slept"),
  ]);
  let cancelledInTool: { status: number; body: any } | undefined;
  const midTool = await send("c9", "sleep", async (event) => {
    if (event.type === "tool.started" && !cancelledInTool) cancelledInTool = await call("POST", "/chats/c9/cancel", {});
  });
  assert.deepEqual(cancelledInTool?.body, { cancelled: true });
  assert.deepEqual(midTool.events.at(-1), { seq: midTool.events.length - 1, type: "turn.finished", status: "cancelled" });
  assert.equal((await call("GET", "/chats/c9")).body.messages.at(-1).status, "cancelled", "the stored turn reads cancelled");

  faux.setResponses([fauxAssistantMessage("hi")]);
  assert.deepEqual(await cli(["prompt", "--chat", "c8", "say", "hi"]), { status: 0, stdout: "hi\n", stderr: "" });
  faux.setResponses([fauxAssistantMessage("hi")]);
  const json = await cli(["prompt", "--json", "--chat", "c8", "again"]);
  assert.deepEqual(json.stdout.trim().split("\n").map((line) => JSON.parse(line).type), ["turn.started", "text.delta", "turn.finished"]);
  faux.setResponses([fauxAssistantMessage(LONG_REPLY)]);
  let interruptedOnce = false;
  const cancelledByCtrlC = await cli(["prompt", "--chat", "c8", "long"], (_chunk, child) => {
    if (!interruptedOnce) { interruptedOnce = true; child.kill("SIGINT"); }
  });
  assert.deepEqual([cancelledByCtrlC.status, cancelledByCtrlC.stderr], [1, '{"error":"the chat turn was cancelled"}\n']);
  assert.equal((await call("GET", "/chats/c8")).body.messages.at(-1).status, "cancelled");
  faux.setResponses([fauxAssistantMessage(LONG_REPLY)]);
  const early = await cli(["prompt", "--chat", "c8", "long"], undefined, (child) => {
    let signalled = false;
    const poll = setInterval(() => void call("GET", "/chats/c8").then(({ body }) => {
      if (!body.running || signalled) return;
      signalled = true;
      clearInterval(poll);
      child.kill("SIGINT");
    }), 5);
    child.once("close", () => clearInterval(poll));
  });
  assert.deepEqual([early.status, early.stderr], [1, '{"error":"the chat turn was cancelled"}\n'],
    "a Ctrl-C while the turn starts cancels it");

  savePermissionMode(home, "ask");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "denied.md", content: "x" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("could not write"),
  ]);
  const asked = await send("c5", "write denied.md");
  assert.deepEqual(asked.events.filter((event) => event.type === "tool.finished").map((event: any) => event.isError), [true]);
  assert.equal(existsSync(join(paths.workspace, "denied.md")), false);
  savePermissionMode(home, "allow");

  writeFileSync(paths.protectedPaths, "{ not json");
  const before = chatFiles();
  const refused = await send("c6", "hello");
  assert.deepEqual([refused.status, refused.body.code], [503, "session_refused"]);
  assert.match(refused.body.error, /^protected paths are not valid JSON at protected_paths\.json; .*`pi-template onboard`/);
  assert.deepEqual(chatFiles(), before);
  rmSync(paths.protectedPaths);

  const c3File = join(paths.chatTranscripts, chatFiles().find((name) => name.endsWith("_c3.jsonl"))!);
  const c3Before = [readFileSync(c3File, "utf8"), (await call("GET", "/chats/c3")).body.updatedAt];
  writeFileSync(paths.piAuth, "{}");
  writeFileSync(paths.piModels, JSON.stringify({ providers: { [faux.getModel().provider]: {
    api: faux.getModel().api, baseUrl: "http://127.0.0.1:1", models: [faux.getModel()] } } }));
  const noKey = await send("c3", "hello again");
  assert.deepEqual([noKey.status, noKey.body.code], [503, "session_refused"]);
  assert.match(noKey.body.error, /^No API key found for [^]*Use \/login [^]*\n {2}providers\.md\n {2}models\.md$/);
  assert.deepEqual([readFileSync(c3File, "utf8"), (await call("GET", "/chats/c3")).body.updatedAt], c3Before,
    "a refused turn leaves an existing chat untouched");
  seedFauxProviderHome(paths, faux.getModel());

  chmodSync(c3File, 0o000);
  try {
    const unreadable = { error: "chat c3 transcript: EACCES", code: "filesystem_error" };
    assert.deepEqual(await call("GET", "/chats/c3"), { status: 500, body: unreadable });
    assert.deepEqual(await call("PATCH", "/chats/c3", { title: "Renamed" }), { status: 500, body: unreadable });
  } finally {
    chmodSync(c3File, 0o600);
  }

  faux.setResponses([fauxAssistantMessage(LONG_REPLY), fauxAssistantMessage(LONG_REPLY)]);
  let closing: Promise<void> | undefined;
  let lateSend: Awaited<ReturnType<typeof send>> | undefined;
  const interrupted = await send("c7", "long again", async (event) => {
    if (event.type !== "text.delta" || closing) return;
    closing = daemon.close();
    lateSend = await send("c10", "arrives while stopping");
  });
  await closing;
  assert.deepEqual([lateSend?.status, lateSend?.body.code], [503, "daemon_stopping"]);
  assert.deepEqual(interrupted.events.at(-1)?.type === "turn.finished" ? (interrupted.events.at(-1) as any).status : "none", "cancelled");
  daemon = await startDaemon({ port: 0, fingerprintIntervalMs: 60_000, scheduler: { wakeIntervalMs: 60_000 } });
  const afterRestart = (await call("GET", "/chats/c7")).body;
  assert.equal(afterRestart.running, false);
  assert.equal(afterRestart.messages[1].status, "cancelled");

  for (const absolute of [root, checkoutRoot]) {
    assert.deepEqual(answered.filter((answer) => answer.includes(absolute)), [], `no Gateway answer names ${absolute}`);
  }

  process.stdout.write("ok — chats stream, list, rename, delete, and cancel over the Gateway; one writer per chat; events fire once per change\n");
} finally {
  events.abort();
  await daemon.close();
  if (previousHome === undefined) delete process.env.PI_TEMPLATE_HOME;
  else process.env.PI_TEMPLATE_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
}
