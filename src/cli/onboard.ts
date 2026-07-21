import readline from "node:readline/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getOAuthProvider, getOAuthProviderInfoList, type OAuthSelectPrompt } from "@earendil-works/pi-ai/oauth";
import { AuthStorage, getAgentDir, ModelRegistry, type AuthCredential } from "@earendil-works/pi-coding-agent";
import { harnessPaths, isPermissionMode, type PermissionMode, type SkillPolicy } from "@pi-template/contracts";
import {
  AGENT_DEFINITION,
  definitionIds,
  agentDefinitionSummary,
  runOnboarding,
  type OnboardingAnswers,
  type OnboardingDependencies,
  type OnboardingResult,
} from "../agent";
import { CliUsageError } from "./args";

interface OnboardFlags {
  nonInteractive: boolean;
  noBrowser: boolean;
  acknowledgeResources: boolean;
  approveWorkspaceContext: boolean;
  values: Map<string, string>;
  repeated: Map<string, string[]>;
}

export interface InteractiveOnboardingIO {
  question(prompt: string): Promise<string>;
  write(value: string): void;
  /** Resolve a pending question with an empty line — used when an OAuth browser
   * callback wins the race and the manual-paste prompt would otherwise swallow
   * the next typed line. */
  flushPendingQuestion?(): void;
}

export interface CliOnboardingDependencies extends OnboardingDependencies {
  interactiveIO?: InteractiveOnboardingIO;
  standalonePiAuthPath?: string;
}

interface PiImportSource {
  agentDir: string;
  authPath: string;
  settingsPath: string;
  modelsPath: string;
}

interface InteractiveAuthSelection {
  answer: NonNullable<OnboardingAnswers["auth"]>;
  provider: string;
  model: string;
}

type ReviewedSetup = OnboardingAnswers & {
  auth: NonNullable<OnboardingAnswers["auth"]>;
  model: NonNullable<OnboardingAnswers["model"]>;
  resources: NonNullable<OnboardingAnswers["resources"]>;
  capabilities: NonNullable<OnboardingAnswers["capabilities"]>;
  protectedPaths: NonNullable<OnboardingAnswers["protectedPaths"]>;
  sandbox: NonNullable<OnboardingAnswers["sandbox"]>;
  service: NonNullable<OnboardingAnswers["service"]>;
};

const REPEATED = new Set([
  "--protected-path", "--protected-repo", "--sandbox-read", "--sandbox-write", "--network-domain", "--skill",
]);
const VALUES = new Set([
  "--provider", "--api-key", "--auth-file", "--model", "--permission", "--workspace-skills",
  "--service", "--executable", "--working-directory",
]);

