import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { harnessPaths, savePermissionMode } from "@pi-template/contracts";
import { passingOnboardingDependencies } from "../../test/helpers/onboarding";
import { runPromptSession, type InteractiveGateway } from "./interactive";
import { onboard } from "./onboard";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-template-first-turn-")));
const home = join(root, "home");
const faux = registerFauxProvider();
const secretName = "PI_TEMPLATE_FIRST_TURN_SECRET";
process.env[secretName] = "daemon-only-secret";

const gateway: InteractiveGateway = {
  async queryDatabase() { throw new Error("not used"); },
  async createNote() { throw new Error("not used"); },
};

async function bashTurn(command: string, cwd: string): Promise<string> {
  let toolResult = "";
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }),
    (context) => {
      const result = [...context.messages].reverse().find((message) => message.role === "toolResult");
      toolResult = result?.role === "toolResult"
        ? result.content.map((part) => part.type === "text" ? part.text : "").join("")
        : "";
      return fauxAssistantMessage("done");
    },
  ]);
  assert.equal(await withSilencedStdout(() =>
    runPromptSession({ gateway, home, cwd, model: faux.getModel(), message: `Run ${command}` })), 0);
  return toolResult;
}

async function withSilencedStdout<T>(run: () => Promise<T>): Promise<T> {
  const write = process.stdout.write;
  process.stdout.write = ((_chunk: unknown, encoding?: unknown, callback?: unknown) => {
    (typeof encoding === "function" ? encoding : callback as (() => void) | undefined)?.();
    return true;
  }) as typeof process.stdout.write;
  try {
    return await run();
  } finally {
    process.stdout.write = write;
  }
}

try {
  const model = faux.getModel();
  const standaloneDir = join(root, "standalone-pi");
  mkdirSync(standaloneDir);
  writeFileSync(join(standaloneDir, "auth.json"), JSON.stringify({ [model.provider]: { type: "api_key", key: "faux-key" } }));
  writeFileSync(join(standaloneDir, "settings.json"), JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id }));
  writeFileSync(join(standaloneDir, "models.json"), JSON.stringify({ providers: {
    [model.provider]: { api: model.api, baseUrl: "http://127.0.0.1:1", apiKey: "faux-key", models: [model] },
  } }));

  let output = "";
  const answers = ["", "", ""];
  const onboarded = await onboard([], {
    ...passingOnboardingDependencies(home),
    interactiveIO: {
      async question(prompt) { output += prompt; return answers.shift() ?? ""; },
      write(value) { output += value; },
    },
    standalonePiAuthPath: join(standaloneDir, "auth.json"),
  });
  assert.equal(onboarded.complete, true);
  assert.match(output, /^ {2}Permission mode: allow$/m);
  assert.match(output, /^ {2}Sandbox: off, bash runs with your permissions/m);

  const paths = harnessPaths(home);
  assert.equal(JSON.parse(readFileSync(join(home, "sandbox.json"), "utf8")).enabled, false);
  assert.equal(await bashTurn("ls", paths.workspace), "AGENTS.md\nMEMORY.md\nartifacts\nskills\n");
  assert.equal(await bashTurn(`printenv ${secretName} || echo unset`, paths.workspace), "unset\n");

  rmSync(join(home, "sandbox.json"));
  assert.equal(await bashTurn("pwd", paths.workspace), `${paths.workspace}\n`);

  savePermissionMode(home, "read-only");
  // Permission system 39 withholds a tool its policy denies outright.
  assert.equal(await bashTurn("ls", paths.workspace), "Tool bash not found");

  process.stdout.write("ok — a fresh home's agent runs bash on its first turn, with or without a sandbox policy, and read-only still denies it\n");
} finally {
  faux.unregister();
  delete process.env[secretName];
  rmSync(root, { recursive: true, force: true });
}
