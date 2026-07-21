import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProvider, unregisterOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { harnessPaths } from "@pi-template/contracts";
import { passingOnboardingDependencies } from "../../test/helpers/onboarding";
import { onboard } from "./onboard";

const root = mkdtempSync(join(tmpdir(), "pi-template-cli-onboard-"));

function scriptedInteraction(scriptedAnswers: string[]): {
  io: { question(prompt: string): Promise<string>; write(value: string): void };
  questions: () => string[];
  transcript: () => string;
} {
  const questions: string[] = [];
  let output = "";
  return {
    io: {
      async question(prompt) {
        questions.push(prompt);
        output += prompt;
        const answer = scriptedAnswers.shift();
        if (answer === undefined) throw new Error(`missing scripted answer for ${prompt}`);
        output += `${answer}\n`;
        return answer;
      },
      write(value) { output += value; },
    },
    questions: () => questions,
    transcript: () => output,
  };
}

function filesBelow(path: string): string[] {
  return readdirSync(path).flatMap((entry) => {
    const child = join(path, entry);
    return statSync(child).isDirectory() ? filesBelow(child) : [child];
  });
}

try {
  const standaloneDir = join(root, "standalone-pi");
  const standaloneAuth = join(standaloneDir, "auth.json");
  const standaloneSettings = join(standaloneDir, "settings.json");
  const standaloneModels = join(standaloneDir, "models.json");
  mkdirSync(standaloneDir, { recursive: true });
  const authBytes = '{"fixture-provider":{"type":"api_key","key":"standalone-secret"}}\n';
  const settingsBytes = '{"defaultProvider":"fixture-provider","defaultModel":"imported-model","defaultThinkingLevel":"high","enabledModels":["fixture-provider/imported-model"],"theme":"dark"}\n';
  const modelsBytes = '{"providers":{"fixture-provider":{"baseUrl":"https://example.invalid","apiKey":"standalone-secret","api":"openai-completions","models":[{"id":"imported-model"}]}}}\n';
  writeFileSync(standaloneAuth, authBytes);
  writeFileSync(standaloneSettings, settingsBytes);
  writeFileSync(standaloneModels, modelsBytes);

  const importedHome = join(root, "imported-home");
  const interaction = scriptedInteraction(["", "", ""]);
  let verifiedModel: { provider: string; model: string } | undefined;
  const dependencies = passingOnboardingDependencies(importedHome);
  delete dependencies.authVerifier;
  dependencies.modelVerifier = (_paths, selection) => {
    verifiedModel = selection;
    return true;
  };
  const result = await onboard([], {
    ...dependencies,
    interactiveIO: interaction.io,
    standalonePiAuthPath: standaloneAuth,
  });

  assert.equal(result.complete, true);
  assert.equal(interaction.questions().length, 3);
  assert.match(interaction.questions()[0] ?? "", /standalone Pi/i);
  assert.equal(interaction.questions()[1], "Protected paths (comma-separated, blank for none): ");
  assert.equal(interaction.questions()[2], "Accept this setup? [Y/n] ");
  assert.deepEqual(verifiedModel, { provider: "fixture-provider", model: "imported-model" });

  const transcript = interaction.transcript();
  const importedPaths = harnessPaths(importedHome);
  assert.match(transcript, /fixture-provider/);
  assert.match(transcript, /imported-model/);
  assert.match(transcript, /prompt:identity.*Define the Pi Harness Template agent/s);
  assert.match(transcript, /tool:query_database.*Read-only progressive disclosure/s);
  assert.match(transcript, /tool:save_note.*Persist the notes worked example/s);
  assert.match(transcript, /extension:permission-system.*Apply the reviewed Pi permission policy/s);
  assert.match(transcript, /Skill policy: bundled/);
  assert.match(transcript, /Permission mode: read-only/);
  assert.ok(transcript.includes(importedPaths.workspaceInstructions));
  assert.ok(transcript.includes(importedPaths.workspaceMemory));
  assert.ok(transcript.includes(`Sandbox allowed read roots: ${process.cwd()}`));
  assert.ok(transcript.includes(`Sandbox allowed write roots: ${process.cwd()}`));
  assert.match(transcript, /Network: deny/);
  assert.match(transcript, /Service: declined/);

  assert.deepEqual(JSON.parse(readFileSync(importedPaths.piAuth, "utf8")), JSON.parse(authBytes));
  assert.deepEqual(JSON.parse(readFileSync(importedPaths.piSettings, "utf8")), {
    defaultProvider: "fixture-provider",
    defaultModel: "imported-model",
    defaultThinkingLevel: "high",
    enabledModels: ["fixture-provider/imported-model"],
  });
  assert.deepEqual(JSON.parse(readFileSync(importedPaths.piModels, "utf8")), JSON.parse(modelsBytes));
  assert.deepEqual(JSON.parse(readFileSync(importedPaths.protectedPaths, "utf8")), { paths: [], repos: [] });
  assert.deepEqual(JSON.parse(readFileSync(join(importedHome, "resource-approvals.json"), "utf8")), {
    workspaceContext: true,
  });
  const reviewedSettings = JSON.parse(readFileSync(importedPaths.settings, "utf8"));
  assert.equal(reviewedSettings.permissionMode, "read-only");
  assert.deepEqual(reviewedSettings.skillPolicy, { mode: "bundled", allowlist: [] });
  assert.equal(reviewedSettings.alwaysOn, "declined");
  const reviewedSandbox = JSON.parse(readFileSync(join(importedHome, "sandbox.json"), "utf8"));
  assert.deepEqual(reviewedSandbox.filesystem.allowedReadRoots, [process.cwd()]);
  assert.deepEqual(reviewedSandbox.filesystem.allowedWriteRoots, [process.cwd()]);
  assert.deepEqual(reviewedSandbox.network, { mode: "deny", allowedDomains: [] });
  assert.equal(readFileSync(standaloneAuth, "utf8"), authBytes);
  assert.equal(readFileSync(standaloneSettings, "utf8"), settingsBytes);
  assert.equal(readFileSync(standaloneModels, "utf8"), modelsBytes);

  registerOAuthProvider({
    id: "anthropic",
    name: "Deterministic OAuth",
    async login() {
      return { access: "canned-access", refresh: "canned-refresh", expires: 4_102_444_800_000 };
    },
    async refreshToken(credentials) { return credentials; },
    getApiKey(credentials) { return credentials.access; },
  });
  try {
    const loginHome = join(root, "login-home");
    const loginInteraction = scriptedInteraction(["anthropic", "", ""]);
    let loginModel: { provider: string; model: string } | undefined;
    const loginDependencies = passingOnboardingDependencies(loginHome);
    delete loginDependencies.authVerifier;
    loginDependencies.modelVerifier = (_paths, selection) => {
      loginModel = selection;
      return true;
    };
    const loggedIn = await onboard([], {
      ...loginDependencies,
      interactiveIO: loginInteraction.io,
      standalonePiAuthPath: join(root, "missing-standalone", "auth.json"),
    });

    assert.equal(loggedIn.complete, true);
    assert.equal(loginInteraction.questions().length, 3);
    assert.equal(loginInteraction.questions()[0], "Authentication choice: ");
    assert.equal(loginInteraction.questions()[1], "Protected paths (comma-separated, blank for none): ");
    assert.equal(loginInteraction.questions()[2], "Accept this setup? [Y/n] ");
    assert.equal(loginModel?.provider, "anthropic");
    assert.ok(loginModel?.model);
    assert.match(loginInteraction.transcript(), /Deterministic OAuth/);
    assert.doesNotMatch(loginInteraction.transcript(), /Copy existing standalone Pi setup/);
    assert.deepEqual(JSON.parse(readFileSync(harnessPaths(loginHome).piAuth, "utf8")).anthropic, {
      type: "oauth",
      access: "canned-access",
      refresh: "canned-refresh",
      expires: 4_102_444_800_000,
    });

    const emptyStandaloneDir = join(root, "empty-standalone");
    mkdirSync(emptyStandaloneDir);
    const declinedImportInteraction = scriptedInteraction(["n", "anthropic", "", ""]);
    const declinedImport = await onboard([], {
      ...passingOnboardingDependencies(join(root, "declined-empty-import-home")),
      interactiveIO: declinedImportInteraction.io,
      standalonePiAuthPath: join(emptyStandaloneDir, "auth.json"),
    });
    assert.equal(declinedImport.complete, true);
    assert.match(declinedImportInteraction.questions()[0] ?? "", /standalone Pi/);
    assert.equal(declinedImportInteraction.questions()[1], "Authentication choice: ");
  } finally {
    unregisterOAuthProvider("anthropic");
  }

  const customHome = join(root, "custom-home");
  const customInteraction = scriptedInteraction([
    "", "/sensitive", "n", "", "y", "ask", "n", "declined",
  ]);
  const customized = await onboard([], {
    ...passingOnboardingDependencies(customHome),
    interactiveIO: customInteraction.io,
    standalonePiAuthPath: standaloneAuth,
  });
  assert.equal(customized.complete, true);
  assert.equal(customInteraction.questions().length, 8);
  assert.equal(customInteraction.questions()[3], "Model id [imported-model]: ");
  assert.equal(customInteraction.questions()[4], "Acknowledge this exact agent definition? [y/N] ");
  assert.equal(customInteraction.questions()[5], "Permission mode [read-only/ask/allow]: ");
  assert.equal(customInteraction.questions()[6], "Approve workspace AGENTS.md and MEMORY.md? [y/N] ");
  assert.equal(customInteraction.questions()[7], "Daemon service [declined/installed]: ");
  assert.deepEqual(JSON.parse(readFileSync(harnessPaths(customHome).protectedPaths, "utf8")), {
    paths: ["/sensitive"],
    repos: [],
  });
  assert.equal(JSON.parse(readFileSync(harnessPaths(customHome).settings, "utf8")).permissionMode, "ask");
  assert.equal(JSON.parse(readFileSync(join(customHome, "resource-approvals.json"), "utf8")).workspaceContext, false);

  const flagsHome = join(root, "flags-home");
  let flagsModel: { provider: string; model: string } | undefined;
  const flagsDependencies = passingOnboardingDependencies(flagsHome);
  flagsDependencies.modelVerifier = (_paths, selection) => {
    flagsModel = selection;
    return true;
  };
  const flagsResult = await onboard([
    "--non-interactive",
    "--auth-file", standaloneAuth,
    "--provider", "fixture-provider",
    "--model", "explicit-model",
    "--permission", "read-only",
    "--service", "declined",
    "--acknowledge-resources",
  ], flagsDependencies);
  assert.equal(flagsResult.complete, true);
  assert.deepEqual(flagsModel, { provider: "fixture-provider", model: "explicit-model" });
  assert.deepEqual(JSON.parse(readFileSync(harnessPaths(flagsHome).piSettings, "utf8")), {
    defaultProvider: "fixture-provider",
    defaultModel: "explicit-model",
    defaultThinkingLevel: "high",
    enabledModels: ["fixture-provider/imported-model", "fixture-provider/explicit-model"],
  });
  assert.equal(readFileSync(standaloneSettings, "utf8"), settingsBytes);

  const manualHome = join(root, "manual-home");
  const manualInteraction = scriptedInteraction([
    "manual", "custom-provider", "manual-secret", "custom-model", "", "",
  ]);
  let manualModel: { provider: string; model: string } | undefined;
  const manualDependencies = passingOnboardingDependencies(manualHome);
  delete manualDependencies.authVerifier;
  manualDependencies.modelVerifier = (_paths, selection) => {
    manualModel = selection;
    return true;
  };
  const manual = await onboard([], {
    ...manualDependencies,
    interactiveIO: manualInteraction.io,
    standalonePiAuthPath: join(root, "absent-pi", "auth.json"),
  });
  assert.equal(manual.complete, true);
  assert.match(manualInteraction.transcript(), /enter an API key manually/);
  assert.deepEqual(manualModel, { provider: "custom-provider", model: "custom-model" });
  assert.deepEqual(JSON.parse(readFileSync(harnessPaths(manualHome).piAuth, "utf8"))["custom-provider"], {
    type: "api_key",
    key: "manual-secret",
  });
  assert.equal(readFileSync(standaloneAuth, "utf8"), authBytes);
  assert.equal(readFileSync(standaloneSettings, "utf8"), settingsBytes);
  assert.equal(readFileSync(standaloneModels, "utf8"), modelsBytes);

  // Agent-operated login: --no-browser routes the provider's method choice to device-code
  // without a human picking, so an agent driving the terminal never hits the browser
  // callback. The fake provider offers both methods and records which the flow chose.
  let chosenLoginMethod: string | undefined;
  registerOAuthProvider({
    id: "anthropic",
    name: "Faux Method Provider",
    async login(options) {
      chosenLoginMethod = await options.onSelect({
        message: "Select login method:",
        options: [
          { id: "browser", label: "Browser login (default)" },
          { id: "device_code", label: "Device code login (headless)" },
        ],
      });
      return { access: "device-access", refresh: "device-refresh", expires: 4_102_444_800_000 };
    },
    async refreshToken(credentials) { return credentials; },
    getApiKey(credentials) { return credentials.access; },
  });
  try {
    const deviceHome = join(root, "device-home");
    const deviceInteraction = scriptedInteraction(["anthropic", "", ""]); // provider, protected paths, accept
    const deviceDependencies = passingOnboardingDependencies(deviceHome);
    delete deviceDependencies.authVerifier;
    deviceDependencies.modelVerifier = () => true;
    const deviceResult = await onboard(["--no-browser"], {
      ...deviceDependencies,
      interactiveIO: deviceInteraction.io,
      standalonePiAuthPath: join(root, "absent-standalone-device", "auth.json"),
    });
    assert.equal(deviceResult.complete, true);
    assert.equal(chosenLoginMethod, "device_code", "--no-browser selects device-code login");
    assert.match(deviceInteraction.transcript(), /Device code login.*--no-browser/s);
    // The method was auto-chosen: only the provider pick was asked, never a method "Selection:".
    assert.ok(!deviceInteraction.questions().includes("Selection: "),
      "device-code method is chosen without asking");
  } finally {
    unregisterOAuthProvider("anthropic");
  }

  const forbiddenTerm = ["owner", "operator"].join("-");
  const forbiddenOccurrences = ["src", "test"].flatMap(filesBelow).filter((path) =>
    readFileSync(path, "utf8").toLowerCase().includes(forbiddenTerm),
  );
  assert.deepEqual(forbiddenOccurrences, []);

  process.stdout.write("ok — consolidated onboarding imports, authenticates, customizes, routes --no-browser to device-code, and honors explicit flags\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
