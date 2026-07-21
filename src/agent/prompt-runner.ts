import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  ONBOARDING_VERSION,
  harnessPaths,
  isOnboardingComplete,
  type AgentToolId,
  type OnboardingMarker,
  type ScheduleExecutionResult,
  type ScheduledPromptRunRequest,
} from "@pi-template/contracts";
import type { AgentToolDependencies } from "./agent-definition";
import { piTemplateIdentityPrompt } from "./agent-definition";
import { createHarnessSession } from "./runtime";

export interface PromptSessionFactoryInput {
  home: string;
  cwd: string;
  transcriptDir: string;
  toolsAllow: readonly AgentToolId[];
  headless: true;
  systemPromptOverride: () => string;
  provenance: {
    origin: "scheduler";
    caller: "scheduler";
    scheduleId: string;
    runId: string;
    scheduleName: string;
    trigger: string;
    taskDirectory: string;
    effectiveCapabilities: readonly AgentToolId[];
    trustPolicyVersion: number;
    approvalPolicy: "deny-when-live-approval-is-unavailable";
  };
}

export interface PromptSession {
  id: string;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  assistantText(): string;
  assistantError(): string | null;
  dispose(): Promise<void>;
}

export type PromptSessionFactory = (input: PromptSessionFactoryInput) => Promise<PromptSession>;

export interface ScheduledPromptRunnerOptions {
  home?: string;
  sessions?: PromptSessionFactory;
  resources?: AgentToolDependencies;
  readiness?: () => boolean;
}

function readMarker(home: string): OnboardingMarker | undefined {
  try {
    return JSON.parse(readFileSync(harnessPaths(home).onboardingMarker, "utf8")) as OnboardingMarker;
  } catch {
    return undefined;
  }
}

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "scheduled prompt aborted"));

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string")
    .map(({ text }) => text)
    .join("");
}

function latestAssistant(messages: readonly unknown[]): unknown {
  return [...messages].reverse().find((message) =>
    !!message && typeof message === "object" && (message as { role?: unknown }).role === "assistant");
}

function realSessionFactory(resources: AgentToolDependencies): PromptSessionFactory {
  return async (input) => {
    const manager = SessionManager.create(input.cwd, input.transcriptDir);
    manager.appendCustomEntry("pi-template-provenance", input.provenance);
    const created = await createHarnessSession({
      home: input.home,
      cwd: input.cwd,
      query: resources.query,
      notes: resources.notes,
      sessionManager: manager,
      toolsAllow: input.toolsAllow,
      headless: true,
      systemPromptOverride: input.systemPromptOverride,
    });
    if (!input.headless) throw new Error("scheduled prompt sessions must be headless");
    // Print mode has no UI context. The permission extension therefore selects its denying
    // authorizer for every policy result that would require live owner approval.
    await created.session.bindExtensions({ mode: "print" });
    return {
      id: manager.getSessionId(),
      prompt: (text) => created.session.prompt(text),
      abort: () => created.session.abort(),
      assistantText: () => messageText(latestAssistant(created.session.messages)),
      assistantError: () => {
        const message = latestAssistant(created.session.messages) as {
          stopReason?: unknown;
          errorMessage?: unknown;
        } | undefined;
        if (message?.stopReason !== "error") return null;
        return typeof message.errorMessage === "string" && message.errorMessage.trim()
          ? message.errorMessage.trim()
          : "model turn stopped with an error";
      },
      async dispose() {
        try {
          await created.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        } finally {
          created.session.dispose();
        }
      },
    };
  };
}

/** Scheduler seam: one fresh persisted, headless, capability-narrowed Pi session per occurrence. */
export function createScheduledPromptRunner(options: ScheduledPromptRunnerOptions = {}) {
  const home = harnessPaths(options.home).home;
  const readiness = options.readiness ?? (() => isOnboardingComplete(readMarker(home)));
  const sessions = options.sessions ?? (options.resources ? realSessionFactory(options.resources) : undefined);
  if (!sessions) throw new Error("scheduled prompt runner requires a Pi session factory or resource dependencies");
  const transcriptDir = join(home, "transcripts");

  return async (request: ScheduledPromptRunRequest): Promise<ScheduleExecutionResult> => {
    if (!readiness()) throw new Error("onboarding is incomplete; scheduled model work is denied");
    if (request.signal.aborted) throw abortReason(request.signal);
    mkdirSync(transcriptDir, { recursive: true });
    const toolsAllow = [...(request.payload.toolsAllow ?? [])];
    const session = await sessions({
      home,
      cwd: request.cwd,
      transcriptDir,
      toolsAllow,
      headless: true,
      systemPromptOverride: piTemplateIdentityPrompt,
      provenance: {
        origin: "scheduler",
        caller: "scheduler",
        scheduleId: request.schedule.id,
        runId: request.runId,
        scheduleName: request.schedule.name,
        trigger: request.schedule.trigger.kind,
        taskDirectory: request.cwd,
        effectiveCapabilities: toolsAllow,
        trustPolicyVersion: ONBOARDING_VERSION,
        approvalPolicy: "deny-when-live-approval-is-unavailable",
      },
    });
    if (request.signal.aborted) {
      await session.dispose();
      throw abortReason(request.signal);
    }
    const abort = (): void => { void session.abort(); };
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      const prompt = request.triggerContext === undefined
        ? request.payload.prompt
        : `${request.payload.prompt}\n\nTrigger context:\n${JSON.stringify(request.triggerContext, null, 2)}`;
      await session.prompt(prompt);
      if (request.signal.aborted) throw abortReason(request.signal);
      const error = session.assistantError();
      return {
        exitCode: error ? 1 : 0,
        stdout: session.assistantText(),
        stderr: error ?? "",
        transcriptId: session.id,
      };
    } finally {
      request.signal.removeEventListener("abort", abort);
      await session.dispose();
    }
  };
}
