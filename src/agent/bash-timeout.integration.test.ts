import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  AgentToolId,
  ScheduleKind,
  ScheduledPayloadKind,
  ensureHarnessWorkspace,
  saveHarnessSettings,
  type ScheduledPromptRunRequest,
} from "@pi-template/contracts";
import { seedFauxProviderHome } from "../../test/helpers/faux-provider";
import { acknowledgeAgentDefinition } from "../../test/helpers/onboarding";
import { createScheduledPromptRunner } from "./prompt-runner";
import { SANDBOXED_COMMAND_TERMINATION_GRACE_MS, createSandboxAdapter } from "./sandbox";

const root = mkdtempSync(join(tmpdir(), "pi-template-bash-timeout-"));
const faux = registerFauxProvider();
const policy = {
  enabled: true,
  filesystem: { allowedReadRoots: [root], allowedWriteRoots: [root], deniedReadRoots: [] },
  process: { allowSubprocesses: true },
  network: { mode: "deny" as const, allowedDomains: [] },
};
const TURN_OVERHEAD_MS = 500;

type BashCall = { command: string; timeout?: number };
interface BashOutcome { text: string; isError: boolean; elapsedMs: number }

const uniqueSleep = (slot: number): string => `sleep ${30 + slot}.${String(process.pid).padStart(7, "0")}`;

function running(sleep: string): number {
  try {
    return execFileSync("pgrep", ["-f", sleep], { encoding: "utf8" }).trim().split("\n").length;
  } catch {
    return 0;
  }
}

function prepareHome(name: string, sandboxEnabled: boolean): { home: string; cwd: string } {
  const home = join(root, name, "home");
  const cwd = join(root, name, "task");
  const paths = ensureHarnessWorkspace(home);
  seedFauxProviderHome(paths, faux.getModel());
  acknowledgeAgentDefinition(paths);
  writeFileSync(join(home, "sandbox.json"), JSON.stringify({
    ...policy, enabled: sandboxEnabled, filesystem: { allowedReadRoots: [cwd], allowedWriteRoots: [cwd], deniedReadRoots: [] },
  }));
  mkdirSync(cwd);
  saveHarnessSettings(home, { permissionMode: "allow" });
  return { home, cwd };
}

function scheduledRun(home: string, cwd: string, runId: string, signal: AbortSignal) {
  const run = createScheduledPromptRunner({
    home,
    readiness: () => true,
    resources: {
      query: {
        async listTables() { return []; },
        async describeTable() { throw new Error("not used"); },
        async runQuery() { throw new Error("not used"); },
      },
      notes: { async createNote() { throw new Error("not used"); } },
    },
  });
  const prompt = "Run the commands.";
  const payload = { kind: ScheduledPayloadKind.Prompt, prompt, toolsAllow: [AgentToolId.Bash] } as const;
  const request: ScheduledPromptRunRequest = {
    payload,
    cwd,
    schedule: {
      id: "schedule-timeout",
      name: "bash timeout",
      enabled: true,
      trigger: { kind: ScheduleKind.Every, everyMs: 60_000, anchorMs: 0 },
      payload,
      cwd,
      timeoutSeconds: 60,
      revision: 1,
      createdAt: "2026-10-16T12:00:00.000Z",
      updatedAt: "2026-10-16T12:00:00.000Z",
      nextRunAt: null,
    },
    runId,
    signal,
  };
  return run(request);
}

const lastToolResult = (context: Context): { text: string; isError: boolean } => {
  const result = [...context.messages].reverse().find((message) => message.role === "toolResult");
  assert.ok(result?.role === "toolResult", "the agent saw a tool result");
  return { text: result.content.map((part) => part.type === "text" ? part.text : "").join(""), isError: result.isError };
};

async function runBashCalls(name: string, sandboxEnabled: boolean, calls: BashCall[]): Promise<BashOutcome[]> {
  const { home, cwd } = prepareHome(name, sandboxEnabled);
  const outcomes: BashOutcome[] = [];
  let issuedAt = 0;
  faux.setResponses([
    ...calls.map((call, index) => async (context: Context) => {
      if (index > 0) outcomes.push({ ...lastToolResult(context), elapsedMs: Date.now() - issuedAt });
      issuedAt = Date.now();
      return fauxAssistantMessage(fauxToolCall("bash", call), { stopReason: "toolUse" });
    }),
    async (context: Context) => {
      outcomes.push({ ...lastToolResult(context), elapsedMs: Date.now() - issuedAt });
      return fauxAssistantMessage("done");
    },
  ]);
  const result = await scheduledRun(home, cwd, `run-${name}`, new AbortController().signal);
  assert.equal(result.exitCode, 0);
  return outcomes;
}

