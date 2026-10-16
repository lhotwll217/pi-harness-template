import readline from "node:readline/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AuthInteraction,
  type AuthPrompt,
  type Credential,
} from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_PERMISSION_MODE,
  harnessPaths,
  isPermissionMode,
  type PermissionMode,
  type SkillPolicy,
} from "@pi-template/contracts";
import {
  AGENT_DEFINITION,
  definitionIds,
  agentDefinitionSummary,
  readStandaloneCredentials,
  recordedAnswers,
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
  sandboxEnabled: boolean | undefined;
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

type CreateModelRuntime = typeof ModelRuntime.create;

export interface CliOnboardingDependencies extends OnboardingDependencies {
  interactiveIO?: InteractiveOnboardingIO;
  standalonePiAuthPath?: string;
  createModelRuntime?: CreateModelRuntime;
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
  let noBrowser = process.env.PI_TEMPLATE_NO_BROWSER === "1";
  let acknowledgeResources = false;
  let approveWorkspaceContext = false;
  let sandboxEnabled: boolean | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--no-browser") { noBrowser = true; continue; }
    if (flag === "--non-interactive") { nonInteractive = true; continue; }
    if (flag === "--acknowledge-resources") { acknowledgeResources = true; continue; }
    if (flag === "--approve-workspace-context") { approveWorkspaceContext = true; continue; }
    if (flag === "--sandbox" || flag === "--sandbox-off") {
      const enabled = flag === "--sandbox";
      if (sandboxEnabled === !enabled) throw new CliUsageError("choose one of --sandbox or --sandbox-off");
      sandboxEnabled = enabled;
      continue;
    }
    if (!VALUES.has(flag) && !REPEATED.has(flag)) throw new CliUsageError(`unknown onboard option: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new CliUsageError(`${flag} needs a value`);
    if (REPEATED.has(flag)) repeated.set(flag, [...(repeated.get(flag) ?? []), value]);
    else if (values.has(flag)) throw new CliUsageError(`${flag} may be provided only once`);
    else values.set(flag, value);
  }
  return { nonInteractive, noBrowser, acknowledgeResources, approveWorkspaceContext, sandboxEnabled, values, repeated };
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

function answersFromFlags(flags: OnboardFlags, recorded: OnboardingAnswers): OnboardingAnswers {
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
  const recordedPolicy = recorded.sandbox?.policy;
  const readRoots = flags.repeated.get("--sandbox-read")?.map((path) => resolve(path)) ??
    recordedPolicy?.filesystem.allowedReadRoots ?? [resolve(process.cwd())];
  const writeRoots = flags.repeated.get("--sandbox-write")?.map((path) => resolve(path)) ??
    recordedPolicy?.filesystem.allowedWriteRoots ?? [resolve(process.cwd())];
  const domains = flags.repeated.get("--network-domain");
  const workspaceSkills = flags.values.get("--workspace-skills");
  const skills = flags.repeated.get("--skill");
  return {
    auth: authFile
      ? importAnswer(piImportSource(authFile))
      : apiKey && provider
        ? { kind: "credential", provider, credential: { type: "api_key", key: apiKey } }
        : undefined,
    model: provider && model ? { provider, model } : undefined,
    resources: flags.acknowledgeResources ? {
      acknowledgedDefinitionIds: definitionIds(AGENT_DEFINITION),
      skillPolicy: workspaceSkills !== undefined || skills !== undefined
        ? skillPolicy(workspaceSkills ?? "bundled", skills ?? [])
        : recorded.resources?.skillPolicy ?? skillPolicy("bundled", []),
      approveWorkspaceContext: flags.approveWorkspaceContext || (recorded.resources?.approveWorkspaceContext ?? false),
    } : undefined,
    capabilities: permission && isPermissionMode(permission) ? { permissionMode: permission } : undefined,
    protectedPaths: {
      paths: flags.repeated.get("--protected-path")?.map((path) => resolve(path)) ?? recorded.protectedPaths?.paths ?? [],
      repos: flags.repeated.get("--protected-repo") ?? recorded.protectedPaths?.repos ?? [],
    },
    sandbox: {
      policy: {
        enabled: flags.sandboxEnabled ?? recordedPolicy?.enabled ?? false,
        filesystem: {
          allowedReadRoots: readRoots,
          allowedWriteRoots: writeRoots,
          deniedReadRoots: recordedPolicy?.filesystem.deniedReadRoots ?? [],
        },
        process: recordedPolicy?.process ?? { allowSubprocesses: true },
        network: domains
          ? { mode: "allowlist", allowedDomains: domains }
          : recordedPolicy?.network ?? { mode: "deny", allowedDomains: [] },
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

function importableProviders(stored: Record<string, unknown>): string[] {
  return Object.keys(stored).filter((provider) => {
    const credential = stored[provider] as Credential | undefined;
    if (credential?.type === "api_key") return Boolean(credential.key?.trim());
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

async function selectAvailableModel(
  runtime: ModelRuntime,
  provider: string,
  preferredModel?: string,
): Promise<string | undefined> {
  const models = await runtime.getAvailable(provider);
  return models.find((model) => model.id === preferredModel)?.id ?? models[0]?.id;
}

/**
 * A runtime over in-memory copies of the given credentials and the model catalog cache, so
 * login, model discovery, and any OAuth refresh never write the harness's or the standalone
 * Pi agent directory.
 */
async function scratchRuntime(
  createRuntime: CreateModelRuntime,
  credentials: Record<string, Credential> = {},
  modelsPath: string | null = null,
): Promise<ModelRuntime> {
  const store = new InMemoryCredentialStore();
  for (const [provider, credential] of Object.entries(credentials)) await store.modify(provider, async () => credential);
  return await createRuntime({ credentials: store, modelsPath, modelsStore: new InMemoryModelsStore() });
}

// Pi labels each provider's browserless method: device code (OpenAI Codex, Radius) or
// Anthropic's "Copy code login (headless)".
const isBrowserlessOption = (option: { id: string; label: string }): boolean =>
  /device|headless/i.test(option.id) || /device|headless/i.test(option.label);

async function loginCredential(
  io: InteractiveOnboardingIO,
  runtime: ModelRuntime,
  providerId: string,
  preferDeviceCode: boolean,
): Promise<Credential> {
  const select = async (prompt: Extract<AuthPrompt, { type: "select" }>): Promise<string> => {
    if (preferDeviceCode) {
      const browserlessOption = prompt.options.find(isBrowserlessOption);
      if (browserlessOption) {
        io.write(`${prompt.message}\n  → ${browserlessOption.label} (--no-browser)\n`);
        return browserlessOption.id;
      }
    }
    io.write(`${prompt.message}\n`);
    prompt.options.forEach((option, index) => io.write(`  ${index + 1}. ${option.label}\n`));
    const answer = (await io.question("Selection: ")).trim();
    const numeric = /^\d+$/.test(answer) ? Number(answer) : undefined;
    const selected = numeric === undefined ? prompt.options.find(({ id }) => id === answer)?.id : prompt.options[numeric - 1]?.id;
    if (!selected) throw new Error("login method selection cancelled");
    return selected;
  };
  const interaction: AuthInteraction = {
    async prompt(prompt) {
      if (prompt.type === "select") return await select(prompt);
      if (prompt.type === "manual_code") {
        const onAbort = () => io.flushPendingQuestion?.();
        prompt.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const answer = await io.question(`${prompt.message} `);
          prompt.signal?.throwIfAborted();
          return answer;
        } finally {
          prompt.signal?.removeEventListener("abort", onAbort);
        }
      }
      const answer = await io.question(`${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `);
      if (!answer.trim()) throw new Error(`${prompt.message} is required`);
      return answer;
    },
    notify(event) {
      if (event.type === "auth_url") {
        io.write(`Open ${event.url}\n`);
        if (event.instructions) io.write(`${event.instructions}\n`);
      } else if (event.type === "device_code") {
        io.write(`Open ${event.verificationUri} and enter code ${event.userCode}\n`);
      } else {
        io.write(`${event.message}\n`);
      }
    },
  };
  return await runtime.login(providerId, "oauth", interaction);
}

async function freshAuthentication(
  io: InteractiveOnboardingIO,
  preferDeviceCode: boolean,
  createRuntime: CreateModelRuntime,
): Promise<InteractiveAuthSelection> {
  const runtime = await scratchRuntime(createRuntime);
  const providers = runtime.getProviders().flatMap(({ id, auth }) => auth.oauth ? [{ id, name: auth.oauth.name }] : []);
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
    const credential: Credential = { type: "api_key", key: apiKey };
    const model = await selectAvailableModel(await scratchRuntime(createRuntime, { [provider]: credential }), provider) ??
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
    const credential = await loginCredential(io, runtime, selected.id, preferDeviceCode);
    const model = await selectAvailableModel(runtime, selected.id);
    if (!model) throw new Error(`no authenticated model is available for provider ${selected.id}`);
    return {
      answer: { kind: "credential", provider: selected.id, credential },
      provider: selected.id,
      model,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.write(`\nLogin did not complete: ${message.split("\n")[0]}\nChoose again, or press Ctrl-C to exit.\n`);
    return await freshAuthentication(io, preferDeviceCode, createRuntime);
  }
}

async function interactiveAuth(
  io: InteractiveOnboardingIO,
  source: PiImportSource | undefined,
  preferDeviceCode: boolean,
  createRuntime: CreateModelRuntime,
): Promise<InteractiveAuthSelection> {
  if (source && existsSync(source.agentDir)) {
    const importChoice = await io.question(`Copy existing standalone Pi setup from ${source.agentDir}? [Y/n] `);
    if (isDefaultYesAnswer(importChoice)) {
      if (!existsSync(source.authPath)) throw new CliUsageError("the standalone Pi setup has no authorization file to import");
      const stored = readStandaloneCredentials(source.authPath);
      const providers = importableProviders(stored);
      if (providers.length === 0) throw new CliUsageError("the standalone Pi setup has no usable authorizations to import");
      const importedSelection = importedModelSelection(source);
      const provider = importedProvider(providers, importedSelection?.provider);
      const model = await selectAvailableModel(
        await scratchRuntime(
          createRuntime,
          { [provider]: stored[provider] as Credential },
          existsSync(source.modelsPath) ? source.modelsPath : null,
        ),
        provider,
        importedSelection?.provider === provider ? importedSelection.model : undefined,
      );
      if (!model) throw new CliUsageError("the standalone Pi setup has no model default for the imported provider");
      return { answer: importAnswer(source), provider, model };
    }
    if (!isNegativeAnswer(importChoice)) throw new CliUsageError("answer y or n to the standalone Pi import offer");
  }
  return await freshAuthentication(io, preferDeviceCode, createRuntime);
}

function protectedPaths(raw: string): string[] {
  return raw.split(",").map((path) => path.trim()).filter(Boolean).map((path) => resolve(path));
}

function reviewDefaults(
  auth: InteractiveAuthSelection,
  protectedPathValues: string[],
  recorded: OnboardingAnswers,
  sandboxEnabled: boolean | undefined,
): ReviewedSetup {
  const root = resolve(process.cwd());
  const policy = recorded.sandbox?.policy ?? {
    enabled: false,
    filesystem: { allowedReadRoots: [root], allowedWriteRoots: [root], deniedReadRoots: [] },
    process: { allowSubprocesses: true },
    network: { mode: "deny", allowedDomains: [] },
  };
  return {
    auth: auth.answer,
    model: { provider: auth.provider, model: auth.model },
    resources: {
      acknowledgedDefinitionIds: definitionIds(AGENT_DEFINITION),
      skillPolicy: recorded.resources?.skillPolicy ?? { mode: "bundled", allowlist: [] },
      approveWorkspaceContext: recorded.resources?.approveWorkspaceContext ?? true,
    },
    capabilities: recorded.capabilities ?? { permissionMode: DEFAULT_PERMISSION_MODE },
    protectedPaths: { paths: protectedPathValues, repos: recorded.protectedPaths?.repos ?? [] },
    sandbox: { policy: { ...policy, enabled: sandboxEnabled ?? policy.enabled } },
    service: recorded.service ?? { choice: "declined" },
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
  const { skillPolicy } = answers.resources;
  io.write(`  Skill policy: ${skillPolicy.mode}${skillPolicy.allowlist.length ? ` (${skillPolicy.allowlist.join(", ")})` : ""}\n`);
  io.write(`  Permission mode: ${answers.capabilities.permissionMode}\n`);
  io.write(`  Protected paths: ${answers.protectedPaths.paths.join(", ") || "none"}\n`);
  io.write("  Workspace files to approve:\n");
  io.write(`    ${paths.workspaceInstructions}\n`);
  io.write(`    ${paths.workspaceMemory}\n`);
  const { policy } = answers.sandbox;
  io.write(policy.enabled
    ? "  Sandbox: on\n"
    : "  Sandbox: off, bash runs with your permissions (rerun onboarding with --sandbox to turn it on)\n");
  io.write(`  Sandbox allowed read roots: ${policy.filesystem.allowedReadRoots.join(", ")}\n`);
  io.write(`  Sandbox allowed write roots: ${policy.filesystem.allowedWriteRoots.join(", ")}\n`);
  io.write(`  Network: ${policy.network.mode}${policy.network.allowedDomains.length ? ` (${policy.network.allowedDomains.join(", ")})` : ""}\n`);
  io.write(`  Service: ${answers.service.choice}\n`);
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
  const permissionRaw = (await io.question("Permission mode [allow/ask/read-only]: ")).trim() ||
    defaults.capabilities.permissionMode;
  if (!isPermissionMode(permissionRaw)) throw new CliUsageError("permission mode must be ask, allow, or read-only");
  const workspaceContext = await io.question("Approve workspace AGENTS.md and MEMORY.md? [y/N] ");
  const serviceRaw = (await io.question("Daemon service [declined/installed]: ")).trim() || defaults.service.choice;
  if (serviceRaw !== "declined" && serviceRaw !== "installed") throw new CliUsageError("service choice must be declined or installed");
  const keepsInstall = defaults.service.choice === "installed";
  const executableRaw = serviceRaw === "installed"
    ? (await io.question(`Absolute pi-template executable path${keepsInstall ? " (blank keeps the installed service)" : ""}: `)).trim()
    : "";
  const service = serviceRaw === "declined"
    ? { choice: "declined" as const }
    : keepsInstall && !executableRaw
    ? { choice: "installed" as const }
    : {
        choice: "installed" as const,
        executable: resolve(executableRaw),
        workingDirectory: resolve((await io.question("Daemon working directory: ")).trim()),
      };
  return {
    ...defaults,
    model: { provider: defaults.model.provider, model },
    resources: {
      acknowledgedDefinitionIds: definitionIds(AGENT_DEFINITION),
      skillPolicy: defaults.resources.skillPolicy,
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
  createRuntime: CreateModelRuntime,
  recorded: OnboardingAnswers,
  sandboxEnabled: boolean | undefined,
): Promise<OnboardingAnswers> {
  const auth = await interactiveAuth(io, source, preferDeviceCode, createRuntime);
  const recordedPaths = recorded.protectedPaths?.paths;
  const protectedRaw = (await io.question(recordedPaths
    ? `Protected paths (comma-separated, none to clear) [${recordedPaths.join(", ") || "none"}]: `
    : "Protected paths (comma-separated, blank for none): ")).trim();
  const protectedPathValues = recordedPaths && !protectedRaw
    ? recordedPaths
    : protectedRaw.toLowerCase() === "none" ? [] : protectedPaths(protectedRaw);
  const defaults = reviewDefaults(auth, protectedPathValues, recorded, sandboxEnabled);
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
    createModelRuntime = (options) => ModelRuntime.create(options),
    ...machineDependencies
  } = dependencies;
  const recorded = recordedAnswers(machineDependencies.home);
  if (flags.nonInteractive) return await runOnboarding(answersFromFlags(flags, recorded), machineDependencies);

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
    const answers = await interactiveAnswers(
      io, source, machineDependencies.home, flags.noBrowser, createModelRuntime, recorded, flags.sandboxEnabled,
    );
    return await runOnboarding(answers, machineDependencies);
  } finally {
    rl?.close();
  }
}
