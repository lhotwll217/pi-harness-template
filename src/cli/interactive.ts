import type { Model } from "@earendil-works/pi-ai";
import {
  InteractiveMode,
  initTheme,
  runPrintMode,
} from "@earendil-works/pi-coding-agent";
import { createInteractiveHarnessRuntime } from "../agent/interactive-runtime";
import type { SandboxAdapter } from "../agent/sandbox";

export interface InteractiveSessionOptions {
  home?: string;
  cwd?: string;
  model?: Model<any>;
  sandbox?: SandboxAdapter;
}

export async function createInteractiveSessionRuntime(options: InteractiveSessionOptions) {
  return await createInteractiveHarnessRuntime({
    home: options.home,
    cwd: options.cwd,
    model: options.model,
    sandbox: options.sandbox,
  });
}

export interface InteractiveTerminalCapabilities {
  stdinTTY: boolean;
  stdoutTTY: boolean;
  rawInput: boolean;
}

export function assertInteractiveTerminal(capabilities: InteractiveTerminalCapabilities): void {
  if (!capabilities.stdinTTY || !capabilities.stdoutTTY || !capabilities.rawInput) {
    throw new Error("interactive session requires an interactive terminal");
  }
}

export interface PromptSessionOptions extends InteractiveSessionOptions {
  /** The single message to send to the harness agent. */
  message: string;
  /** Emit the full JSON event stream instead of only the final text answer. */
  json?: boolean;
}

/**
 * The headless agent-conversation surface: send one prompt to the harness agent over the
 * owned runtime and identity, and stream the answer to stdout — no TUI. This is the seam
 * a script or another agent uses; the interactive session is the human one. Returns the
 * process exit code from Pi's print mode.
 */
export async function runPromptSession(options: PromptSessionOptions): Promise<number> {
  const { runtime } = await createInteractiveSessionRuntime(options);
  try {
    return await runPrintMode(runtime, {
      mode: options.json ? "json" : "text",
      initialMessage: options.message,
    });
  } finally {
    await runtime.dispose();
  }
}

export async function runInteractiveSession(options: InteractiveSessionOptions): Promise<void> {
  assertInteractiveTerminal({
    stdinTTY: Boolean(process.stdin.isTTY),
    stdoutTTY: Boolean(process.stdout.isTTY),
    rawInput: typeof process.stdin.setRawMode === "function",
  });
  const { runtime } = await createInteractiveSessionRuntime(options);
  try {
    initTheme(runtime.services.settingsManager.getTheme(), true);
    // Pi defaults to fullscreen; regular keeps the terminal's normal scrollback.
    await new InteractiveMode(runtime, { tuiMode: "regular" }).run();
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
