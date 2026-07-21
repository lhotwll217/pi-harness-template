import type { Model } from "@earendil-works/pi-ai";
import {
  InteractiveMode,
  initTheme,
  runPrintMode,
} from "@earendil-works/pi-coding-agent";
import { DatabaseQueryAction } from "@pi-template/contracts";
import { createInteractiveHarnessRuntime } from "../agent/interactive-runtime";
import type { SandboxAdapter } from "../agent/sandbox";
import type { DatabaseQueryInterface } from "../agent/tools/query-database";
import type { NoteWriter } from "../agent/tools/save-note";
import type { GatewayClient } from "../gateway/client";

export type InteractiveGateway = Pick<GatewayClient, "createNote" | "queryDatabase">;

export interface InteractiveSessionOptions {
  gateway: InteractiveGateway;
  home?: string;
  cwd?: string;
  model?: Model<any>;
  sandbox?: SandboxAdapter;
}

function gatewayToolDependencies(gateway: InteractiveGateway): {
  query: DatabaseQueryInterface;
  notes: NoteWriter;
} {
  return {
    query: {
      async listTables() {
        return await gateway.queryDatabase({
          action: DatabaseQueryAction.ListTables,
        }) as Awaited<ReturnType<DatabaseQueryInterface["listTables"]>>;
      },
      async describeTable(table) {
        return await gateway.queryDatabase({
          action: DatabaseQueryAction.DescribeTable,
          table,
        }) as Awaited<ReturnType<DatabaseQueryInterface["describeTable"]>>;
      },
      async runQuery(sql) {
        return await gateway.queryDatabase({
          action: DatabaseQueryAction.Query,
          sql,
        }) as Awaited<ReturnType<DatabaseQueryInterface["runQuery"]>>;
      },
    },
    notes: {
      createNote: (input) => gateway.createNote(input),
    },
  };
}

export async function createInteractiveSessionRuntime(options: InteractiveSessionOptions) {
  const dependencies = gatewayToolDependencies(options.gateway);
  return await createInteractiveHarnessRuntime({
    home: options.home,
    cwd: options.cwd,
    query: dependencies.query,
    notes: dependencies.notes,
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
    await new InteractiveMode(runtime).run();
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
