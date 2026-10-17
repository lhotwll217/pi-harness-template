import type { ChatBootstrap } from "./chat-types";
import type { ChatId, ChatSummary } from "./gateway-contracts";
import { callLocalRoute, jsonBody } from "./workspace-client";

const chatRoute = (id: ChatId): string => `/api/chats/${encodeURIComponent(id)}`;

export async function fetchChats(signal?: AbortSignal): Promise<ChatSummary[]> {
  return callLocalRoute<ChatSummary[]>("/api/chats", "The app could not list the chats.", signal ? { signal } : undefined);
}

export async function fetchChat(id: ChatId): Promise<ChatBootstrap> {
  return callLocalRoute<ChatBootstrap>(chatRoute(id), "The app could not load that chat.");
}

export async function renameChat(id: ChatId, title: string): Promise<ChatSummary> {
  return callLocalRoute<ChatSummary>(chatRoute(id), "The app could not rename that chat.", jsonBody("PATCH", { title }));
}

export async function deleteChat(id: ChatId): Promise<void> {
  await callLocalRoute<{ ok: true }>(chatRoute(id), "The app could not delete that chat.", { method: "DELETE" });
}

export async function cancelChat(id: ChatId, turnId?: string): Promise<void> {
  await callLocalRoute<{ cancelled: boolean }>(`${chatRoute(id)}/cancel`, "The app could not stop the reply.", jsonBody("POST", turnId ? { turnId } : {}));
}

export const chatMessagesRoute = (id: ChatId): string => `${chatRoute(id)}/messages`;
