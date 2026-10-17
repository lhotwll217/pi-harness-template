import { once } from "node:events";
import type { ChatStreamEvent } from "@pi-template/contracts";
import type { GatewayClient } from "../gateway/client";

async function write(text: string): Promise<void> {
  if (!process.stdout.write(text)) await once(process.stdout, "drain");
}

/**
 * `pi-template prompt --chat <id>`: one turn in a Gateway chat, streamed as it arrives. Text mode
 * prints the reply; `json` prints the harness's NDJSON chat events. Ctrl-C cancels the turn, which
 * keeps the partial reply. Exits 0 when the turn completes and 1 when it fails or is cancelled.
 */
export async function runChatPrompt(client: GatewayClient, options: { chatId: string; message: string; json: boolean }): Promise<number> {
  const events = await client.sendChat(options.chatId, options.message);
  let turnId: string | undefined;
  const cancel = (): void => { void client.cancelChat(options.chatId, turnId).catch(() => undefined); };
  process.once("SIGINT", cancel);
  let finished: Extract<ChatStreamEvent, { type: "turn.finished" }> | undefined;
  try {
    for await (const event of events) {
      if (event.type === "turn.started") turnId = event.turnId;
      if (event.type === "turn.finished") finished = event;
      if (options.json) await write(`${JSON.stringify(event)}\n`);
      else if (event.type === "text.delta") await write(event.delta);
    }
  } finally {
    process.removeListener("SIGINT", cancel);
  }
  if (!options.json) await write("\n");
  if (finished?.status === "completed") return 0;
  const error = finished?.status === "cancelled" ? "the chat turn was cancelled"
    : finished?.status === "failed" ? `the chat turn failed: ${finished.error ?? "no reason given"}`
    : "the chat turn ended without finishing";
  process.stderr.write(`${JSON.stringify({ error })}\n`);
  return 1;
}