function parseFlags(argv: readonly string[]): OnboardFlags {
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  let nonInteractive = false;
  // Agent-operated / no-local-browser onboarding routes login to Pi's device-code flow
  // instead of the localhost browser callback (docs/onboarding.md#agent-operated-onboarding).
  let noBrowser = process.env.PI_TEMPLATE_NO_BROWSER === "1";
  let acknowledgeResources = false;
  let approveWorkspaceContext = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--no-browser") { noBrowser = true; continue; }
    if (flag === "--non-interactive") { nonInteractive = true; continue; }
    if (flag === "--acknowledge-resources") { acknowledgeResources = true; continue; }
    if (flag === "--approve-workspace-context") { approveWorkspaceContext = true; continue; }
    if (!VALUES.has(flag) && !REPEATED.has(flag)) throw new CliUsageError(`unknown onboard option: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new CliUsageError(`${flag} needs a value`);
    if (REPEATED.has(flag)) repeated.set(flag, [...(repeated.get(flag) ?? []), value]);
    else if (values.has(flag)) throw new CliUsageError(`${flag} may be provided only once`);
    else values.set(flag, value);
  }
  return { nonInteractive, noBrowser, acknowledgeResources, approveWorkspaceContext, values, repeated };
}

function skillPolicy(mode: string, allowlist: string[]): SkillPolicy {
  if (mode === "bundled") return { mode: "bundled", allowlist: [] };
  if (mode === "all") return { mode: "all-workspace", allowlist: [] };
  if (mode === "allowlist" && allowlist.length > 0) return { mode: "allowlist", allowlist };
  throw new CliUsageError("--workspace-skills must be bundled, all, or allowlist with at least one --skill");
}

function piImportSource(authPath: string): PiImportSource {
  const resolvedAuthPath = resolve(authPath);
  const agentDir = dirname(resolvedAuthPath);
  return {
    agentDir,
    authPath: resolvedAuthPath,
    settingsPath: join(agentDir, "settings.json"),
    modelsPath: join(agentDir, "models.json"),
  };
}

function importAnswer(source: PiImportSource): NonNullable<OnboardingAnswers["auth"]> {
  return {
    kind: "import",
    sourceAuthPath: source.authPath,
    sourceSettingsPath: source.settingsPath,
    sourceModelsPath: source.modelsPath,
  };
}

function answersFromFlags(flags: OnboardFlags): OnboardingAnswers {
  const provider = flags.values.get("--provider");
  const authFile = flags.values.get("--auth-file");
  const apiKey = flags.values.get("--api-key");
  if (authFile !== undefined && apiKey !== undefined) {
    throw new CliUsageError("provide exactly one of --api-key or --auth-file");
  }
  if (apiKey !== undefined && !provider) throw new CliUsageError("--provider is required with --api-key");
  const model = flags.values.get("--model");
  if (model !== undefined && !provider) throw new CliUsageError("--provider is required with --model");
  const permission = flags.values.get("--permission");
  if (permission !== undefined && !isPermissionMode(permission)) {
    throw new CliUsageError("--permission must be ask, allow, or read-only");
  }
  const service = flags.values.get("--service");
  if (service !== undefined && service !== "installed" && service !== "declined") {
    throw new CliUsageError("--service must be installed or declined");
  }
  const serviceExecutable = flags.values.get("--executable");
  const serviceWorkingDirectory = flags.values.get("--working-directory");
  if (service === "installed" && (!serviceExecutable || !serviceWorkingDirectory)) {
    throw new CliUsageError("--service installed requires --executable and --working-directory");
  }
  const readRoots = (flags.repeated.get("--sandbox-read") ?? [process.cwd()]).map((path) => resolve(path));
  const writeRoots = (flags.repeated.get("--sandbox-write") ?? [process.cwd()]).map((path) => resolve(path));
  const domains = flags.repeated.get("--network-domain") ?? [];
  return {
    auth: authFile
      ? importAnswer(piImportSource(authFile))
      : apiKey && provider
        ? { kind: "credential", provider, credential: { type: "api_key", key: apiKey } }
        : undefined,
    model: provider && model ? { provider, model } : undefined,
    resources: flags.acknowledgeResources ? {
      acknowledgedDefinitionIds: definitionIds(AGENT_DEFINITION),
      skillPolicy: skillPolicy(flags.values.get("--workspace-skills") ?? "bundled", flags.repeated.get("--skill") ?? []),
      approveWorkspaceContext: flags.approveWorkspaceContext,
    } : undefined,
    capabilities: permission && isPermissionMode(permission) ? { permissionMode: permission } : undefined,
    protectedPaths: {
      paths: (flags.repeated.get("--protected-path") ?? []).map((path) => resolve(path)),
      repos: flags.repeated.get("--protected-repo") ?? [],
    },
    sandbox: {
      policy: {
        filesystem: { allowedReadRoots: readRoots, allowedWriteRoots: writeRoots, deniedReadRoots: [] },
        process: { allowSubprocesses: true },
        network: { mode: domains.length ? "allowlist" : "deny", allowedDomains: domains },
      },
    },
    service: service === undefined
      ? undefined
      : service === "declined"
      ? { choice: "declined" }
      : {
          choice: "installed",
          executable: resolve(serviceExecutable!),
          workingDirectory: resolve(serviceWorkingDirectory!),
        },
  };
}

const isAffirmativeAnswer = (value: string): boolean => ["y", "yes"].includes(value.trim().toLowerCase());
const isNegativeAnswer = (value: string): boolean => ["n", "no"].includes(value.trim().toLowerCase());
const isDefaultYesAnswer = (value: string): boolean => !value.trim() || isAffirmativeAnswer(value);

function importableProviders(sourceAuthPath: string): string[] {
  const storage = AuthStorage.create(sourceAuthPath);
  return storage.list().filter((provider) => {
    const credential = storage.get(provider);
    if (credential?.type === "api_key") return Boolean(credential.key.trim());
    return credential?.type === "oauth" &&
      Boolean(credential.access.trim()) &&
      Boolean(credential.refresh.trim()) &&
      Number.isFinite(credential.expires);
  });
}

function importedModelSelection(source: PiImportSource): { provider: string; model: string } | undefined {
  try {
    const settings = JSON.parse(readFileSync(source.settingsPath, "utf8")) as Record<string, unknown>;
    const provider = typeof settings.defaultProvider === "string" ? settings.defaultProvider.trim() : "";
    const model = typeof settings.defaultModel === "string" ? settings.defaultModel.trim() : "";
    return provider && model ? { provider, model } : undefined;
  } catch {
    return undefined;
  }
}

function importedProvider(providers: readonly string[], preferredProvider: string | undefined): string {
  return preferredProvider && providers.includes(preferredProvider) ? preferredProvider : providers[0]!;
}

function selectAvailableModel(
  provider: string,
  storage: AuthStorage,
  modelsPath?: string,
  preferredModel?: string,
): string | undefined {
  const registry = modelsPath && existsSync(modelsPath)
    ? ModelRegistry.create(storage, modelsPath)
    : ModelRegistry.inMemory(storage);
  const models = registry.getAvailable().filter((model) => model.provider === provider);
  return models.find((model) => model.id === preferredModel)?.id ?? models[0]?.id;
}

const looksLikeDeviceCodeOption = (option: { id: string; label: string }): boolean =>
  /device/i.test(option.id) || /device/i.test(option.label);

async function loginCredential(
  io: InteractiveOnboardingIO,
  providerId: string,
  preferDeviceCode: boolean,
): Promise<AuthCredential> {
  const provider = getOAuthProvider(providerId);
  if (!provider) throw new Error(`unknown OAuth provider: ${providerId}`);
  let manualInputPending = false;
  const select = async (prompt: OAuthSelectPrompt): Promise<string | undefined> => {
    // Headless / agent-operated login: skip the human choice and take the device-code
    // method (no localhost browser callback) when the provider offers one.
    if (preferDeviceCode) {
      const deviceOption = prompt.options.find(looksLikeDeviceCodeOption);
      if (deviceOption) {
        io.write(`${prompt.message}\n  → ${deviceOption.label} (--no-browser)\n`);
        return deviceOption.id;
      }
    }
    io.write(`${prompt.message}\n`);
    prompt.options.forEach((option, index) => io.write(`  ${index + 1}. ${option.label}\n`));
    const answer = (await io.question("Selection: ")).trim();
    if (!answer) return undefined;
    const numeric = /^\d+$/.test(answer) ? Number(answer) : undefined;
    return numeric === undefined ? prompt.options.find(({ id }) => id === answer)?.id : prompt.options[numeric - 1]?.id;
  };
  const loginOptions: Parameters<typeof provider.login>[0] = {
    onAuth: ({ url, instructions }) => {
      io.write(`Open ${url}\n`);
      if (instructions) io.write(`${instructions}\n`);
    },
    onDeviceCode: ({ userCode, verificationUri }) => {
      io.write(`Open ${verificationUri} and enter code ${userCode}\n`);
    },
    onPrompt: async ({ message, placeholder, allowEmpty }) => {
      const answer = await io.question(`${message}${placeholder ? ` (${placeholder})` : ""}: `);
      if (!allowEmpty && !answer.trim()) throw new Error(`${message} is required`);
      return answer;
    },
    onProgress: (message) => io.write(`${message}\n`),
    onManualCodeInput: async () => {
      manualInputPending = true;
      try {
        return await io.question("Paste the redirect URL (or press Enter once the browser finishes): ");
      } finally {
        manualInputPending = false;
      }
    },
    onSelect: select,
  };
  try {
    const credentials = await provider.login(loginOptions);
    return { type: "oauth", ...credentials };
  } finally {
    // The provider races the browser callback against manual paste and does not cancel
    // the loser: whenever the flow ends (callback won, or the exchange failed) with the
    // paste prompt still pending, it would swallow the next typed line. Resolve it with
    // an empty line so the question queue is clear.
    if (manualInputPending) io.flushPendingQuestion?.();
  }
}

async function freshAuthentication(
  io: InteractiveOnboardingIO,
  preferDeviceCode: boolean,
): Promise<InteractiveAuthSelection> {
  const providers = getOAuthProviderInfoList().filter(({ available }) => available);
  io.write("Built-in provider login:\n");
  providers.forEach((provider, index) => {
    io.write(`  ${index + 1}. ${provider.name} (${provider.id})\n`);
  });
  io.write(`  ${providers.length + 1}. enter an API key manually\n`);
  const rawChoice = (await io.question("Authentication choice: ")).trim();
  const numericChoice = /^\d+$/.test(rawChoice) ? Number(rawChoice) : undefined;
  const manual = rawChoice.toLowerCase() === "manual" || numericChoice === providers.length + 1;
  if (manual) {
    const provider = (await io.question("Provider id: ")).trim();
    const apiKey = (await io.question("Provider API key: ")).trim();
    if (!provider || !apiKey) throw new CliUsageError("provider id and API key are required");
    const credential: AuthCredential = { type: "api_key", key: apiKey };
    const model = selectAvailableModel(provider, AuthStorage.inMemory({ [provider]: credential })) ??
      (await io.question("Model id: ")).trim();
    if (!model) throw new CliUsageError("model id is required");
    return { answer: { kind: "credential", provider, credential }, provider, model };
  }
  const selected = numericChoice === undefined
    ? providers.find(({ id }) => id === rawChoice)
    : providers[numericChoice - 1];
  if (!selected) throw new CliUsageError("select a listed provider or enter an API key manually");
  // A failed login attempt (expired or already-consumed code, state mismatch, network)
  // must never kill the resumable flow: report one line and re-offer the menu.
  try {
    const credential = await loginCredential(io, selected.id, preferDeviceCode);
    const model = selectAvailableModel(selected.id, AuthStorage.inMemory({ [selected.id]: credential }));
    if (!model) throw new Error(`no authenticated model is available for provider ${selected.id}`);
    return {
      answer: { kind: "credential", provider: selected.id, credential },
      provider: selected.id,
      model,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.write(`\nLogin did not complete: ${message.split("\n")[0]}\nChoose again, or press Ctrl-C to exit.\n`);
    return await freshAuthentication(io, preferDeviceCode);
  }
}

async function interactiveAuth(
  io: InteractiveOnboardingIO,
  source: PiImportSource | undefined,
  preferDeviceCode: boolean,
): Promise<InteractiveAuthSelection> {
  if (source && existsSync(source.agentDir)) {
    const importChoice = await io.question(`Copy existing standalone Pi setup from ${source.agentDir}? [Y/n] `);
    if (isDefaultYesAnswer(importChoice)) {
      if (!existsSync(source.authPath)) throw new CliUsageError("the standalone Pi setup has no authorization file to import");
      const providers = importableProviders(source.authPath);
      if (providers.length === 0) throw new CliUsageError("the standalone Pi setup has no usable authorizations to import");
      const importedSelection = importedModelSelection(source);
      const provider = importedProvider(providers, importedSelection?.provider);
      const model = selectAvailableModel(
        provider,
        AuthStorage.create(source.authPath),
        source.modelsPath,
        importedSelection?.provider === provider ? importedSelection.model : undefined,
      );
      if (!model) throw new CliUsageError("the standalone Pi setup has no model default for the imported provider");
      return { answer: importAnswer(source), provider, model };
    }
    if (!isNegativeAnswer(importChoice)) throw new CliUsageError("answer y or n to the standalone Pi import offer");
  }
  return await freshAuthentication(io, preferDeviceCode);
}

function protectedPaths(raw: string): string[] {
  return raw.split(",").map((path) => path.trim()).filter(Boolean).map((path) => resolve(path));
}

function reviewDefaults(
  home: string | undefined,
  auth: InteractiveAuthSelection,
  protectedPathValues: string[],
): ReviewedSetup {
  const paths = harnessPaths(home);
  const root = resolve(process.cwd());
  return {
    auth: auth.answer,
    model: { provider: auth.provider, model: auth.model },
    resources: {
      acknowledgedDefinitionIds: definitionIds(AGENT_DEFINITION),
      skillPolicy: { mode: "bundled", allowlist: [] },
      approveWorkspaceContext: true,
    },
    capabilities: { permissionMode: "read-only" },
    protectedPaths: { paths: protectedPathValues, repos: [] },
    sandbox: {
      policy: {
        filesystem: { allowedReadRoots: [root], allowedWriteRoots: [root], deniedReadRoots: [] },
        process: { allowSubprocesses: true },
        network: { mode: "deny", allowedDomains: [] },
      },
    },
    service: { choice: "declined" },
  };
}

function writeReview(io: InteractiveOnboardingIO, answers: ReviewedSetup, home: string | undefined): void {
  const paths = harnessPaths(home);
  io.write("Setup review:\n");
  io.write(`  Provider: ${answers.model.provider}\n`);
  io.write(`  Model: ${answers.model.model}\n`);
  io.write("  Agent definition:\n");
  for (const resource of agentDefinitionSummary()) {
    io.write(`    ${resource.id} — ${resource.description}\n`);
  }
  io.write("  Skill policy: bundled\n");
  io.write("  Permission mode: read-only\n");
  io.write(`  Protected paths: ${answers.protectedPaths.paths.join(", ") || "none"}\n`);
  io.write("  Workspace files to approve:\n");
  io.write(`    ${paths.workspaceInstructions}\n`);
  io.write(`    ${paths.workspaceMemory}\n`);
  io.write(`  Sandbox allowed read roots: ${answers.sandbox.policy.filesystem.allowedReadRoots.join(", ")}\n`);
  io.write(`  Sandbox allowed write roots: ${answers.sandbox.policy.filesystem.allowedWriteRoots.join(", ")}\n`);
  io.write("  Network: deny\n");
  io.write("  Service: declined\n");
}

async function customizedAnswers(
  io: InteractiveOnboardingIO,
  defaults: ReviewedSetup,
): Promise<ReviewedSetup> {
  const defaultModelId = defaults.model.model;
  const model = (await io.question(`Model id [${defaultModelId}]: `)).trim() || defaultModelId;
  io.write("Bundled resources:\n");
  for (const resource of agentDefinitionSummary()) {
    io.write(`  ${resource.id} — ${resource.description}\n`);
  }
  const acknowledge = await io.question("Acknowledge this exact agent definition? [y/N] ");
  if (!isAffirmativeAnswer(acknowledge)) throw new CliUsageError("agent definition was not acknowledged");
  const permissionRaw = (await io.question("Permission mode [read-only/ask/allow]: ")).trim() || "read-only";
  if (!isPermissionMode(permissionRaw)) throw new CliUsageError("permission mode must be ask, allow, or read-only");
  const workspaceContext = await io.question("Approve workspace AGENTS.md and MEMORY.md? [y/N] ");
  const serviceRaw = (await io.question("Daemon service [declined/installed]: ")).trim() || "declined";
  if (serviceRaw !== "declined" && serviceRaw !== "installed") throw new CliUsageError("service choice must be declined or installed");
  const service = serviceRaw === "declined"
    ? { choice: "declined" as const }
    : {
        choice: "installed" as const,
        executable: resolve((await io.question("Absolute pi-template executable path: ")).trim()),
        workingDirectory: resolve((await io.question("Daemon working directory: ")).trim()),
      };
  return {
    ...defaults,
    model: { provider: defaults.model.provider, model },
    resources: {
      acknowledgedDefinitionIds: definitionIds(AGENT_DEFINITION),
      skillPolicy: { mode: "bundled", allowlist: [] },
      approveWorkspaceContext: isAffirmativeAnswer(workspaceContext),
    },
    capabilities: { permissionMode: permissionRaw as PermissionMode },
    service,
  };
}

async function interactiveAnswers(
  io: InteractiveOnboardingIO,
  source: PiImportSource | undefined,
  home: string | undefined,
  preferDeviceCode: boolean,
): Promise<OnboardingAnswers> {
  const auth = await interactiveAuth(io, source, preferDeviceCode);
  const protectedRaw = (await io.question("Protected paths (comma-separated, blank for none): ")).trim();
  const defaults = reviewDefaults(home, auth, protectedPaths(protectedRaw));
  writeReview(io, defaults, home);
  const acceptance = await io.question("Accept this setup? [Y/n] ");
  if (isDefaultYesAnswer(acceptance)) return defaults;
  if (isNegativeAnswer(acceptance)) return await customizedAnswers(io, defaults);
  throw new CliUsageError("answer y or n to accept this setup");
}

export async function onboard(
  argv: readonly string[],
  dependencies: CliOnboardingDependencies = {},
): Promise<OnboardingResult> {
  const flags = parseFlags(argv);
  const {
    interactiveIO,
    standalonePiAuthPath,
    ...machineDependencies
  } = dependencies;
  if (flags.nonInteractive) return await runOnboarding(answersFromFlags(flags), machineDependencies);

  const rl = interactiveIO ? undefined : readline.createInterface({ input: process.stdin, output: process.stdout });
  const io: InteractiveOnboardingIO = interactiveIO ?? {
    question: async (prompt) => await rl!.question(prompt),
    write: (value) => process.stdout.write(value),
    flushPendingQuestion: () => rl!.write("\n"),
  };
  try {
    const destinationAuthPath = resolve(harnessPaths(machineDependencies.home).piAuth);
    const standaloneSource = piImportSource(standalonePiAuthPath ?? join(getAgentDir(), "auth.json"));
    const source = standaloneSource.authPath === destinationAuthPath ? undefined : standaloneSource;
    const answers = await interactiveAnswers(io, source, machineDependencies.home, flags.noBrowser);
    return await runOnboarding(answers, machineDependencies);
  } finally {
    rl?.close();
  }
}
