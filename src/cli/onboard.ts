import readline from "node:readline/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getOAuthProvider, getOAuthProviderInfoList, type OAuthSelectPrompt } from "@earendil-works/pi-ai/oauth";
import { AuthStorage, getAgentDir } from "@earendil-works/pi-coding-agent";
import { harnessPaths, isPermissionMode, type PermissionMode, type SkillPolicy } from "@pi-template/contracts";
import {
  AGENT_RESOURCE_CATALOG,
  catalogIds,
  resourceCatalogSummary,
  runOnboarding,
  type OnboardingAnswers,
  type OnboardingDependencies,
  type OnboardingResult,
} from "../agent";
import { CliUsageError } from "./args";

interface OnboardFlags {
  nonInteractive: boolean;
  acknowledgeResources: boolean;
  approveWorkspaceContext: boolean;
  values: Map<string, string>;
  repeated: Map<string, string[]>;
}

export interface InteractiveOnboardingIO {
  question(prompt: string): Promise<string>;
  write(value: string): void;
}

export interface CliOnboardingDependencies extends OnboardingDependencies {
  interactiveIO?: InteractiveOnboardingIO;
  standalonePiAuthPath?: string;
  ownerOperatorAuthPath?: string;
}

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
  let acknowledgeResources = false;
  let approveWorkspaceContext = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
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
  return { nonInteractive, acknowledgeResources, approveWorkspaceContext, values, repeated };
}

function skillPolicy(mode: string, allowlist: string[]): SkillPolicy {
  if (mode === "bundled") return { mode: "bundled", allowlist: [] };
  if (mode === "all") return { mode: "all-workspace", allowlist: [] };
  if (mode === "allowlist" && allowlist.length > 0) return { mode: "allowlist", allowlist };
  throw new CliUsageError("--workspace-skills must be bundled, all, or allowlist with at least one --skill");
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
      ? { kind: "import", sourceAuthPath: resolve(authFile) }
      : apiKey && provider
        ? { kind: "credential", provider, credential: { type: "api_key", key: apiKey } }
        : undefined,
    model: provider && model ? { provider, model } : undefined,
    resources: flags.acknowledgeResources ? {
      acknowledgedCatalogIds: catalogIds(AGENT_RESOURCE_CATALOG),
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

async function importedProvider(providers: readonly string[], io: InteractiveOnboardingIO): Promise<string> {
  if (providers.length === 1) return providers[0];
  const provider = (await io.question(`Provider id for model (${providers.join(", ")}): `)).trim();
  if (!providers.includes(provider)) throw new CliUsageError("select a provider present in the imported authorizations");
  return provider;
}

async function interactiveAuth(
  io: InteractiveOnboardingIO,
  sourceAuthPaths: readonly string[],
): Promise<{ answer: NonNullable<OnboardingAnswers["auth"]>; provider: string }> {
  for (const sourceAuthPath of [...new Set(sourceAuthPaths.map((path) => resolve(path)))]) {
    if (!existsSync(sourceAuthPath)) continue;
    const providers = importableProviders(sourceAuthPath);
    if (providers.length === 0) continue;
    if (isAffirmativeAnswer(await io.question(`Copy existing Pi authorizations from ${sourceAuthPath}? [y/N] `))) {
      return {
        answer: { kind: "import", sourceAuthPath },
        provider: await importedProvider(providers, io),
      };
    }
  }

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
    return { answer: { kind: "credential", provider, credential: { type: "api_key", key: apiKey } }, provider };
  }
  const selected = numericChoice === undefined
    ? providers.find(({ id }) => id === rawChoice)
    : providers[numericChoice - 1];
  if (!selected) throw new CliUsageError("select a listed provider or enter an API key manually");
  return { answer: { kind: "login", provider: selected.id }, provider: selected.id };
}

async function interactiveAnswers(
  io: InteractiveOnboardingIO,
  sourceAuthPaths: readonly string[],
): Promise<OnboardingAnswers> {
  const auth = await interactiveAuth(io, sourceAuthPaths);
  const model = (await io.question("Model id: ")).trim();
  io.write("Bundled resources:\n");
  for (const resource of resourceCatalogSummary()) {
    io.write(`  ${resource.id} — ${resource.description}\n`);
  }
  const acknowledge = await io.question("Acknowledge this exact resource catalog? [y/N] ");
  if (!isAffirmativeAnswer(acknowledge)) throw new CliUsageError("resource catalog was not acknowledged");
  const permissionRaw = (await io.question("Permission mode [read-only/ask/allow]: ")).trim() || "read-only";
  if (!isPermissionMode(permissionRaw)) throw new CliUsageError("permission mode must be ask, allow, or read-only");
  const protectedRaw = (await io.question("Protected paths (comma-separated, blank for none): ")).trim();
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
    auth: auth.answer,
    model: { provider: auth.provider, model },
    resources: {
      acknowledgedCatalogIds: catalogIds(AGENT_RESOURCE_CATALOG),
      skillPolicy: { mode: "bundled", allowlist: [] },
      approveWorkspaceContext: isAffirmativeAnswer(workspaceContext),
    },
    capabilities: { permissionMode: permissionRaw as PermissionMode },
    protectedPaths: {
      paths: protectedRaw.split(",").map((path) => path.trim()).filter(Boolean).map((path) => resolve(path)),
      repos: [],
    },
    sandbox: {
      policy: {
        filesystem: { allowedReadRoots: [resolve(process.cwd())], allowedWriteRoots: [resolve(process.cwd())], deniedReadRoots: [] },
        process: { allowSubprocesses: true },
        network: { mode: "deny", allowedDomains: [] },
      },
    },
    service,
  };
}

