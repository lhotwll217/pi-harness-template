/** A Pi session id; the client mints one (a UUID) for a new chat. */
export type ChatId = string;

// Pi 1.3.0 session-manager.js assertValidSessionId (not exported from the package).
const CHAT_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
export const isChatId = (value: string): boolean => CHAT_ID.test(value);

export const CHAT_TITLE_MAX = 200;

export interface ChatSummary {
  id: ChatId;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  running: boolean;
}

export type ChatTurnStatus = "completed" | "cancelled" | "failed";

export type ChatPart =
  | { type: "text"; text: string }
  | { type: "tool"; callId: string; name: string; args: unknown; status: "running" | "done" | "error" };

export type ChatMessage =
  | { role: "user"; text: string }
  | {
    role: "assistant";
    parts: ChatPart[];
    /** `interrupted`: the turn ended with no reply, as when the daemon stopped mid-turn. */
    status: ChatTurnStatus | "interrupted" | "running";
    error?: string;
  };

export interface Chat extends ChatSummary {
  /** Set while a turn runs; cancel may name it. */
  turnId?: string;
  messages: ChatMessage[];
}

/** One NDJSON line of `POST /chats/:id/messages`; `seq` counts from 0 and the last line is `turn.finished`. */
export type ChatStreamEvent = { seq: number } & (
  | { type: "turn.started"; chatId: ChatId; turnId: string }
  | { type: "text.delta"; delta: string }
  | { type: "tool.started"; callId: string; name: string; args: unknown }
  | { type: "tool.finished"; callId: string; isError: boolean }
  | { type: "turn.finished"; status: ChatTurnStatus; error?: string }
);

export interface ChatSendInput {
  text: string;
}

export interface ChatCancelResult {
  cancelled: boolean;
}
