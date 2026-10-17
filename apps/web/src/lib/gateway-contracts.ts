export type { Chat, ChatId, ChatMessage, ChatPart, ChatStreamEvent, ChatSummary } from "@pi-template/contracts/chats";
export type {
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceFileWriteResult as WorkspaceWriteResult,
  WorkspaceTree,
} from "@pi-template/contracts/workspace-files";
export type ChatToolStatus = Extract<import("@pi-template/contracts/chats").ChatPart, { type: "tool" }>["status"];
export type ChatAssistantStatus = Extract<import("@pi-template/contracts/chats").ChatMessage, { role: "assistant" }>["status"];
export type GatewayEvent =
  | { readonly kind: "chat.changed"; readonly chatId: string }
  | { readonly kind: "workspace.changed" | "notes.changed" | "schedule.changed" | "schedule-run.changed" };
