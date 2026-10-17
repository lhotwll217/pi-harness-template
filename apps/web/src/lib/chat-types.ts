import type { UIMessage } from "ai";
import type { ChatAssistantStatus, ChatId } from "./gateway-contracts";

export type ToolCallStatus = "running" | "completed" | "failed";

export type HarnessChatData = {
  /** The turn the Gateway started, so Stop can name it. Transient: never stored on a message. */
  turn: {
    readonly chatId: ChatId;
    readonly turnId: string;
  };
  terminal: {
    readonly status: Exclude<ChatAssistantStatus, "running">;
    readonly error?: string;
  };
  tool: {
    readonly callId: string;
    readonly tool: string;
    readonly status: ToolCallStatus;
    /** The command or path the call acted on, when its arguments name one. */
    readonly summary?: string;
  };
};

export type HarnessUIMessage = UIMessage<Record<string, never>, HarnessChatData>;

export interface ChatBootstrap {
  readonly chatId: ChatId;
  readonly messages: HarnessUIMessage[];
  /** True while a turn runs that this page may not have started. */
  readonly running: boolean;
  readonly turnId?: string;
}

export type DaemonState = "ready" | "setup" | "down";

export interface AppStatus {
  readonly daemon: DaemonState;
}
