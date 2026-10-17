import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { SessionManager, type AgentSessionEvent, type SessionInfo } from "@earendil-works/pi-coding-agent";
import {
  CHAT_TITLE_MAX,
  DomainEventKind,
  GatewayRouteError,
  ONBOARDING_VERSION,
  harnessPaths,
  type Chat,
  type ChatCancelResult,
  type ChatStreamEvent,
  type ChatSummary,
  type ChatTurnStatus,
  type DomainEvent,
} from "@pi-template/contracts";
import { projectChat } from "./chat-projection";
import { createHarnessSession } from "./runtime";

type HarnessSession = Awaited<ReturnType<typeof createHarnessSession>>["session"];
type StreamEvent = ChatStreamEvent extends infer E ? E extends ChatStreamEvent ? Omit<E, "seq"> : never : never;

interface Turn {
  turnId: string;
  session?: HarnessSession;
  cancelRequested: boolean;
  settled: Promise<void>;
}

export interface ChatServiceOptions {
  home?: string;
  publish(event: DomainEvent): void;
}

/** Tools whose call may change workspace files; each finished call invalidates the workspace once. */
const WORKSPACE_TOOLS = new Set(["write", "edit", "bash"]);

const busy = (id: string) => new GatewayRouteError(409, "chat_busy", `chat ${id} is replying; cancel it or wait`);
const notFound = (id: string) => new GatewayRouteError(404, "chat_not_found", `no chat ${id}`);
const titleOf = (info: SessionInfo): string =>
  info.name ?? info.firstMessage.replace(/\s+/g, " ").trim().slice(0, CHAT_TITLE_MAX);

/**
 * Chats over the Gateway. A chat is a Pi session in `<home>/transcripts/chats`, and the daemon is its
 * only writer: one turn per chat at a time, each in a fresh headless harness session, so every
 * session start check runs on every turn (docs/state-and-sessions.md#chats).
 */
