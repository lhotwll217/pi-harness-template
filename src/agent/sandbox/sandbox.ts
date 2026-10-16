import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { harnessPaths } from "@pi-template/contracts";

export interface SandboxFilesystemPolicy {
  allowedReadRoots: string[];
  allowedWriteRoots: string[];
  deniedReadRoots: string[];
  /** Denied even under a write root. The runtime sets the harness control paths; sandbox.json never records it. */
  deniedWriteRoots?: string[];
}

export interface SandboxProcessPolicy {
  allowSubprocesses: boolean;
}

export interface SandboxNetworkPolicy {
  mode: "deny" | "allowlist";
  allowedDomains: string[];
}

export interface SandboxPolicy {
  /** `false` runs bash on the host with the owner's permissions; the other fields are then ignored. */
  enabled: boolean;
  filesystem: SandboxFilesystemPolicy;
  process: SandboxProcessPolicy;
  network: SandboxNetworkPolicy;
}

export interface SandboxProbeFiles {
  allowedFile: string;
  canaryFile: string;
}

export interface SandboxVerificationChecks {
  allowedRootReadPermitted: boolean;
  canaryReadDenied: boolean;
  allowedRootWritePermitted: boolean;
  canaryWriteDenied: boolean;
  networkDenied: boolean;
}

export interface SandboxVerification {
  ok: boolean;
  unavailable: boolean;
  reason: string;
  checks: SandboxVerificationChecks;
}

export interface SandboxedCommandRequest {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  onOutput(data: Buffer): void;
}

export interface SandboxedCommandResult {
  exitCode: number | null;
  timedOut: boolean;
}

export interface SandboxAdapter {
  verify(policy: SandboxPolicy, files?: SandboxProbeFiles): Promise<SandboxVerification>;
  execute(policy: SandboxPolicy, request: SandboxedCommandRequest): Promise<SandboxedCommandResult>;
}

const COMMAND_ENVIRONMENT = new Set([
  "PATH", "SHELL", "TERM", "LANG", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "GIT_SSL_CAINFO", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "GIT_SSH_COMMAND",
]);

/** The variables a bash command sees, sandbox on or off, so the daemon's credentials stay out. */
export const commandEnvironment = (source: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(source ?? {}).filter(([name]) => COMMAND_ENVIRONMENT.has(name) || name.startsWith("LC_")));

export const sandboxPolicyPath = (home: string): string => harnessPaths(home).sandboxPolicy;

/**
 * The home's sandbox policy, or undefined when it records none, which means off. A policy
 * written before `enabled` existed was enforced, so it stays on. An unreadable policy throws.
 */
export function readSandboxPolicy(home: string): SandboxPolicy | undefined {
  let raw: string;
  try {
    raw = readFileSync(sandboxPolicyPath(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw new Error(`sandbox policy is unreadable under ${home}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`sandbox policy is invalid under ${home}`, { cause: error });
  }
  const policy = validPolicy(value);
  if (!policy) throw new Error(`sandbox policy is invalid under ${home}`);
  return policy;
}

function realLocation(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realLocation(parent), basename(path));
  }
}

function homeAndLinksToIt(home: string): string[] {
  const spelled = resolve(home);
  const locations = [spelled, realLocation(spelled)];
  const { root } = parse(spelled);
  let prefix = root;
  for (const part of spelled.slice(root.length).split(sep).filter(Boolean)) {
    prefix = join(prefix, part);
    let link = false;
    try {
      link = lstatSync(prefix).isSymbolicLink();
    } catch {
      break;
    }
    if (link) locations.push(prefix, join(realLocation(dirname(prefix)), basename(prefix)));
  }
  return locations;
}

const containsPath = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export function homeInWriteRootsProblem(home: string, policy: SandboxPolicy): string | undefined {
  if (!policy.enabled) return undefined;
  const locations = homeAndLinksToIt(home);
  const root = policy.filesystem.allowedWriteRoots.find((writeRoot) => {
    const spellings = [resolve(writeRoot), realLocation(resolve(writeRoot))];
    return spellings.some((spelling) => locations.some((location) => containsPath(spelling, location)));
  });
  return root && `sandbox write root ${root} contains the harness home ${home}, ` +
    "so sandboxed bash could rewrite the files that set its own limits. " +
    "Record write roots outside the home: `pi-template onboard --sandbox-write <dir>`, or turn the sandbox off with `--sandbox-off`";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function validPolicy(value: unknown): SandboxPolicy | undefined {
  if (!isRecord(value)) return undefined;
  const { enabled, filesystem, process, network } = value;
  if (enabled !== undefined && typeof enabled !== "boolean") return undefined;
  if (!isRecord(filesystem) || !isRecord(process) || !isRecord(network)) return undefined;
  const { allowedReadRoots, allowedWriteRoots, deniedReadRoots } = filesystem;
  if (!isStrings(allowedReadRoots) || !isStrings(allowedWriteRoots) || !isStrings(deniedReadRoots)) return undefined;
  if (typeof process.allowSubprocesses !== "boolean") return undefined;
  if ((network.mode !== "deny" && network.mode !== "allowlist") || !isStrings(network.allowedDomains)) return undefined;
  return {
    enabled: enabled !== false,
    filesystem: { allowedReadRoots, allowedWriteRoots, deniedReadRoots },
    process: { allowSubprocesses: process.allowSubprocesses },
    network: { mode: network.mode, allowedDomains: network.allowedDomains },
  };
}

export const failedSandboxChecks = (): SandboxVerificationChecks => ({
  allowedRootReadPermitted: false,
  canaryReadDenied: false,
  allowedRootWritePermitted: false,
  canaryWriteDenied: false,
  networkDenied: false,
});
