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

const WORKSPACE_CHANGING_TOOLS = new Set(["write", "edit", "bash"]);
/** Marks a turn the owner cancelled, by its user message's timestamp; Pi may store such a turn as an error. */
const TURN_CANCELLED = "pi-template-turn-cancelled";

const busy = (id: string) => new GatewayRouteError(409, "chat_busy", `chat ${id} is replying; cancel it or wait`);
const notFound = (id: string) => new GatewayRouteError(404, "chat_not_found", `no chat ${id}`);
const refused = (error: unknown) =>
  new GatewayRouteError(503, "session_refused", error instanceof Error ? error.message : String(error));
const titleOf = (info: SessionInfo): string =>
  info.name ?? info.firstMessage.replace(/\s+/g, " ").trim().slice(0, CHAT_TITLE_MAX);

export function createChatService(options: ChatServiceOptions) {
  const paths = harnessPaths(options.home);
  const folder = paths.chatTranscripts;
  const turns = new Map<string, Turn>();
  let stopping = false;
  const changed = (chatId: string): void => options.publish({ kind: DomainEventKind.ChatChanged, chatId });

  /** Pi names a transcript `<timestamp>_<id>.jsonl`; the timestamp holds no `_`. */
  function transcriptOf(id: string): string | undefined {
    let names: string[];
    try { names = readdirSync(folder); } catch { return undefined; }
    const name = names.find((entry) => entry.endsWith(".jsonl") && entry.slice(entry.indexOf("_") + 1, -".jsonl".length) === id);
    return name && join(folder, name);
  }

  function stored(file: string): { messages: unknown[]; cancelled: Set<unknown> } {
    const manager = SessionManager.open(file, folder, paths.workspace);
    const cancelled = new Set(manager.getEntries().flatMap((entry) => entry.type === "custom" && entry.customType === TURN_CANCELLED
      ? [(entry.data as { userMessageTimestamp?: unknown } | undefined)?.userMessageTimestamp]
      : []));
    return { messages: manager.buildSessionContext().messages, cancelled };
  }

  async function summaries(): Promise<ChatSummary[]> {
    return (await SessionManager.listAll(folder)).map((info) => ({
      id: info.id,
      title: titleOf(info),
      createdAt: info.created.toISOString(),
      updatedAt: info.modified.toISOString(),
      // Pi's own count includes tool results and system entries; a client counts the chat's messages.
      messageCount: projectChat(stored(info.path).messages, false).length,
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
    const { messages, cancelled } = turn?.session ? { messages: turn.session.messages, cancelled: undefined } : stored(file!);
    const base: ChatSummary = file
      ? await summary(id)
      : { id, title: "", createdAt: "", updatedAt: "", messageCount: 0, running: true };
    return { ...base, ...(turn ? { turnId: turn.turnId } : {}), messages: projectChat(messages, turn !== undefined, cancelled) };
  }

  async function send(id: string, text: string): Promise<AsyncIterable<ChatStreamEvent>> {
    if (stopping) throw new GatewayRouteError(503, "daemon_stopping", "the daemon is stopping; send again once it restarts");
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
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const file = transcriptOf(id);
      const manager = file ? SessionManager.open(file, folder, paths.workspace) : SessionManager.create(paths.workspace, folder, { id });
      let toolNames: string[];
      try {
        const created = await createHarnessSession({ home: paths.home, cwd: paths.workspace, sessionManager: manager, headless: true });
        session = created.session;
        toolNames = created.toolNames;
        await session.bindExtensions({ mode: "print" });
      } catch (error) {
        throw refused(error);
      }
      turn.session = session;
      let userMessageTimestamp: number | undefined;
      unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "message_end" && event.message.role === "user" && userMessageTimestamp === undefined) {
          userMessageTimestamp = event.message.timestamp;
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
          if (WORKSPACE_CHANGING_TOOLS.has(event.toolName)) options.publish({ kind: DomainEventKind.WorkspaceChanged });
        }
      });
      const live = session;
      let accepted!: () => void;
      const acceptance = new Promise<boolean>((resolve) => { accepted = () => resolve(true); });
      // Chat text goes to the model as typed: no slash commands, skill commands, or prompt templates.
      const running = live.prompt(text, {
        expandPromptTemplates: false,
        preflightResult: (result) => {
          if (result !== "started") return;
          // Written once Pi accepts the turn, so a refused send leaves the transcript as it was.
          manager.appendCustomEntry("pi-template-provenance", {
            origin: "gateway-chat",
            caller: "owner",
            chatId: id,
            turnId: turn.turnId,
            taskDirectory: paths.workspace,
            effectiveCapabilities: toolNames,
            trustPolicyVersion: ONBOARDING_VERSION,
            approvalPolicy: "deny-when-live-approval-is-unavailable",
          });
          accepted();
        },
      });
      let started: boolean;
      try {
        started = await Promise.race([acceptance, running.then(() => false)]);
      } catch (error) {
        throw refused(error);
      }
      if (!started) throw refused("Pi did not start the turn");
      emit({ type: "turn.started", chatId: id, turnId: turn.turnId });
      if (turn.cancelRequested) void live.abort();
      void running.then(
        () => finished(live),
        (error: unknown) => ({ status: "failed" as const, error: error instanceof Error ? error.message : String(error) }),
      ).then((result): { status: ChatTurnStatus; error?: string } => {
        // A cancelled turn can end as an error, such as the abort reaching a tool call; the owner asked for the stop.
        if (!turn.cancelRequested || result.status !== "failed") return result;
        if (userMessageTimestamp !== undefined) manager.appendCustomEntry(TURN_CANCELLED, { turnId: turn.turnId, userMessageTimestamp });
        return { status: "cancelled" };
      }).then(async (outcome) => {
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
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new GatewayRouteError(400, "invalid_request", "title must not hold control characters");
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

  function archive(id: string): void {
    if (turns.has(id)) throw busy(id);
    const file = transcriptOf(id);
    if (!file) throw notFound(id);
    renameSync(file, `${file}.deleted-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    changed(id);
  }

  async function stop(): Promise<void> {
    stopping = true;
    const running = [...turns.values()];
    for (const turn of running) {
      turn.cancelRequested = true;
      void turn.session?.abort();
    }
    await Promise.all(running.map((turn) => turn.settled));
  }

  return { list: summaries, get, send, cancel, rename, delete: archive, stop };
}

export type ChatService = ReturnType<typeof createChatService>;
