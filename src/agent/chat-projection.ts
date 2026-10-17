import type { ChatMessage, ChatPart, ChatTurnStatus } from "@pi-template/contracts";

type PiMessage = { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown;
  toolCallId?: unknown; isError?: unknown };
type AssistantChatMessage = Extract<ChatMessage, { role: "assistant" }>;

const textOf = (content: unknown): string => typeof content === "string"
  ? content
  : Array.isArray(content)
  ? content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("")
  : "";

function statusOf(stopReason: unknown): ChatTurnStatus | "interrupted" {
  if (stopReason === "aborted") return "cancelled";
  if (stopReason === "error") return "failed";
  if (stopReason === "toolUse") return "interrupted";
  return "completed";
}

export function projectChat(messages: readonly unknown[], running: boolean): ChatMessage[] {
  const projected: ChatMessage[] = [];
  let turn: AssistantChatMessage | undefined;
  let lastStop: unknown;
  const close = (): void => {
    if (!turn) return;
    const status = statusOf(lastStop);
    turn.status = status;
    lastStop = undefined;
    for (const part of turn.parts) if (part.type === "tool" && part.status === "running") part.status = "error";
    turn = undefined;
  };
  for (const raw of messages as PiMessage[]) {
    if (raw?.role === "user") {
      close();
      if (projected.at(-1)?.role === "user") projected.push({ role: "assistant", parts: [], status: "interrupted" });
      projected.push({ role: "user", text: textOf(raw.content) });
      continue;
    }
    if (raw?.role !== "assistant" && raw?.role !== "toolResult") continue;
    if (!turn) {
      turn = { role: "assistant", parts: [], status: "completed" };
      projected.push(turn);
    }
    if (raw.role === "toolResult") {
      const call = turn.parts.find((part): part is Extract<ChatPart, { type: "tool" }> =>
        part.type === "tool" && part.callId === raw.toolCallId);
      if (call) call.status = raw.isError === true ? "error" : "done";
      continue;
    }
    lastStop = raw.stopReason;
    for (const part of Array.isArray(raw.content) ? raw.content : []) {
      if (part?.type === "text" && typeof part.text === "string" && part.text) {
        const previous = turn.parts.at(-1);
        if (previous?.type === "text") previous.text += part.text;
        else turn.parts.push({ type: "text", text: part.text });
      }
      if (part?.type === "toolCall") {
        turn.parts.push({ type: "tool", callId: String(part.id), name: String(part.name), args: part.arguments, status: "running" });
      }
    }
    if (raw.stopReason === "error") {
      turn.error = typeof raw.errorMessage === "string" && raw.errorMessage.trim() ? raw.errorMessage.trim() : "model turn stopped with an error";
    }
  }
  if (running) {
    if (!turn) projected.push({ role: "assistant", parts: [], status: "running" });
    else turn.status = "running";
  } else {
    close();
    if (projected.at(-1)?.role === "user") projected.push({ role: "assistant", parts: [], status: "interrupted" });
  }
  return projected;
}
