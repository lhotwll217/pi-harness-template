import type { ChatStreamEvent } from "./gateway-contracts";

export class GatewayStreamError extends Error {
  constructor(message = "The harness chat stream is invalid.") {
    super(message);
    this.name = "GatewayStreamError";
  }
}

const MAX_LINE = 1_000_000;

const isString = (value: unknown): value is string => typeof value === "string";

export function parseChatStreamEvent(value: unknown): ChatStreamEvent {
  if (!value || typeof value !== "object") throw new GatewayStreamError();
  const event = value as Record<string, unknown>;
  if (!Number.isInteger(event.seq)) throw new GatewayStreamError();
  switch (event.type) {
    case "turn.started":
      if (isString(event.chatId) && isString(event.turnId)) return event as ChatStreamEvent;
      break;
    case "text.delta":
      if (isString(event.delta)) return event as ChatStreamEvent;
      break;
    case "tool.started":
      if (isString(event.callId) && isString(event.name)) return event as ChatStreamEvent;
      break;
    case "tool.finished":
      if (isString(event.callId) && typeof event.isError === "boolean") return event as ChatStreamEvent;
      break;
    case "turn.finished":
      if (event.status === "completed" || event.status === "cancelled" || event.status === "failed") {
        if (event.error === undefined || isString(event.error)) return event as ChatStreamEvent;
      }
      break;
  }
  throw new GatewayStreamError();
}

/**
 * The Gateway's reply stream, one event per line: `seq` counts from 0, `turn.started` comes
 * first, and `turn.finished` comes last. Anything else is a broken stream, not a short reply.
 */
export async function* parseGatewayChatStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let expected = 0;
  let terminal = false;
  const parseLine = (line: string): ChatStreamEvent => {
    if (line.length > MAX_LINE) throw new GatewayStreamError();
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { throw new GatewayStreamError(); }
    const event = parseChatStreamEvent(raw);
    const first = expected === 0;
    if (terminal || event.seq !== expected++ || first !== (event.type === "turn.started")) {
      throw new GatewayStreamError("The harness chat stream is out of order.");
    }
    terminal = event.type === "turn.finished";
    return event;
  };
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    if (buffer.length > MAX_LINE && !buffer.includes("\n")) throw new GatewayStreamError();
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line) yield parseLine(line);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield parseLine(buffer.trim());
  if (!terminal) throw new GatewayStreamError("The harness chat stream ended early.");
}
