import type { HarnessChatData, ToolCallStatus } from "./chat-types";
import type { ChatToolStatus } from "./gateway-contracts";

const wordsOf = (tool: string): string => tool.replace(/[_-]+/g, " ").trim();

export function toolName(tool: string): string {
  return wordsOf(tool) || "Tool";
}

export function toolCallStatus(status: ChatToolStatus): ToolCallStatus {
  return status === "running" ? "running" : status === "done" ? "completed" : "failed";
}

/** The command a bash call ran, or the path a file tool touched: the one argument worth a glance. */
export function toolSummary(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const { command, path } = args as { command?: unknown; path?: unknown };
  if (typeof command === "string" && command.trim()) return command.trim().split("\n", 1)[0];
  if (typeof path === "string" && path.trim()) return path.trim();
  return undefined;
}

export function toolData(callId: string, tool: string, status: ToolCallStatus, args: unknown): HarnessChatData["tool"] {
  const summary = toolSummary(args);
  return { callId, tool, status, ...(summary ? { summary } : {}) };
}