export function createChatService(options: ChatServiceOptions) {
  const paths = harnessPaths(options.home);
  const folder = paths.chatTranscripts;
  const turns = new Map<string, Turn>();
  const changed = (chatId: string): void => options.publish({ kind: DomainEventKind.ChatChanged, chatId });

  /** Pi names a transcript `<timestamp>_<id>.jsonl`; the timestamp holds no `_`. */
  function transcriptOf(id: string): string | undefined {
    let names: string[];
    try { names = readdirSync(folder); } catch { return undefined; }
    const name = names.find((entry) => entry.endsWith(".jsonl") && entry.slice(entry.indexOf("_") + 1, -".jsonl".length) === id);
    return name && join(folder, name);
  }

  const storedMessages = (file: string): unknown[] => SessionManager.open(file, folder, paths.workspace).buildSessionContext().messages;

  async function summaries(): Promise<ChatSummary[]> {
    return (await SessionManager.listAll(folder)).map((info) => ({
      id: info.id,
      title: titleOf(info),
      createdAt: info.created.toISOString(),
      updatedAt: info.modified.toISOString(),
      // Pi's own count includes tool results and system entries; a client counts the chat's messages.
      messageCount: projectChat(storedMessages(info.path), false).length,
      running: turns.has(info.id),
    }));
  }

  async function summary(id: string): Promise<ChatSummary> {
    const found = (await summaries()).find((chat) => chat.id === id);
    if (!found) throw notFound(id);
    return found;
  }

  async function get(id: string): Promise<Chat> {
    const turn = turns.get(id);
    const file = transcriptOf(id);
    if (!file && !turn?.session) throw notFound(id);
    const messages = turn?.session ? turn.session.messages : storedMessages(file!);
    const base: ChatSummary = file
      ? await summary(id)
      : { id, title: "", createdAt: "", updatedAt: "", messageCount: 0, running: true };
    return { ...base, ...(turn ? { turnId: turn.turnId } : {}), messages: projectChat(messages, turn !== undefined) };
  }

  /** Every refusal is thrown before the returned stream starts, so the Gateway can answer it with a status. */
  async function send(id: string, text: string): Promise<AsyncIterable<ChatStreamEvent>> {
    if (turns.has(id)) throw busy(id);
    let settle!: () => void;
    const turn: Turn = { turnId: randomUUID(), cancelRequested: false, settled: new Promise((resolve) => { settle = resolve; }) };
    turns.set(id, turn);
    let session: HarnessSession | undefined;
    const release = async (): Promise<void> => {
      try {
        if (session) {
          try {
            await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          } finally {
            session.dispose();
          }
        }
      } finally {
        turns.delete(id);
        settle();
      }
    };

    const stream = new Readable({ objectMode: true, read() {} });
    let seq = 0;
    const emit = (event: StreamEvent): void => { stream.push({ seq: seq++, ...event }); };
    let unsubscribe = (): void => undefined;
    let started: Promise<void>;
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const file = transcriptOf(id);
      const manager = file ? SessionManager.open(file, folder, paths.workspace) : SessionManager.create(paths.workspace, folder, { id });
      try {
        const created = await createHarnessSession({ home: paths.home, cwd: paths.workspace, sessionManager: manager, headless: true });
        session = created.session;
        manager.appendCustomEntry("pi-template-provenance", {
          origin: "gateway-chat",
          caller: "owner",
          chatId: id,
          turnId: turn.turnId,
          taskDirectory: paths.workspace,
          effectiveCapabilities: created.toolNames,
          trustPolicyVersion: ONBOARDING_VERSION,
          approvalPolicy: "deny-when-live-approval-is-unavailable",
        });
        // Print mode has no UI context, so the permission extension denies what would ask the owner.
        await session.bindExtensions({ mode: "print" });
      } catch (error) {
        throw new GatewayRouteError(503, "session_refused", error instanceof Error ? error.message : String(error));
      }
      turn.session = session;
      let userSaved = false;
      unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "message_end" && event.message.role === "user" && !userSaved) {
          userSaved = true;
          changed(id);
        }
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          emit({ type: "text.delta", delta: event.assistantMessageEvent.delta });
        }
        if (event.type === "tool_execution_start") {
          emit({ type: "tool.started", callId: event.toolCallId, name: event.toolName, args: event.args });
        }
        if (event.type === "tool_execution_end") {
          emit({ type: "tool.finished", callId: event.toolCallId, isError: event.isError });
          if (WORKSPACE_TOOLS.has(event.toolName)) options.publish({ kind: DomainEventKind.WorkspaceChanged });
        }
      });
      const live = session;
      let accepted!: () => void;
      const acceptance = new Promise<void>((resolve) => { accepted = resolve; });
      // Chat text goes to the model as typed: no slash commands, skill commands, or prompt templates.
      const running = live.prompt(text, {
        expandPromptTemplates: false,
        preflightResult: (result) => { if (result === "started") accepted(); },
      });
      started = Promise.race([acceptance, running.then(() => undefined)]);
      try {
        await started;
      } catch (error) {
        throw new GatewayRouteError(503, "session_refused", error instanceof Error ? error.message : String(error));
      }
      emit({ type: "turn.started", chatId: id, turnId: turn.turnId });
      if (turn.cancelRequested) void live.abort();
      void running.then(
        () => finished(live),
        (error: unknown) => ({ status: "failed" as const, error: error instanceof Error ? error.message : String(error) }),
      ).then(async (outcome) => {
        unsubscribe();
        await release();
        emit({ type: "turn.finished", ...outcome });
        stream.push(null);
        changed(id);
      });
      return stream;
    } catch (error) {
      unsubscribe();
      await release();
      throw error;
    }
  }

  function finished(session: HarnessSession): { status: ChatTurnStatus; error?: string } {
    const last = [...session.messages].reverse().find((message) => message.role === "assistant") as
      { stopReason?: unknown; errorMessage?: unknown } | undefined;
    if (last?.stopReason === "aborted") return { status: "cancelled" };
    if (last?.stopReason === "error") {
      return { status: "failed", error: typeof last.errorMessage === "string" && last.errorMessage.trim() ? last.errorMessage.trim() : "model turn stopped with an error" };
    }
    return { status: "completed" };
  }

  async function cancel(id: string, turnId?: string): Promise<ChatCancelResult> {
    const turn = turns.get(id);
    if (!turn) {
      if (!transcriptOf(id)) throw notFound(id);
      return { cancelled: false };
    }
    if (turnId !== undefined && turnId !== turn.turnId) return { cancelled: false };
    turn.cancelRequested = true;
    if (turn.session) await turn.session.abort();
    return { cancelled: true };
  }

  async function rename(id: string, title: string): Promise<ChatSummary> {
    const trimmed = title.replace(/[\r\n]+/g, " ").trim();
    if (!trimmed || trimmed.length > CHAT_TITLE_MAX) {
      throw new GatewayRouteError(400, "invalid_request", `title must be 1 to ${CHAT_TITLE_MAX} characters`);
    }
    const turn = turns.get(id);
    if (turn && !turn.session) throw busy(id);
    if (turn?.session) {
      turn.session.setSessionName(trimmed);
    } else {
      const file = transcriptOf(id);
      if (!file) throw notFound(id);
      SessionManager.open(file, folder, paths.workspace).appendSessionInfo(trimmed);
    }
    changed(id);
    return await summary(id);
  }

  /** Renames the transcript out of the listing and never unlinks it (Stitcher 224c4fe). */
  function remove(id: string): void {
    if (turns.has(id)) throw busy(id);
    const file = transcriptOf(id);
    if (!file) throw notFound(id);
    renameSync(file, `${file}.deleted-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    changed(id);
  }

  /** Cancels every running turn and waits for each to settle; the partial replies stay in their transcripts. */
  async function stop(): Promise<void> {
    const running = [...turns.values()];
    for (const turn of running) {
      turn.cancelRequested = true;
      void turn.session?.abort();
    }
    await Promise.all(running.map((turn) => turn.settled));
  }

  return { list: summaries, get, send, cancel, rename, delete: remove, stop };
}

export type ChatService = ReturnType<typeof createChatService>;
