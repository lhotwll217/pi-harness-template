import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Chat,
  ChatStreamEvent,
  ChatSummary,
  GatewayEvent,
  WorkspaceFile,
  WorkspaceTree,
} from "@/lib/gateway-contracts";

export const FAKE_TOKEN = "fake-gateway-token-0123456789";

type ReplyEvent = ChatStreamEvent extends infer E ? E extends unknown ? Omit<E, "seq"> : never : never;

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization?: string;
  readonly body?: unknown;
}

export interface FakeGateway {
  readonly home: string;
  readonly port: number;
  readonly requests: RecordedRequest[];
  chats: ChatSummary[];
  transcripts: Map<string, Chat>;
  tree: WorkspaceTree;
  files: Map<string, WorkspaceFile>;
  /** Paths whose bytes are not UTF-8 text, which the Gateway refuses with 415. */
  notText: Set<string>;
  ready: { ready: boolean; setupRequired: boolean };
  /** The events the next `POST /chats/:id/messages` streams, without `seq` (added in order). */
  reply: ReplyEvent[];
  /** A status for the next send to answer instead of a stream, as the Gateway does when busy. */
  refuseSend?: { status: number; error: string; code: string };
  publish(event: GatewayEvent): void;
  close(): Promise<void>;
}

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) as unknown : undefined;
};

export async function startFakeGateway(): Promise<FakeGateway> {
  const home = mkdtempSync(join(tmpdir(), "pi-template-web-test-"));
  const streams = new Set<ServerResponse>();
  const state = {
    requests: [] as RecordedRequest[],
    chats: [] as ChatSummary[],
    transcripts: new Map<string, Chat>(),
    tree: { entries: [], truncated: false } as WorkspaceTree,
    files: new Map<string, WorkspaceFile>(),
    notText: new Set<string>(),
    ready: { ready: true, setupRequired: false },
    reply: [] as ReplyEvent[],
    refuseSend: undefined as FakeGateway["refuseSend"],
  };

  const respond = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = request.method === "GET" || request.method === "DELETE" ? undefined : await readBody(request);
    state.requests.push({
      method: request.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      ...(body === undefined ? {} : { body }),
    });
    if (request.headers.authorization !== `Bearer ${FAKE_TOKEN}`) return respond(response, 401, { error: "unauthorized" });

    const route = `${request.method} ${url.pathname}`;
    if (route === "GET /ready") return respond(response, state.ready.ready ? 200 : 503, { ...state.ready, modules: {} });
    if (route === "GET /events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(":ready\n\n");
      streams.add(response);
      request.on("close", () => streams.delete(response));
      return;
    }
    if (route === "GET /chats") return respond(response, 200, state.chats);
    if (route === "GET /workspace/tree") return respond(response, 200, state.tree);
    if (url.pathname === "/workspace/file") {
      const path = url.searchParams.get("path") ?? "";
      const file = state.files.get(path);
      if (request.method === "GET") {
        if (state.notText.has(path)) return respond(response, 415, { error: "not a text file", code: "not_text" });
        return file ? respond(response, 200, file) : respond(response, 404, { error: "no such file", code: "not_found" });
      }
      const { content, baseRevision } = body as { content: string; baseRevision?: string };
      if (baseRevision && file && file.revision !== baseRevision) {
        return respond(response, 409, { error: "the file changed", code: "file_changed", current: { revision: file.revision } });
      }
      const revision = `sha256:${String(state.requests.length).padStart(64, "0")}`;
      const modifiedAt = "2026-10-17T12:00:00.000Z";
      state.files.set(path, { path, content, revision, modifiedAt });
      if (!state.tree.entries.some((entry) => entry.path === path)) {
        state.tree = { ...state.tree, entries: [...state.tree.entries, { path, kind: "file", size: content.length, modifiedAt }] };
      }
      return respond(response, 200, { path, revision, modifiedAt, created: !file });
    }

    const chatMatch = /^\/chats\/([^/]+)(\/messages|\/cancel)?$/.exec(url.pathname);
    if (!chatMatch) return respond(response, 404, { error: "no such route", code: "not_found" });
    const id = decodeURIComponent(chatMatch[1]);
    const action = chatMatch[2];
    if (request.method === "POST" && action === "/messages") {
      if (state.refuseSend) return respond(response, state.refuseSend.status, { error: state.refuseSend.error, code: state.refuseSend.code });
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      state.reply.forEach((event, seq) => response.write(`${JSON.stringify({ seq, ...event })}\n`));
      response.end();
      return;
    }
    if (request.method === "POST" && action === "/cancel") return respond(response, 200, { cancelled: true });
    const summary = state.chats.find((chat) => chat.id === id);
    if (!summary) return respond(response, 404, { error: `no chat ${id}`, code: "chat_not_found" });
    if (request.method === "GET") return respond(response, 200, state.transcripts.get(id) ?? { ...summary, messages: [] });
    if (request.method === "PATCH") {
      const renamed = { ...summary, title: (body as { title: string }).title };
      state.chats = state.chats.map((chat) => (chat.id === id ? renamed : chat));
      return respond(response, 200, renamed);
    }
    if (request.method === "DELETE") {
      state.chats = state.chats.filter((chat) => chat.id !== id);
      return respond(response, 200, { ok: true });
    }
    return respond(response, 404, { error: "no such route", code: "not_found" });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  writeFileSync(join(home, "daemon.json"), JSON.stringify({ port, pid: process.pid, startedAt: "", fingerprint: "", authToken: FAKE_TOKEN }));

  return Object.assign(state, {
    home,
    port,
    publish(event: GatewayEvent) {
      for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    async close() {
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      await new Promise<void>((closed) => server.close(() => closed()));
      rmSync(home, { recursive: true, force: true });
    },
  });
}

export function localRequest(path: string, init: RequestInit & { origin?: string } = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("host", "127.0.0.1:47812");
  if (init.origin) headers.set("origin", init.origin);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`http://127.0.0.1:47812${path}`, { ...init, headers });
}

export const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });
