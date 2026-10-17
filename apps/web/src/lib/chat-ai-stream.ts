import { createUIMessageStream, type UIMessageStreamWriter } from "ai";
import type { ChatStreamEvent } from "./gateway-contracts";
import { toolData } from "./chat-tools";
import type { HarnessChatData, HarnessUIMessage } from "./chat-types";
import { LocalGatewayError } from "./gateway-error";

export function chatEventsToUIMessageStream(events: AsyncIterable<ChatStreamEvent>) {
  return createUIMessageStream<HarnessUIMessage>({
    onError: (error) => error instanceof LocalGatewayError ? error.message : "The harness could not finish that reply.",
    async execute({ writer }) {
      await writeChatEvents(events, writer);
    },
  });
}

/** Re-encodes the Gateway's NDJSON events as the AI SDK UI message stream `useChat` reads. */
export async function writeChatEvents(
  events: AsyncIterable<ChatStreamEvent>,
  writer: UIMessageStreamWriter<HarnessUIMessage>,
): Promise<void> {
  let messageId = "assistant";
  let textPartId: string | undefined;
  let parts = 0;
  let terminal = false;
  const tools = new Map<string, HarnessChatData["tool"]>();
  const args = new Map<string, unknown>();
  const finishText = (): void => {
    if (textPartId) writer.write({ type: "text-end", id: textPartId });
    textPartId = undefined;
  };
  for await (const event of events) {
    switch (event.type) {
      case "turn.started":
        messageId = `${event.turnId}-assistant`;
        writer.write({ type: "start", messageId });
        writer.write({ type: "data-turn", id: "turn", data: { chatId: event.chatId, turnId: event.turnId }, transient: true });
        break;
      case "text.delta":
        if (!textPartId) {
          textPartId = `${messageId}-text-${parts++}`;
          writer.write({ type: "text-start", id: textPartId });
        }
        writer.write({ type: "text-delta", id: textPartId, delta: event.delta });
        break;
      case "tool.started": {
        finishText();
        const data = toolData(event.callId, event.name, "running", event.args);
        tools.set(event.callId, data);
        args.set(event.callId, event.args);
        writer.write({ type: "data-tool", id: event.callId, data });
        break;
      }
      case "tool.finished": {
        const started = tools.get(event.callId);
        const data = toolData(event.callId, started?.tool ?? "tool", event.isError ? "failed" : "completed", args.get(event.callId));
        writer.write({ type: "data-tool", id: event.callId, data });
        break;
      }
      case "turn.finished":
        finishText();
        writer.write({
          type: "data-terminal",
          id: "terminal",
          data: { status: event.status, ...(event.error ? { error: event.error } : {}) },
        });
        if (event.status === "completed") writer.write({ type: "finish", finishReason: "stop" });
        else if (event.status === "cancelled") writer.write({ type: "abort", reason: "cancelled" });
        else writer.write({ type: "error", errorText: event.error ?? "The reply did not finish." });
        terminal = true;
        break;
      default: {
        const unhandled: never = event;
        throw new Error(`Unsupported chat event ${String((unhandled as { type?: unknown }).type)}`);
      }
    }
  }
  if (!terminal) throw new Error("Chat stream ended before turn.finished");
}
