import readline from "node:readline/promises";
import { resolve } from "node:path";
import { isPermissionMode, type PermissionMode, type SkillPolicy } from "@pi-template/contracts";
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

async function interactiveAnswers(): Promise<OnboardingAnswers> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("Bundled resources:\n");
    for (const resource of resourceCatalogSummary()) {
      process.stdout.write(`  ${resource.id} — ${resource.description}\n`);
    }
    const provider = (await rl.question("Provider id: ")).trim();
    const apiKey = (await rl.question("Provider API key: ")).trim();
    const model = (await rl.question("Model id: ")).trim();
    const acknowledge = (await rl.question("Acknowledge this exact resource catalog? [y/N] ")).trim().toLowerCase();
    if (acknowledge !== "y" && acknowledge !== "yes") throw new CliUsageError("resource catalog was not acknowledged");
    const permissionRaw = (await rl.question("Permission mode [read-only/ask/allow]: ")).trim() || "read-only";
    if (!isPermissionMode(permissionRaw)) throw new CliUsageError("permission mode must be ask, allow, or read-only");
    const protectedRaw = (await rl.question("Protected paths (comma-separated, blank for none): ")).trim();
    const workspaceContext = (await rl.question("Approve workspace AGENTS.md and MEMORY.md? [y/N] ")).trim().toLowerCase();
    const serviceRaw = (await rl.question("Daemon service [declined/installed]: ")).trim() || "declined";
    if (serviceRaw !== "declined" && serviceRaw !== "installed") throw new CliUsageError("service choice must be declined or installed");
    const service = serviceRaw === "declined"
      ? { choice: "declined" as const }
      : {
          choice: "installed" as const,
          executable: resolve((await rl.question("Absolute pi-template executable path: ")).trim()),
          workingDirectory: resolve((await rl.question("Daemon working directory: ")).trim()),
        };
    return {
      auth: { kind: "credential", provider, credential: { type: "api_key", key: apiKey } },
      model: { provider, model },
      resources: {
        acknowledgedCatalogIds: catalogIds(AGENT_RESOURCE_CATALOG),
        skillPolicy: { mode: "bundled", allowlist: [] },
        approveWorkspaceContext: workspaceContext === "y" || workspaceContext === "yes",
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
  } finally {
    rl.close();
  }
}

export async function onboard(
  argv: readonly string[],
  dependencies: OnboardingDependencies = {},
): Promise<OnboardingResult> {
  const flags = parseFlags(argv);
  const answers = flags.nonInteractive ? answersFromFlags(flags) : await interactiveAnswers();
  return await runOnboarding(answers, dependencies);
}
