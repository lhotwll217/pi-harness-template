const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request must be an object");
  return value as Record<string, unknown>;
};

/**
 * `useChat` posts the whole message list; the harness owns the transcript, so only the text of
 * the newest user message travels on.
 */
export function parseChatApiRequest(value: unknown): { text: string } {
  const input = asRecord(value);
  if (!Array.isArray(input.messages)) throw new Error("messages are required");
  const message = asRecord([...input.messages].reverse().find((candidate) => {
    try { return asRecord(candidate).role === "user"; } catch { return false; }
  }));
  if (!Array.isArray(message.parts)) throw new Error("message parts are required");
  let text = "";
  for (const rawPart of message.parts) {
    const part = asRecord(rawPart);
    if (part.type === "text" && typeof part.text === "string") text += part.text;
  }
  if (!text.trim()) throw new Error("a message needs text");
  return { text };
}
