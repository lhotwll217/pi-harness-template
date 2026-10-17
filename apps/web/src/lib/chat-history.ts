import { toolCallStatus, toolData } from "./chat-tools";
import type { ChatBootstrap, HarnessUIMessage } from "./chat-types";
import type { Chat } from "./gateway-contracts";

/**
 * The Gateway's transcript projection as `useChat` messages. Gateway messages carry no ids, so
 * each takes its position in the chat, which is stable because a transcript only grows.
 */
export function chatToBootstrap(chat: Chat): ChatBootstrap {
  const messages: HarnessUIMessage[] = chat.messages.map((message, index) => {
    const id = `${chat.id}-${index}`;
    if (message.role === "user") {
      return { id, role: "user", metadata: {}, parts: [{ type: "text", text: message.text }] };
    }
    const parts: HarnessUIMessage["parts"] = message.parts.map((part) => part.type === "text"
      ? { type: "text" as const, text: part.text }
      : { type: "data-tool" as const, id: part.callId, data: toolData(part.callId, part.name, toolCallStatus(part.status), part.args) });
    if (message.status !== "running") {
      parts.push({
        type: "data-terminal",
        data: { status: message.status, ...(message.error ? { error: message.error } : {}) },
      });
    }
    return { id, role: "assistant", metadata: {}, parts };
  });
  return {
    chatId: chat.id,
    messages,
    running: chat.running,
    ...(chat.turnId ? { turnId: chat.turnId } : {}),
  };
}

/** A chat id the Gateway has not seen yet: the client minted it and nothing is persisted. */
export function emptyBootstrap(chatId: string): ChatBootstrap {
  return { chatId, messages: [], running: false };
}
