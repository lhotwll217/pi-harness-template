import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  DatabaseQueryAction,
  ONBOARDING_VERSION,
  ensureHarnessWorkspace,
  saveHarnessSettings,
} from "@pi-template/contracts";
import { AGENT_DEFINITION, definitionIds, piTemplateIdentityPrompt } from "../agent";
import {
  assertInteractiveTerminal,
  createInteractiveSessionRuntime,
  type InteractiveGateway,
} from "./interactive";

const root = mkdtempSync(join(tmpdir(), "pi-template-interactive-"));
const home = join(root, "home");
const cwd = join(root, "task");
const protectedRoot = join(root, "private");
let runtime: Awaited<ReturnType<typeof createInteractiveSessionRuntime>> | undefined;
let fakeModelLayer: ReturnType<typeof registerFauxProvider> | undefined;

const execute = async (
  tool: { execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text?: string }> }> },
  input: Record<string, unknown>,
): Promise<unknown> => {
  const result = await tool.execute("call-1", input, undefined, undefined, undefined);
  const text = result.content.find((part) => part.type === "text")?.text;
  assert.ok(text);
  return JSON.parse(text);
};

try {
  assert.throws(
    () => assertInteractiveTerminal({ stdinTTY: false, stdoutTTY: true, rawInput: true }),
    (error) => error instanceof Error &&
      error.message === "interactive session requires an interactive terminal" &&
      !error.message.includes("\n"),
  );
  const paths = ensureHarnessWorkspace(home);
  // The session reads credentials from the harness-owned agent dir; the faux provider
  // needs a key there like any real provider would have after onboarding.
  writeFileSync(paths.piAuth, JSON.stringify({ faux: { type: "api_key", key: "faux-key" } }));
  mkdirSync(join(cwd, ".pi", "skills", "ambient"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(cwd, "AGENTS.md"), "ambient task instructions\n");
  writeFileSync(join(cwd, ".pi", "skills", "ambient", "SKILL.md"), "# Ambient\n");
  writeFileSync(join(cwd, ".pi", "prompts", "ambient.md"), "ambient prompt\n");
  writeFileSync(join(cwd, ".pi", "extensions", "ambient.ts"), "export default () => undefined;\n");

  const instructions = "# Harness instructions\n\nUse the owned runtime.\n";
  const memory = "# Memory\n\nThe Gateway is the only CLI transport.\n";
  writeFileSync(paths.workspaceInstructions, instructions);
  writeFileSync(paths.workspaceMemory, memory);
  writeFileSync(join(home, "resource-approvals.json"), JSON.stringify({ workspaceContext: true }));
  writeFileSync(paths.protectedPaths, JSON.stringify({ paths: [protectedRoot], repos: [] }));
  writeFileSync(join(home, "sandbox.json"), JSON.stringify({
    filesystem: {
      allowedReadRoots: [cwd],
      allowedWriteRoots: [cwd],
      deniedReadRoots: [paths.piAgentDir, protectedRoot],
    },
    process: { allowSubprocesses: true },
    network: { mode: "deny", allowedDomains: [] },
  }));
  saveHarnessSettings(home, { permissionMode: "ask" });

  const queries: unknown[] = [];
  const notes: unknown[] = [];
  const gateway: InteractiveGateway = {
    async queryDatabase(request) {
      queries.push(request);
      if (request.action === DatabaseQueryAction.ListTables) return [{ name: "notes", description: "Saved notes" }];
      if (request.action === DatabaseQueryAction.DescribeTable) return { description: "Saved notes", columns: [] };
      return { rows: [{ body: "through the Gateway" }], truncated: false };
    },
    async createNote(input) {
      notes.push(input);
      return {
        id: "note-interactive",
        body: input.body,
        createdAt: "2026-07-20T12:00:00.000Z",
        updatedAt: "2026-07-20T12:00:00.000Z",
      };
    },
  };
  fakeModelLayer = registerFauxProvider();
  fakeModelLayer.setResponses([fauxAssistantMessage("deterministic response")]);

  runtime = await createInteractiveSessionRuntime({
    home,
    cwd,
    gateway,
    model: fakeModelLayer.getModel(),
    sandbox: {
      async verify() { throw new Error("verification is outside the interactive seam"); },
      async execute() { throw new Error("command execution is outside this wiring test"); },
    },
  });

  assert.deepEqual(runtime.loadedResourceIds, definitionIds(AGENT_DEFINITION));
  assert.deepEqual(runtime.runtime.services.resourceLoader.getSkills().skills, []);
  assert.deepEqual(runtime.runtime.services.resourceLoader.getPrompts().prompts, []);
  const loadedExtensions = runtime.runtime.services.resourceLoader.getExtensions().extensions;
  assert.deepEqual(
    loadedExtensions.map(({ resolvedPath }) => resolvedPath),
    AGENT_DEFINITION
      .filter((entry) => entry.kind === "extension")
      .map((entry) => entry.path()),
  );
  assert.deepEqual(runtime.runtime.services.resourceLoader.getAgentsFiles().agentsFiles, [
    { path: paths.workspaceInstructions, content: instructions },
    { path: paths.workspaceMemory, content: memory },
  ]);
  assert.ok(runtime.runtime.session.systemPrompt.startsWith(piTemplateIdentityPrompt().trimEnd()));
  assert.match(runtime.runtime.session.systemPrompt, /list_tables.*describe_table.*bounded `SELECT`/s);
  assert.match(runtime.runtime.session.systemPrompt, /single State writer/);

  const activeTools = runtime.runtime.session.getActiveToolNames();
  assert.ok(activeTools.includes("read"));
  assert.ok(activeTools.includes("edit"));
  assert.ok(activeTools.includes("write"));
  assert.ok(activeTools.includes("query_database"));
  assert.ok(activeTools.includes("save_note"));
  const definedToolNames = AGENT_DEFINITION
    .filter((entry) => entry.kind === "tool")
    .map(({ name }) => name);
  assert.deepEqual(definedToolNames, ["query_database", "save_note"]);
  assert.ok(definedToolNames.every((name) => runtime?.runtime.session.getToolDefinition(name)));
  const permissionConfig = readFileSync(paths.piPermissionConfig, "utf8");
  assert.ok(permissionConfig.includes(protectedRoot));

  const queryTool = runtime.runtime.session.getToolDefinition("query_database");
  const saveTool = runtime.runtime.session.getToolDefinition("save_note");
  assert.ok(queryTool);
  assert.ok(saveTool);
  assert.deepEqual(await execute(queryTool, { action: "list_tables" }), [
    { name: "notes", description: "Saved notes" },
  ]);
  assert.deepEqual(await execute(saveTool, { body: "created interactively" }), {
    id: "note-interactive",
    body: "created interactively",
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z",
  });
  assert.deepEqual(queries, [{ action: DatabaseQueryAction.ListTables }]);
  assert.deepEqual(notes, [{ body: "created interactively" }]);

  // No session.prompt here: default tiers are deterministic and model-free
  // (docs/testing.md); live model behavior belongs to the opt-in tiers.
  const sessionFile = runtime.runtime.session.sessionFile;
  assert.ok(sessionFile);
  assert.equal(relative(join(home, "transcripts"), sessionFile).startsWith(".."), false);
  // Transcript files persist lazily on the first appended message; the provenance
  // entry is asserted from the session manager's durable entry log.
  const transcript = runtime.runtime.session.sessionManager.getEntries() as Array<Record<string, any>>;
  assert.ok(transcript.some((entry) => entry.type === "custom" &&
    entry.customType === "pi-template-provenance" &&
    entry.data?.origin === "interactive" &&
    entry.data?.caller === "interactive" &&
    entry.data?.taskDirectory === cwd &&
    entry.data?.trustPolicyVersion === ONBOARDING_VERSION));

  process.stdout.write("ok — interactive runtime uses exact resources, Gateway tools, workspace context, and owned transcripts\n");
} finally {
  if (runtime) await runtime.runtime.dispose();
  fakeModelLayer?.unregister();
  rmSync(root, { recursive: true, force: true });
}