function providerLogin(io: InteractiveOnboardingIO): NonNullable<OnboardingDependencies["providerLogin"]> {
  return async (paths, providerId) => {
    const provider = getOAuthProvider(providerId);
    if (!provider) throw new Error(`unknown OAuth provider: ${providerId}`);
    const select = async (prompt: OAuthSelectPrompt): Promise<string | undefined> => {
      io.write(`${prompt.message}\n`);
      prompt.options.forEach((option, index) => io.write(`  ${index + 1}. ${option.label}\n`));
      const answer = (await io.question("Selection: ")).trim();
      if (!answer) return undefined;
      const numeric = /^\d+$/.test(answer) ? Number(answer) : undefined;
      return numeric === undefined ? prompt.options.find(({ id }) => id === answer)?.id : prompt.options[numeric - 1]?.id;
    };
    const credentials = await provider.login({
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
      onManualCodeInput: async () => await io.question("Paste the redirect URL: "),
      onSelect: select,
    });
    AuthStorage.create(paths.piAuth).set(providerId, { type: "oauth", ...credentials });
  };
}

export async function onboard(
  argv: readonly string[],
  dependencies: CliOnboardingDependencies = {},
): Promise<OnboardingResult> {
  const flags = parseFlags(argv);
  const {
    interactiveIO,
    standalonePiAuthPath,
    ownerOperatorAuthPath,
    ...machineDependencies
  } = dependencies;
  if (flags.nonInteractive) return await runOnboarding(answersFromFlags(flags), machineDependencies);

  const rl = interactiveIO ? undefined : readline.createInterface({ input: process.stdin, output: process.stdout });
  const io: InteractiveOnboardingIO = interactiveIO ?? {
    question: async (prompt) => await rl!.question(prompt),
    write: (value) => process.stdout.write(value),
  };
  try {
    const destinationAuthPath = resolve(harnessPaths(machineDependencies.home).piAuth);
    const sourceAuthPaths = [
      standalonePiAuthPath ?? join(getAgentDir(), "auth.json"),
      ownerOperatorAuthPath ?? join(homedir(), ".owner-operator", "pi", "auth.json"),
    ].filter((path) => resolve(path) !== destinationAuthPath);
    const answers = await interactiveAnswers(io, sourceAuthPaths);
    return await runOnboarding(answers, {
      ...machineDependencies,
      providerLogin: machineDependencies.providerLogin ?? providerLogin(io),
    });
  } finally {
    rl?.close();
  }
}
