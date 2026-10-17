import "server-only";

import { readFileSync } from "node:fs";
import { harnessPaths } from "@pi-template/contracts/harness-home";
import type {
  Chat,
  ChatId,
  ChatStreamEvent,
  ChatSummary,
  WorkspaceFile,
  WorkspaceTree,
  WorkspaceWriteResult,
} from "./gateway-contracts";
import type { DaemonState } from "./chat-types";
import { LocalGatewayError, ownerMessage } from "./gateway-error";
import { GatewayStreamError, parseGatewayChatStream } from "./gateway-stream";

export { LocalGatewayError } from "./gateway-error";

const DAEMON_DOWN = "The pi-template daemon is not running.";

interface LocalDaemonInfo {
  readonly port: number;
  readonly authToken: string;
}

function currentDaemonInfo(): LocalDaemonInfo {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(harnessPaths().daemonInfo, "utf8"));
  } catch {
    throw new LocalGatewayError(503, DAEMON_DOWN);
  }
  const info = (value ?? {}) as Partial<LocalDaemonInfo>;
  if (!Number.isInteger(info.port) || typeof info.authToken !== "string" || !info.authToken) {
    throw new LocalGatewayError(503, DAEMON_DOWN);
  }
  return info as LocalDaemonInfo;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const info = currentDaemonInfo();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${info.authToken}`);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${info.port}${path}`, { ...init, headers, cache: "no-store" });
  } catch (error: unknown) {
    if (init.signal?.aborted) throw error;
    throw new LocalGatewayError(503, DAEMON_DOWN);
  }
  if (!response.ok) {
    let body: unknown;
    try { body = await response.json(); } catch { body = undefined; }
    const { code, error } = (body && typeof body === "object" ? body : {}) as { code?: unknown; error?: unknown };
    const refusal = typeof code === "string" ? code : undefined;
    throw new LocalGatewayError(
      response.status,
      ownerMessage(refusal, typeof error === "string" ? error : undefined, "The harness could not complete that request."),
      refusal,
      body,
    );
  }
  return response;
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  return await (await request(path, init)).json() as T;
}

const withJson = (method: string, body: unknown, signal?: AbortSignal): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
  ...(signal ? { signal } : {}),
});

const chatPath = (id: ChatId): string => `/chats/${encodeURIComponent(id)}`;
const filePath = (path: string): string => `/workspace/file?path=${encodeURIComponent(path)}`;

export async function listChats(): Promise<ChatSummary[]> {
  return await json<ChatSummary[]>("/chats");
}

export async function getChat(id: ChatId): Promise<Chat> {
  return await json<Chat>(chatPath(id));
}

export async function renameChat(id: ChatId, title: string): Promise<ChatSummary> {
  try {
    return await json<ChatSummary>(chatPath(id), withJson("PATCH", { title }));
  } catch (error: unknown) {
    if (!(error instanceof LocalGatewayError) || error.code !== "invalid_request") throw error;
    throw new LocalGatewayError(400, `That title cannot be used: ${error.message}.`, error.code, error.body);
  }
}

export async function deleteChat(id: ChatId): Promise<void> {
  await request(chatPath(id), { method: "DELETE" });
}

export async function cancelChatTurn(id: ChatId, turnId?: string): Promise<{ cancelled: boolean }> {
  return await json(`${chatPath(id)}/cancel`, withJson("POST", turnId ? { turnId } : {}));
}

/** Every refusal (busy, setup, a failed start check) arrives as a status before the first event. */
export async function streamChatTurn(id: ChatId, text: string, signal?: AbortSignal): Promise<AsyncIterable<ChatStreamEvent>> {
  const response = await request(`${chatPath(id)}/messages`, withJson("POST", { text }, signal));
  if (!response.body) throw new LocalGatewayError(502, "The harness returned no chat stream.");
  const body = response.body;
  return {
    async *[Symbol.asyncIterator]() {
      try {
        yield* parseGatewayChatStream(body);
      } catch (error: unknown) {
        if (error instanceof GatewayStreamError) throw new LocalGatewayError(502, error.message);
        throw error;
      }
    },
  };
}

export async function getWorkspaceTree(): Promise<WorkspaceTree> {
  return await json<WorkspaceTree>("/workspace/tree");
}

export async function getWorkspaceFile(path: string): Promise<WorkspaceFile> {
  return await json<WorkspaceFile>(filePath(path));
}

export async function putWorkspaceFile(path: string, content: string, baseRevision?: string): Promise<WorkspaceWriteResult> {
  return await json<WorkspaceWriteResult>(filePath(path), withJson("PUT", baseRevision ? { content, baseRevision } : { content }));
}

export async function streamGatewayEvents(signal: AbortSignal): Promise<Response> {
  return await request("/events", { headers: { accept: "text/event-stream" }, signal });
}

/** `/ready` answers 200 when ready and 503 when not; anything else, or no answer, is down. */
export async function daemonState(): Promise<DaemonState> {
  try {
    const info = currentDaemonInfo();
    const response = await fetch(`http://127.0.0.1:${info.port}/ready`, {
      headers: { authorization: `Bearer ${info.authToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    });
    if (response.status !== 200 && response.status !== 503) return "down";
    const ready = await response.json() as { ready?: unknown; setupRequired?: unknown };
    if (ready.setupRequired === true) return "setup";
    return ready.ready === true ? "ready" : "down";
  } catch {
    return "down";
  }
}