async function checkTimeouts(name: string, sandboxEnabled: boolean): Promise<void> {
  const plain = uniqueSleep(1);
  const ignoresTerm = uniqueSleep(2);
  const escaped = uniqueSleep(4);
  const escapedLeader = uniqueSleep(5);
  const outcomes = await runBashCalls(name, sandboxEnabled, [
    { command: "sleep 0.2 && echo finished-in-time", timeout: 5 },
    { command: `${plain} && touch plain.done`, timeout: 0.5 },
    { command: `trap '' TERM; ${ignoresTerm} && touch ignores-term.done`, timeout: 0.5 },
    { command: `perl -e 'setpgrp(0, 0); exec @ARGV' ${escaped} & ${escapedLeader}`, timeout: 0.5 },
    { command: "echo no-limit", timeout: 0 },
    { command: "echo negative", timeout: -1 },
    { command: "echo too-long", timeout: 2_147_483.648 },
    { command: "echo longest-allowed", timeout: 2_147_483.647 },
  ]);

  assert.deepEqual(outcomes.map(({ text, isError }) => ({ text, isError })), [
    { text: "finished-in-time\n", isError: false },
    { text: "Command timed out after 0.5 seconds", isError: true },
    { text: "Command timed out after 0.5 seconds", isError: true },
    { text: "Command timed out after 0.5 seconds", isError: true },
    { text: "Invalid timeout: must be a finite number of seconds", isError: true },
    { text: "Invalid timeout: must be a finite number of seconds", isError: true },
    { text: "Invalid timeout: maximum is 2147483.647 seconds", isError: true },
    { text: "longest-allowed\n", isError: false },
  ]);
  const bound = 500 + SANDBOXED_COMMAND_TERMINATION_GRACE_MS + TURN_OVERHEAD_MS;
  for (const index of [1, 2, 3]) {
    assert.ok(outcomes[index]!.elapsedMs < bound, `call ${index} returned in ${outcomes[index]!.elapsedMs} ms (bound ${bound} ms)`);
  }
  assert.equal(running(plain), 0, "the timed-out compound command left its sleep running");
  assert.equal(running(ignoresTerm), 0, "the timed-out command that ignores SIGTERM left its sleep running");
  assert.equal(running(escapedLeader), 0, "the timed-out command left its own sleep running");
  assert.equal(running(escaped), 1, "a descendant that left the process group outlives the stop, as under Pi's runner");
  execFileSync("pkill", ["-f", escaped]);
}

async function checkAbort(name: string, sandboxEnabled: boolean): Promise<void> {
  const { home, cwd } = prepareHome(name, sandboxEnabled);
  const sleep = uniqueSleep(3);
  const controller = new AbortController();
  let abortedAt = 0;
  faux.setResponses([
    async () => {
      void (async () => {
        while (running(sleep) === 0) await new Promise((resolve) => setTimeout(resolve, 50));
        abortedAt = Date.now();
        controller.abort(new Error("schedule aborted"));
      })();
      return fauxAssistantMessage(fauxToolCall("bash", { command: `${sleep} && touch aborted.done` }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("not reached"),
  ]);
  await assert.rejects(scheduledRun(home, cwd, `run-${name}`, controller.signal), /^Error: schedule aborted$/);
  const settledMs = Date.now() - abortedAt;
  const bound = SANDBOXED_COMMAND_TERMINATION_GRACE_MS + TURN_OVERHEAD_MS;
  assert.ok(settledMs < bound, `the aborted run settled ${settledMs} ms after the abort (bound ${bound} ms)`);
  assert.equal(running(sleep), 0, "the aborted compound command left its sleep running");
  const transcriptDir = join(home, "transcripts");
  const transcript = readdirSync(transcriptDir, { recursive: true, encoding: "utf8" }).find((file) => file.endsWith(".jsonl"));
  assert.ok(transcript, "the aborted run wrote a transcript");
  const toolResults = readFileSync(join(transcriptDir, transcript), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { message?: { role?: string; content?: Array<{ text?: string }> } })
    .filter(({ message }) => message?.role === "toolResult")
    .map(({ message }) => message!.content!.map((part) => part.text ?? "").join(""));
  assert.deepEqual(toolResults, ["Command aborted"]);
}

try {
  await checkTimeouts("unsandboxed", false);
  process.stdout.write("ok — unsandboxed bash: timeouts in seconds stop the whole command, and Pi's timeout bounds apply\n");
  await checkAbort("unsandboxed-abort", false);
  process.stdout.write("ok — unsandboxed bash: an abort stops the whole command and reports Pi's abort error\n");
  const probe = await createSandboxAdapter().verify(policy);
  if (probe.unavailable) {
    process.stdout.write(`SKIP — real sandbox unavailable for bash timeout check: ${probe.reason}\n`);
  } else {
    await checkTimeouts("sandboxed", true);
    process.stdout.write("ok — sandboxed bash: timeouts in seconds stop the whole command, and Pi's timeout bounds apply\n");
    await checkAbort("sandboxed-abort", true);
    process.stdout.write("ok — sandboxed bash: an abort stops the whole command and reports Pi's abort error\n");
  }
} finally {
  faux.unregister();
  rmSync(root, { recursive: true, force: true });
}
