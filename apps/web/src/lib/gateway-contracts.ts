// The Gateway's chat and workspace-file wire shapes (WP21), restated as types until
// @pi-template/contracts exports them. Every app module imports them from here, so the
// switch to the contracts package is this one file.

export type ChatId = string;

export interface ChatSummary {
  readonly id: ChatId;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly running: boolean;
}

export type ChatToolStatus = "running" | "done" | "error";

export type ChatPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool"; readonly callId: string; readonly name: string; readonly args: unknown; readonly status: ChatToolStatus };

export type ChatAssistantStatus = "completed" | "cancelled" | "failed" | "interrupted" | "running";

export type ChatMessage =
  | { readonly role: "user"; readonly text: string }
  | { readonly role: "assistant"; readonly parts: readonly ChatPart[]; readonly error?: string; readonly status: ChatAssistantStatus };

export interface Chat extends ChatSummary {
  readonly turnId?: string;
  readonly messages: readonly ChatMessage[];
}

export type ChatTurnOutcome = "completed" | "cancelled" | "failed";

export type ChatStreamEvent = { readonly seq: number } & (
  | { readonly type: "turn.started"; readonly chatId: ChatId; readonly turnId: string }
  | { readonly type: "text.delta"; readonly delta: string }
  | { readonly type: "tool.started"; readonly callId: string; readonly name: string; readonly args: unknown }
  | { readonly type: "tool.finished"; readonly callId: string; readonly isError: boolean }
  | { readonly type: "turn.finished"; readonly status: ChatTurnOutcome; readonly error?: string }
);

export interface WorkspaceEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size: number;
  readonly modifiedAt: string;
}

export interface WorkspaceTree {
  readonly entries: readonly WorkspaceEntry[];
  readonly truncated: boolean;
}

export interface WorkspaceFile {
  readonly path: string;
  readonly content: string;
  readonly revision: string;
  readonly modifiedAt: string;
}

export interface WorkspaceWriteResult {
  readonly path: string;
  readonly revision: string;
  readonly modifiedAt: string;
  readonly created: boolean;
}

/** One frame of the Gateway's `/events` stream: an invalidation, never the changed data. */
export type GatewayEvent =
  | { readonly kind: "chat.changed"; readonly chatId: ChatId }
  | { readonly kind: "workspace.changed" }
  | { readonly kind: "notes.changed" }
  | { readonly kind: "schedule.changed" }
  | { readonly kind: "schedule-run.changed" };
