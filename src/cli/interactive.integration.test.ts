import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_TOOL_POSTURE,
  ONBOARDING_VERSION,
  ensureHarnessWorkspace,
  saveHarnessSettings,
} from "@pi-template/contracts";
import { AGENT_DEFINITION, definitionIds, piTemplateIdentityPrompt } from "../agent";
import { acknowledgeAgentDefinition } from "../../test/helpers/onboarding";
import { assertInteractiveTerminal, createInteractiveSessionRuntime } from "./interactive";

const root = mkdtempSync(join(tmpdir(), "pi-template-interactive-"));
const home = join(root, "home");
const cwd = join(root, "task");
const protectedRoot = join(root, "private");
let runtime: Awaited<ReturnType<typeof createInteractiveSessionRuntime>> | undefined;
let fakeModelLayer: ReturnType<typeof registerFauxProvider> | undefined;

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
  const staleMemory = "# Memory\n\nThe Gateway is the only CLI transport.\n";
  writeFileSync(paths.workspaceInstructions, instructions);
  writeFileSync(join(paths.workspace, "MEMORY.md"), staleMemory);
  acknowledgeAgentDefinition(paths, true);
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

  fakeModelLayer = registerFauxProvider();
  fakeModelLayer.setResponses([fauxAssistantMessage("deterministic response")]);

  runtime = await createInteractiveSessionRuntime({
    home,
    cwd,
    model: fakeModelLayer.getModel(),
    sandbox: {
      async verify() { throw new Error("verification is outside the interactive seam"); },
      async execute() { throw new Error("command execution is outside this wiring test"); },
    },
  });

  assert.deepEqual(runtime.loadedResourceIds, definitionIds(AGENT_DEFINITION));
  assert.deepEqual(runtime.runtime.services.resourceLoader.getSkills().skills.map(({ name }) => name), ["writing-for-agents"]);
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
  ]);
  assert.equal(runtime.runtime.session.systemPrompt.includes(staleMemory.trim()), false);
  assert.ok(runtime.runtime.session.systemPrompt.startsWith(piTemplateIdentityPrompt().trimEnd()));
  assert.match(runtime.runtime.session.systemPrompt, /Reach that state only by running\s+`pi-template` in bash/);

  // Pi's built-in tools from the posture, and no data tool: the agent reaches state through its CLI in bash.
  assert.deepEqual(runtime.runtime.session.getActiveToolNames(), [...DEFAULT_TOOL_POSTURE]);
  const permissionConfig = readFileSync(paths.piPermissionConfig, "utf8");
  assert.ok(permissionConfig.includes(protectedRoot));

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

  const standaloneDir = join(root, "standalone-sessions");
  const standalone = SessionManager.create(cwd, standaloneDir);
  standalone.appendMessage({ role: "user", content: "from standalone Pi", timestamp: 0 });
  standalone.appendMessage(fauxAssistantMessage("standalone reply"));
  const standaloneFile = standalone.getSessionFile()!;
  const standaloneBytes = readFileSync(standaloneFile, "utf8");
  await runtime.runtime.importFromJsonl(standaloneFile);
  const firstImport = runtime.runtime.session.sessionFile!;
  await runtime.runtime.importFromJsonl(standaloneFile);
  const secondImport = runtime.runtime.session.sessionFile!;
  const transcripts = runtime.runtime.session.sessionManager.getSessionDir();
  assert.equal(relative(join(home, "transcripts"), transcripts).startsWith(".."), false);
  assert.deepEqual([firstImport, secondImport], [
    join(transcripts, basename(standaloneFile)),
    join(transcripts, basename(standaloneFile, ".jsonl") + "-1.jsonl"),
  ]);
  assert.equal(readFileSync(firstImport, "utf8").startsWith(standaloneBytes), true);
  assert.equal(readFileSync(secondImport, "utf8").startsWith(standaloneBytes), true);

  process.stdout.write("ok — interactive runtime uses exact resources, the posture's built-in tools, workspace context, owned transcripts, and non-overwriting imports\n");
} finally {
  if (runtime) await runtime.runtime.dispose();
  fakeModelLayer?.unregister();
  rmSync(root, { recursive: true, force: true });
}
