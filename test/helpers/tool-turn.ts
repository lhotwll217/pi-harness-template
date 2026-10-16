import type { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { runPromptSession, type InteractiveGateway, type InteractiveSessionOptions } from "../../src/cli/interactive";

const unusedGateway: InteractiveGateway = {
  async queryDatabase() { throw new Error("not used"); },
  async createNote() { throw new Error("not used"); },
};

/**
 * Run one prompt in which the faux model calls one tool, and return the text the tool gave
 * back to the model.
 */
export async function toolTurn(
  faux: ReturnType<typeof registerFauxProvider>,
  session: Omit<InteractiveSessionOptions, "gateway" | "model">,
  tool: string,
  args: Parameters<typeof fauxToolCall>[1],
): Promise<string> {
  let toolResult = "";
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" }),
    (context) => {
      const result = [...context.messages].reverse().find((message) => message.role === "toolResult");
      toolResult = result?.role === "toolResult"
        ? result.content.map((part) => part.type === "text" ? part.text : "").join("")
        : "";
      return fauxAssistantMessage("done");
    },
  ]);
  const write = process.stdout.write;
  process.stdout.write = ((_chunk: unknown, encoding?: unknown, callback?: unknown) => {
    (typeof encoding === "function" ? encoding : callback as (() => void) | undefined)?.();
    return true;
  }) as typeof process.stdout.write;
  try {
    const exitCode = await runPromptSession({
      ...session,
      gateway: unusedGateway,
      model: faux.getModel(),
      message: `Call ${tool}`,
    });
    if (exitCode !== 0) throw new Error(`prompt session exited ${exitCode}`);
  } finally {
    process.stdout.write = write;
  }
  return toolResult;
}
