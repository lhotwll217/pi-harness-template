import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { createScheduledPromptRunner } from "./prompt-runner";
import { createSandboxAdapter } from "./sandbox";

const root = mkdtempSync(join(tmpdir(), "pi-template-bash-timeout-"));
const home = join(root, "home");
const cwd = join(root, "task");
const faux = registerFauxProvider();
const policy = {
  filesystem: { allowedReadRoots: [root], allowedWriteRoots: [root], deniedReadRoots: [] },
  process: { allowSubprocesses: true },
  network: { mode: "deny" as const, allowedDomains: [] },
};

try {
  const probe = await createSandboxAdapter().verify(policy);
  if (probe.unavailable) {
    process.stdout.write(`SKIP — real sandbox unavailable for bash timeout check: ${probe.reason}\n`);
  } else {
    const paths = ensureHarnessWorkspace(home);
    seedFauxProviderHome(paths, faux.getModel());
    writeFileSync(join(home, "sandbox.json"), JSON.stringify(policy));
    mkdirSync(cwd);
    saveHarnessSettings(home, { permissionMode: "allow" });

    const toolResults: Array<{ text: string; isError: boolean }> = [];
    const recordLastToolResult = (context: Context): void => {
      const result = [...context.messages].reverse().find((message) => message.role === "toolResult");
      if (result?.role === "toolResult") {
        toolResults.push({
          text: result.content.map((part) => part.type === "text" ? part.text : "").join(""),
          isError: result.isError,
        });
      }
    };
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "sleep 0.2 && echo finished-in-time", timeout: 5 }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        recordLastToolResult(context);
        return fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 10", timeout: 1 }), { stopReason: "toolUse" });
      },
      (context) => {
        recordLastToolResult(context);
        return fauxAssistantMessage("done");
      },
    ]);

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
    const prompt = "Run the two commands.";
    const request: ScheduledPromptRunRequest = {
      payload: { kind: ScheduledPayloadKind.Prompt, prompt, toolsAllow: [AgentToolId.Bash] },
      cwd,
      schedule: {
        id: "schedule-timeout",
        name: "bash timeout",
        enabled: true,
        trigger: { kind: ScheduleKind.Every, everyMs: 60_000, anchorMs: 0 },
        payload: { kind: ScheduledPayloadKind.Prompt, prompt, toolsAllow: [AgentToolId.Bash] },
        cwd,
        timeoutSeconds: 60,
        revision: 1,
        createdAt: "2026-10-16T12:00:00.000Z",
        updatedAt: "2026-10-16T12:00:00.000Z",
        nextRunAt: null,
      },
      runId: "run-timeout",
      signal: new AbortController().signal,
    };
    const startedAt = Date.now();
    const result = await run(request);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.exitCode, 0);
    assert.deepEqual(toolResults, [
      { text: "finished-in-time\n", isError: false },
      { text: "Command timed out after 1 seconds", isError: true },
    ]);
    assert.ok(elapsedMs < 9_000, `the 1-second timeout stopped sleep 10 (run took ${elapsedMs} ms)`);
    process.stdout.write("ok — a sandboxed bash timeout is in seconds and reports Pi's timeout error\n");
  }
} finally {
  faux.unregister();
  rmSync(root, { recursive: true, force: true });
}
