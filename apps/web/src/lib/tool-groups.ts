import type { HarnessChatData, HarnessUIMessage } from "@/lib/chat-types";

type MessagePart = HarnessUIMessage["parts"][number];
export type ToolCall = HarnessChatData["tool"];

export type MessagePartGroup =
  | { readonly kind: "tools"; readonly id: string; readonly calls: readonly ToolCall[] }
  | { readonly kind: "part"; readonly part: MessagePart; readonly index: number };

/** Consecutive tool calls fold into one group; any other visible part ends the run. */
export function groupMessageParts(parts: HarnessUIMessage["parts"]): MessagePartGroup[] {
  const groups: MessagePartGroup[] = [];
  let run: ToolCall[] | undefined;
  parts.forEach((part, index) => {
    // A live stream opens every step with an invisible step-start part, while a reloaded
    // transcript has none, so step boundaries must not split a run.
    if (part.type === "step-start") return;
    if (part.type !== "data-tool") {
      run = undefined;
      groups.push({ kind: "part", part, index });
      return;
    }
    if (run) {
      run.push(part.data);
      return;
    }
    run = [part.data];
    groups.push({ kind: "tools", id: part.data.callId, calls: run });
  });
  return groups;
}
