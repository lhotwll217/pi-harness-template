import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

const root = mkdtempSync(join(tmpdir(), "pi-template-permission-denial-"));
const home = join(root, "home");
const cwd = join(root, "task");
const faux = registerFauxProvider();

try {
  const paths = ensureHarnessWorkspace(home);
  seedFauxProviderHome(paths, faux.getModel());
  writeFileSync(join(home, "sandbox.json"), JSON.stringify({
    filesystem: { allowedReadRoots: [cwd], allowedWriteRoots: [cwd], deniedReadRoots: [] },
    process: { allowSubprocesses: true },
    network: { mode: "deny", allowedDomains: [] },
  }));
  mkdirSync(cwd);
  mkdirSync(dirname(paths.piPermissionConfig), { recursive: true });
  writeFileSync(paths.piPermissionConfig, JSON.stringify({ permission: { bash: { "rm *": "deny" } } }));
  saveHarnessSettings(home, { permissionMode: "allow" });

  let deniedResult = "";
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "rm -rf scratch" }), { stopReason: "toolUse" }),
    (context) => {
      const result = [...context.messages].reverse().find((message) => message.role === "toolResult");
      deniedResult = result?.role === "toolResult"
        ? result.content.map((part) => part.type === "text" ? part.text : "").join("")
        : "";
      return fauxAssistantMessage(`The command was refused: ${deniedResult}`);
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
  const prompt = "Remove the scratch directory.";
  const request: ScheduledPromptRunRequest = {
    payload: { kind: ScheduledPayloadKind.Prompt, prompt, toolsAllow: [AgentToolId.Bash] },
    cwd,
    schedule: {
      id: "schedule-denied",
      name: "denied bash",
      enabled: true,
      trigger: { kind: ScheduleKind.Every, everyMs: 60_000, anchorMs: 0 },
      payload: { kind: ScheduledPayloadKind.Prompt, prompt, toolsAllow: [AgentToolId.Bash] },
      cwd,
      timeoutSeconds: 30,
      revision: 1,
      createdAt: "2026-10-16T12:00:00.000Z",
      updatedAt: "2026-10-16T12:00:00.000Z",
      nextRunAt: null,
    },
    runId: "run-denied",
    signal: new AbortController().signal,
  };
  const result = await run(request);

  assert.match(deniedResult, /^\[pi-permission-system\] Denied by policy: 'bash' \(rule 'rm \*'\)/);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Denied by policy: 'bash' \(rule 'rm \*'\)/);

  process.stdout.write("ok — a denied bash call tells the agent which rule denied it\n");
} finally {
  faux.unregister();
  rmSync(root, { recursive: true, force: true });
}
