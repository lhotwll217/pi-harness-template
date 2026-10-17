import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthAuth } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { harnessPaths } from "@pi-template/contracts";
import { AGENT_DEFINITION, definitionIds } from "../agent";
import { passingOnboardingDependencies } from "../../test/helpers/onboarding";
import { onboard, type CliOnboardingDependencies } from "./onboard";

function anthropicLoginRuntime(oauth: OAuthAuth): NonNullable<CliOnboardingDependencies["createModelRuntime"]> {
  return async (options) => {
    const runtime = await ModelRuntime.create(options);
    const builtin = runtime.getProvider("anthropic")!;
    runtime.registerNativeProvider({
      id: builtin.id,
      name: builtin.name,
      auth: { oauth },
      getModels: () => builtin.getModels(),
      stream: (model, context, streamOptions) => builtin.stream(model, context, streamOptions),
      streamSimple: (model, context, streamOptions) => builtin.streamSimple(model, context, streamOptions),
    });
    return runtime;
  };
}

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
  assert.doesNotMatch(transcript, /tool:/);
  assert.match(transcript, /extension:permission-system.*Apply the reviewed Pi permission policy/s);
  assert.match(transcript, /^ {2}Skill policy: all-workspace$/m);
  assert.match(transcript, /^ {2}Permission mode: allow$/m);
  assert.match(transcript, /^ {2}Sandbox: off, bash runs with your permissions \(rerun onboarding with --sandbox to turn it on\)$/m);
  assert.ok(transcript.includes(`  Workspace file to approve: ${importedPaths.workspaceInstructions}\n`));
  assert.doesNotMatch(transcript, /MEMORY/);
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
    acknowledgedDefinitionIds: definitionIds(AGENT_DEFINITION),
    workspaceContext: true,
  });
  const reviewedSettings = JSON.parse(readFileSync(importedPaths.settings, "utf8"));
  assert.equal(reviewedSettings.permissionMode, "allow");
  assert.deepEqual(reviewedSettings.skillPolicy, { mode: "all-workspace", allowlist: [] });
  assert.equal(reviewedSettings.alwaysOn, "declined");
  const reviewedSandbox = JSON.parse(readFileSync(join(importedHome, "sandbox.json"), "utf8"));
  assert.deepEqual(reviewedSandbox.filesystem.allowedReadRoots, [process.cwd()]);
  assert.deepEqual(reviewedSandbox.filesystem.allowedWriteRoots, [process.cwd()]);
  assert.deepEqual(reviewedSandbox.network, { mode: "deny", allowedDomains: [] });
  assert.equal(reviewedSandbox.enabled, false);
  assert.equal(existsSync(join(importedHome, "sandbox-verification.json")), false, "an off sandbox is not probed");
  assert.equal(readFileSync(standaloneAuth, "utf8"), authBytes);
  assert.equal(readFileSync(standaloneSettings, "utf8"), settingsBytes);
  assert.equal(readFileSync(standaloneModels, "utf8"), modelsBytes);

  {
    const bomDir = join(root, "standalone-pi-bom");
    mkdirSync(bomDir, { recursive: true });
    writeFileSync(join(bomDir, "auth.json"), `\uFEFF${authBytes}`);
    writeFileSync(join(bomDir, "settings.json"), settingsBytes);
    writeFileSync(join(bomDir, "models.json"), modelsBytes);
    const bomHome = join(root, "imported-bom-home");
    const bomDependencies = passingOnboardingDependencies(bomHome);
    delete bomDependencies.authVerifier;
    const bomResult = await onboard([], {
      ...bomDependencies,
      interactiveIO: scriptedInteraction(["", "", ""]).io,
      standalonePiAuthPath: join(bomDir, "auth.json"),
    });
    assert.equal(bomResult.complete, true);
    assert.deepEqual(JSON.parse(readFileSync(harnessPaths(bomHome).piAuth, "utf8")), JSON.parse(authBytes));
  }

  const deterministicLogin = anthropicLoginRuntime({
    name: "Deterministic OAuth",
    async login() {
      return { type: "oauth", access: "canned-access", refresh: "canned-refresh", expires: 4_102_444_800_000 };
    },
    async refresh(credential) { return credential; },
    async toAuth(credential) { return { apiKey: credential.access }; },
  });
  {
    const loginHome = join(root, "login-home");
    mkdirSync(harnessPaths(loginHome).piAgentDir, { recursive: true });
    writeFileSync(harnessPaths(loginHome).piAuth, JSON.stringify({ openai: { type: "api_key", key: "kept-key" } }));
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
      createModelRuntime: deterministicLogin,
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
    assert.deepEqual(JSON.parse(readFileSync(harnessPaths(loginHome).piAuth, "utf8")), {
      openai: { type: "api_key", key: "kept-key" },
      anthropic: {
        type: "oauth",
        access: "canned-access",
        refresh: "canned-refresh",
        expires: 4_102_444_800_000,
      },
    });

    const emptyStandaloneDir = join(root, "empty-standalone");
    mkdirSync(emptyStandaloneDir);
    const declinedImportInteraction = scriptedInteraction(["n", "anthropic", "", ""]);
    const declinedImport = await onboard([], {
      ...passingOnboardingDependencies(join(root, "declined-empty-import-home")),
      interactiveIO: declinedImportInteraction.io,
      createModelRuntime: deterministicLogin,
      standalonePiAuthPath: join(emptyStandaloneDir, "auth.json"),
    });
    assert.equal(declinedImport.complete, true);
    assert.match(declinedImportInteraction.questions()[0] ?? "", /standalone Pi/);
    assert.equal(declinedImportInteraction.questions()[1], "Authentication choice: ");
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
  assert.equal(customInteraction.questions()[5], "Permission mode [allow/ask/read-only]: ");
  assert.equal(customInteraction.questions()[6], "Approve workspace AGENTS.md? [Y/n] ");
  assert.equal(customInteraction.questions()[7], "Daemon service [declined/installed]: ");
  assert.deepEqual(JSON.parse(readFileSync(harnessPaths(customHome).protectedPaths, "utf8")), {
    paths: ["/sensitive"],
    repos: [],
  });
  assert.equal(JSON.parse(readFileSync(harnessPaths(customHome).settings, "utf8")).permissionMode, "ask");
  assert.equal(JSON.parse(readFileSync(join(customHome, "resource-approvals.json"), "utf8")).workspaceContext, false);

  const customFiles = ["settings.json", "protected_paths.json", "resource-approvals.json", "sandbox.json"];
  const recordedFiles = (home: string) => customFiles.map((file) => JSON.parse(readFileSync(join(home, file), "utf8")));
  const beforeCustomRerun = recordedFiles(customHome);
  const customRerun = scriptedInteraction(["", "", ""]);
  assert.equal((await onboard([], {
    ...passingOnboardingDependencies(customHome),
    interactiveIO: customRerun.io,
    standalonePiAuthPath: standaloneAuth,
  })).complete, true);
  assert.equal(customRerun.questions()[1], "Protected paths (comma-separated, none to clear) [/sensitive]: ");
  assert.match(customRerun.transcript(), /^ {2}Permission mode: ask$/m);
  assert.deepEqual(recordedFiles(customHome), beforeCustomRerun);

  const customDependencies = (io: CliOnboardingDependencies["interactiveIO"]): CliOnboardingDependencies => ({
    ...passingOnboardingDependencies(customHome), interactiveIO: io, standalonePiAuthPath: standaloneAuth,
  });
  const customProtectedPath = harnessPaths(customHome).protectedPaths;
  const damagedProtected = '{"paths":["/sensitive"],}\n';
  const protectedProblem = `protected paths are not valid JSON at ${customProtectedPath}`;
  writeFileSync(customProtectedPath, damagedProtected);
  const blankOverDamagedPaths = scriptedInteraction(["", ""]);
  await assert.rejects(onboard([], customDependencies(blankOverDamagedPaths.io)), {
    name: "CliUsageError",
    message: `${protectedProblem}; enter the protected paths, or none`,
  });
  assert.equal(blankOverDamagedPaths.questions()[1], "Protected paths (comma-separated, none for none; the recorded list is damaged): ");
  assert.equal(readFileSync(customProtectedPath, "utf8"), damagedProtected);
  const replacedPaths = scriptedInteraction(["", "/sensitive", ""]);
  assert.equal((await onboard([], customDependencies(replacedPaths.io))).complete, true);
  assert.match(replacedPaths.transcript(), new RegExp(`^ {2}Damaged recorded file, replaced by these answers: ${protectedProblem}$`, "m"));
  assert.deepEqual(recordedFiles(customHome), beforeCustomRerun);

  const customSettingsPath = harnessPaths(customHome).settings;
  const damagedSettings = '{"permissionMode":"ask",\n';
  const settingsProblem = `settings are not valid JSON at ${customSettingsPath}`;
  writeFileSync(customSettingsPath, damagedSettings);
  const blankOverDamagedSettings = scriptedInteraction(["", "", ""]);
  await assert.rejects(onboard([], customDependencies(blankOverDamagedSettings.io)), {
    name: "CliUsageError",
    message: `${settingsProblem}; answer one of allow, ask, read-only`,
  });
  assert.match(blankOverDamagedSettings.transcript(), new RegExp(`^${settingsProblem}; choose the answers it recorded again\\.$`, "m"));
  assert.equal(blankOverDamagedSettings.questions()[2], "Permission mode, required (allow/ask/read-only): ");
  assert.equal(readFileSync(customSettingsPath, "utf8"), damagedSettings);
  const blankServiceOverDamagedSettings = scriptedInteraction(["", "", "ask", ""]);
  await assert.rejects(onboard([], customDependencies(blankServiceOverDamagedSettings.io)), {
    name: "CliUsageError",
    message: `${settingsProblem}; answer one of declined, installed`,
  });
  assert.equal(blankServiceOverDamagedSettings.questions()[3], "Daemon service, required (declined/installed): ");
  assert.equal(readFileSync(customSettingsPath, "utf8"), damagedSettings);
  const replacedSettings = scriptedInteraction(["", "", "ask", "declined", ""]);
  assert.equal((await onboard([], customDependencies(replacedSettings.io))).complete, true);
  assert.match(replacedSettings.transcript(), new RegExp(`^ {2}Damaged recorded file, replaced by these answers: ${settingsProblem}$`, "m"));
  assert.match(replacedSettings.transcript(), /^ {2}Permission mode: ask$/m);
  assert.match(replacedSettings.transcript(), /^ {2}Service: declined$/m);
  assert.equal(JSON.parse(readFileSync(customSettingsPath, "utf8")).permissionMode, "ask");
  assert.equal(JSON.parse(readFileSync(customSettingsPath, "utf8")).alwaysOn, "declined");

  const approvals = (home: string) => JSON.parse(readFileSync(join(home, "resource-approvals.json"), "utf8")).workspaceContext;
  for (const [home, recorded, prompt] of [
    [importedHome, true, "Approve workspace AGENTS.md? [Y/n] "],
    [customHome, false, "Approve workspace AGENTS.md? [y/N] "],
  ] as const) {
    assert.equal(approvals(home), recorded);
    const blankConsent = scriptedInteraction(["", "", "n", "", "y", "", "", ""]);
    assert.equal((await onboard([], {
      ...passingOnboardingDependencies(home),
      interactiveIO: blankConsent.io,
      standalonePiAuthPath: standaloneAuth,
    })).complete, true);
    assert.equal(blankConsent.questions()[6], prompt);
    assert.equal(approvals(home), recorded, "a blank consent answer keeps the recorded approval");
  }

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
    "--protected-path", "/flags-private",
    "--sandbox",
  ], flagsDependencies);
  assert.equal(flagsResult.complete, true);
  const flagsSandbox = () => JSON.parse(readFileSync(join(flagsHome, "sandbox.json"), "utf8"));
  assert.equal(flagsSandbox().enabled, true);
  assert.equal(JSON.parse(readFileSync(join(flagsHome, "sandbox-verification.json"), "utf8")).ok, true);

  const flagFiles = () => [
    "settings.json", "protected_paths.json", "resource-approvals.json", "sandbox.json", "pi/settings.json",
  ].map((file) => JSON.parse(readFileSync(join(flagsHome, file), "utf8")));
  const beforeRerun = flagFiles();
  assert.equal((await onboard(["--non-interactive"], flagsDependencies)).complete, true);
  assert.deepEqual(flagFiles(), beforeRerun);

  assert.equal((await onboard(["--non-interactive", "--permission", "ask"], flagsDependencies)).complete, true);
  const [settingsAfter, ...restAfter] = flagFiles();
  const [settingsBefore, ...restBefore] = beforeRerun;
  assert.deepEqual(settingsAfter, { ...settingsBefore, permissionMode: "ask" });
  assert.deepEqual(restAfter, restBefore);

  const flagsProtectedPath = harnessPaths(flagsHome).protectedPaths;
  for (const damaged of ['{"paths":["/flags-private"],}\n', '{"paths":"/flags-private","repos":[]}\n']) {
    writeFileSync(flagsProtectedPath, damaged);
    const problem = damaged.includes(",}")
      ? `protected paths are not valid JSON at ${flagsProtectedPath}`
      : `protected paths must list paths and repos as strings at ${flagsProtectedPath}`;
    await assert.rejects(onboard(["--non-interactive"], flagsDependencies), {
      name: "CliUsageError",
      message: `${problem}; fix it, or rerun with --protected-path to replace it`,
    });
    assert.equal(readFileSync(flagsProtectedPath, "utf8"), damaged);
  }
  assert.equal((await onboard(["--non-interactive", "--protected-path", "/flags-private"], flagsDependencies)).complete, true);
  assert.deepEqual(flagFiles(), [settingsAfter, ...restBefore]);

  const flagsSandboxPath = join(flagsHome, "sandbox.json");
  const verificationBytes = readFileSync(join(flagsHome, "sandbox-verification.json"), "utf8");
  const { process: _process, enabled: _enabled, ...legacyWithoutProcess } = flagsSandbox();
  const damagedSandboxes = [
    readFileSync(flagsSandboxPath, "utf8").replace(/\}\s*$/, ",}\n"),
    JSON.stringify(legacyWithoutProcess),
    JSON.stringify({ enabled: true, filesystem: {}, process: { allowSubprocesses: true }, network: {} }),
    JSON.stringify({ ...flagsSandbox(), network: { mode: "open", allowedDomains: [] } }),
    JSON.stringify({ ...flagsSandbox(), enabled: "yes" }),
    JSON.stringify({ ...flagsSandbox(), filesystem: { ...flagsSandbox().filesystem, allowedWriteRoots: "/" } }),
    JSON.stringify({ ...flagsSandbox(), process: { allowSubprocesses: "true" } }),
  ];
  for (const damaged of damagedSandboxes) {
    writeFileSync(flagsSandboxPath, damaged);
    const stopped = {
      name: "CliUsageError",
      message: `sandbox policy is invalid under ${flagsHome}; fix it, or rerun with --sandbox or --sandbox-off to replace it`,
    };
    await assert.rejects(onboard(["--non-interactive"], flagsDependencies), stopped);
    const untouched = scriptedInteraction([]);
    await assert.rejects(onboard([], { ...flagsDependencies, interactiveIO: untouched.io }), stopped);
    assert.deepEqual(untouched.questions(), []);
    assert.equal(readFileSync(flagsSandboxPath, "utf8"), damaged);
    assert.equal(readFileSync(join(flagsHome, "sandbox-verification.json"), "utf8"), verificationBytes);
  }

  assert.equal((await onboard(["--non-interactive", "--sandbox-off"], flagsDependencies)).complete, true);
  assert.equal(flagsSandbox().enabled, false);
  assert.equal(existsSync(join(flagsHome, "sandbox-verification.json")), false);

  const flagsSettingsPath = harnessPaths(flagsHome).settings;
  writeFileSync(flagsSettingsPath, JSON.stringify({ ...JSON.parse(readFileSync(flagsSettingsPath, "utf8")), permissionMode: "bogus" }));
  await assert.rejects(onboard(["--non-interactive"], flagsDependencies), {
    name: "CliUsageError",
    message: `settings record an invalid permission mode "bogus" at ${flagsSettingsPath}; fix it, or rerun with --permission to replace it`,
  });
  assert.equal(JSON.parse(readFileSync(flagsSettingsPath, "utf8")).permissionMode, "bogus");
  assert.equal((await onboard(["--non-interactive", "--permission", "ask"], flagsDependencies)).complete, true);
  assert.equal(JSON.parse(readFileSync(flagsSettingsPath, "utf8")).permissionMode, "ask");
  await assert.rejects(onboard(["--non-interactive", "--sandbox", "--sandbox-off"], flagsDependencies), {
    name: "CliUsageError",
    message: "choose one of --sandbox or --sandbox-off",
  });
  assert.deepEqual(flagsModel, { provider: "fixture-provider", model: "explicit-model" });
  assert.deepEqual(JSON.parse(readFileSync(harnessPaths(flagsHome).piSettings, "utf8")), {
    defaultProvider: "fixture-provider",
    defaultModel: "explicit-model",
    defaultThinkingLevel: "high",
    enabledModels: ["fixture-provider/imported-model", "fixture-provider/explicit-model"],
  });
  assert.equal(readFileSync(standaloneSettings, "utf8"), settingsBytes);

  const importedDefaultHome = join(root, "imported-default-home");
  assert.equal((await onboard([
    "--non-interactive", "--auth-file", standaloneAuth, "--service", "declined", "--acknowledge-resources",
  ], passingOnboardingDependencies(importedDefaultHome))).complete, true);
  assert.equal(JSON.parse(readFileSync(harnessPaths(importedDefaultHome).piSettings, "utf8")).defaultModel, "imported-model");
  assert.equal(JSON.parse(readFileSync(harnessPaths(importedDefaultHome).settings, "utf8")).permissionMode, "allow");

  const importedDefaultDependencies = passingOnboardingDependencies(importedDefaultHome);
  const skillPolicyAfter = async (args: string[]) => {
    assert.equal((await onboard(["--non-interactive", "--acknowledge-resources", ...args], importedDefaultDependencies)).complete, true);
    return JSON.parse(readFileSync(harnessPaths(importedDefaultHome).settings, "utf8")).skillPolicy;
  };
  assert.deepEqual(await skillPolicyAfter(["--skill", "mine", "--skill", "theirs"]), { mode: "allowlist", allowlist: ["mine", "theirs"] });
  assert.deepEqual(await skillPolicyAfter([]), { mode: "allowlist", allowlist: ["mine", "theirs"] });
  assert.deepEqual(await skillPolicyAfter(["--workspace-skills", "all"]), { mode: "all-workspace", allowlist: [] });

  // A resource answer on an acknowledged home applies without re-acknowledging the unchanged definition.
  const approvalsPath = harnessPaths(importedDefaultHome).resourceApprovals;
  const currentIds = definitionIds(AGENT_DEFINITION);
  assert.equal((await onboard(["--non-interactive", "--approve-workspace-context"], importedDefaultDependencies)).complete, true);
  assert.deepEqual(JSON.parse(readFileSync(approvalsPath, "utf8")), { acknowledgedDefinitionIds: currentIds, workspaceContext: true });
  assert.equal((await onboard(["--non-interactive", "--workspace-skills", "bundled"], importedDefaultDependencies)).complete, true);
  assert.deepEqual(JSON.parse(readFileSync(harnessPaths(importedDefaultHome).settings, "utf8")).skillPolicy, { mode: "bundled", allowlist: [] });
  assert.equal((await onboard(["--non-interactive", "--skill", "mine"], importedDefaultDependencies)).complete, true);
  assert.deepEqual(JSON.parse(readFileSync(harnessPaths(importedDefaultHome).settings, "utf8")).skillPolicy, { mode: "allowlist", allowlist: ["mine"] });
  writeFileSync(approvalsPath, JSON.stringify({
    acknowledgedDefinitionIds: currentIds.filter((id) => id !== "skill:writing-for-agents"),
    workspaceContext: false,
  }));
  await assert.rejects(onboard(["--non-interactive", "--skill", "mine"], importedDefaultDependencies), {
    name: "CliUsageError",
    message: /^--skill needs --acknowledge-resources: /,
  });
  await assert.rejects(onboard(["--non-interactive", "--approve-workspace-context", "--skill", "mine"], importedDefaultDependencies), {
    name: "CliUsageError",
    message: "--approve-workspace-context and --skill need --acknowledge-resources: the agent definition gained entries the resource review did not acknowledge: skill:writing-for-agents; " +
      "review them with `pi-template onboard`, or accept them with `pi-template onboard --non-interactive --acknowledge-resources`",
  });
  await assert.rejects(onboard(["--non-interactive"], importedDefaultDependencies), {
    name: "OnboardingStageError",
    message: "resources: the agent definition gained entries the resource review did not acknowledge: skill:writing-for-agents; " +
      "review them with `pi-template onboard`, or accept them with `pi-template onboard --non-interactive --acknowledge-resources`",
  });
  assert.equal((await onboard(["--non-interactive", "--acknowledge-resources"], importedDefaultDependencies)).complete, true);
  assert.deepEqual(JSON.parse(readFileSync(approvalsPath, "utf8")).acknowledgedDefinitionIds, currentIds);

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

  const browserlessMethods = [
    { id: "device_code", label: "Device code login (headless)" },
    { id: "copy_code", label: "Copy code login (headless)" },
  ];
  for (const browserless of browserlessMethods) {
    let chosenLoginMethod: string | undefined;
    const methodChoosingLogin = anthropicLoginRuntime({
      name: "Faux Method Provider",
      async login(interaction) {
        chosenLoginMethod = await interaction.prompt({
          type: "select",
          message: "Select login method:",
          options: [{ id: "browser", label: "Browser login (default)" }, browserless],
        });
        if (chosenLoginMethod === "copy_code") {
          await interaction.prompt({ type: "manual_code", message: "Paste the code Anthropic shows after you sign in:" });
        }
        return { type: "oauth", access: "device-access", refresh: "device-refresh", expires: 4_102_444_800_000 };
      },
      async refresh(credential) { return credential; },
      async toAuth(credential) { return { apiKey: credential.access }; },
    });
    const deviceHome = join(root, `${browserless.id}-home`);
    const deviceInteraction = scriptedInteraction(
      browserless.id === "copy_code" ? ["anthropic", "code#state", "", ""] : ["anthropic", "", ""],
    );
    const deviceDependencies = passingOnboardingDependencies(deviceHome);
    delete deviceDependencies.authVerifier;
    deviceDependencies.modelVerifier = () => true;
    const deviceResult = await onboard(["--no-browser"], {
      ...deviceDependencies,
      interactiveIO: deviceInteraction.io,
      createModelRuntime: methodChoosingLogin,
      standalonePiAuthPath: join(root, "absent-standalone-device", "auth.json"),
    });
    assert.equal(deviceResult.complete, true);
    assert.equal(chosenLoginMethod, browserless.id, `--no-browser selects ${browserless.id} login`);
    assert.ok(deviceInteraction.transcript().includes(`→ ${browserless.label} (--no-browser)`));
    // The method was auto-chosen: only the provider pick was asked, never a method "Selection:".
    assert.ok(!deviceInteraction.questions().includes("Selection: "),
      "the browserless method is chosen without asking");
    if (browserless.id === "copy_code") {
      assert.ok(deviceInteraction.questions().includes("Paste the code Anthropic shows after you sign in: "));
    }
  }

  const forbiddenTerm = ["owner", "operator"].join("-");
  const forbiddenOccurrences = ["src", "test"].flatMap(filesBelow).filter((path) =>
    readFileSync(path, "utf8").toLowerCase().includes(forbiddenTerm),
  );
  assert.deepEqual(forbiddenOccurrences, []);

  process.stdout.write("ok — consolidated onboarding imports, authenticates, customizes, routes --no-browser to device-code or copy-code, and honors explicit flags\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
