import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultWritePaths } from "@anthropic-ai/sandbox-runtime";
import { AGENT_CALLER_VARIABLE, harnessPaths } from "@pi-template/contracts";

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
  /** Unix sockets bash may connect to (macOS). The runtime sets the agent socket; sandbox.json never records it. */
  allowedUnixSockets?: string[];
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

export const SANDBOXED_COMMAND_TERMINATION_GRACE_MS = 1_000;

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

export const AGENT_CLI_VARIABLES: readonly string[] = Object.freeze(["PI_TEMPLATE_HOME", AGENT_CALLER_VARIABLE]);

/** The variables a bash command sees, sandbox on or off, so the daemon's credentials stay out. */
export const commandEnvironment = (source: NodeJS.ProcessEnv | undefined, also: readonly string[] = []): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(source ?? {}).filter(([name]) =>
    COMMAND_ENVIRONMENT.has(name) || name.startsWith("LC_") || also.includes(name)));

export const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function agentCommandEnvironment(source: NodeJS.ProcessEnv | undefined, home: string): NodeJS.ProcessEnv {
  const path = [checkoutRoot, dirname(process.execPath), ...(source?.PATH ?? "").split(delimiter)].filter(Boolean);
  return {
    ...commandEnvironment(source),
    PATH: [...new Set(path)].join(delimiter),
    PI_TEMPLATE_HOME: home,
    [AGENT_CALLER_VARIABLE]: "1",
  };
}

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

type FileIdentity = string;

function fileIdentity(path: string): FileIdentity | undefined {
  try {
    const { dev, ino } = statSync(path, { bigint: true });
    return `${dev}:${ino}`;
  } catch {
    return undefined;
  }
}

function ancestry(path: string): string[] {
  const paths = [path];
  while (dirname(paths.at(-1)!) !== paths.at(-1)) paths.push(dirname(paths.at(-1)!));
  return paths;
}

/** The nearest existing directory on a path's spelling, and the components beneath it that do not exist yet. */
function existingPart(path: string): { existing: string; missing: string[] } {
  let existing = resolve(path);
  const missing: string[] = [];
  while (!fileIdentity(existing) && dirname(existing) !== existing) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  return { existing, missing };
}

interface HomeLocation {
  /** Every directory the home lies in, as spelled, by real path, and through each symlink on its spelling. */
  ancestors: Set<FileIdentity>;
  existing: string;
  missing: string[];
}

function homeLocation(home: string): HomeLocation {
  const { existing, missing } = existingPart(home);
  const ancestors = new Set<FileIdentity>();
  for (const spelled of ancestry(existing)) {
    let real = spelled;
    try {
      real = realpathSync.native(spelled);
    } catch {}
    for (const path of ancestry(real)) {
      const identity = fileIdentity(path);
      if (identity) ancestors.add(identity);
    }
  }
  return { ancestors, existing, missing };
}

// APFS compares names case- and normalization-insensitively; folding both is the conservative reading.
const foldName = (name: string): string => name.normalize("NFC").toLowerCase();

function containsHome(root: string, home: HomeLocation): boolean {
  const { existing, missing } = existingPart(root);
  const identity = fileIdentity(existing);
  if (!identity) return false;
  if (!missing.length) return home.ancestors.has(identity);
  // A root that does not exist yet can hold only a home that does not exist yet, beneath the same directory.
  return identity === fileIdentity(home.existing) &&
    missing.length <= home.missing.length &&
    missing.every((name, index) => foldName(name) === foldName(home.missing[index]!));
}

const WRITE_ROOT_RECOVERY = "`pi-template onboard --sandbox-write <dir>`, or turn the sandbox off with `--sandbox-off`";

/** The symlink on a path's spelling whose target does not exist, if any; nothing beneath it can exist. */
function brokenSymlink(path: string): string | undefined {
  const { existing, missing } = existingPart(path);
  if (!missing.length) return undefined;
  const first = join(existing, missing[0]!);
  try {
    return lstatSync(first).isSymbolicLink() ? first : undefined;
  } catch {
    return undefined;
  }
}

function writeRootSpellingProblem(root: string): string | undefined {
  if (/[*?[\]]/.test(root)) return "has glob characters";
  if (root.startsWith("~")) return "starts with ~";
  if (!isAbsolute(root)) return "is not an absolute path";
  const link = brokenSymlink(root);
  return link && `passes through the broken symlink ${link}`;
}

/**
 * Why sandboxed bash, under this policy, could write somewhere inside the harness home, or
 * undefined when it cannot. Containment is decided by file identity, so letter case, Unicode
 * form, firmlinks, and symlinks cannot hide the home; roots the sandbox library would expand
 * (globs, ~, relative paths) and roots through a broken symlink, which has no identity to compare,
 * are refused outright, and the library's built-in write paths count as roots.
 */
export function homeInWriteRootsProblem(home: string, policy: SandboxPolicy): string | undefined {
  if (!policy.enabled) return undefined;
  for (const root of policy.filesystem.allowedWriteRoots) {
    const spelling = writeRootSpellingProblem(root);
    if (spelling) {
      return `sandbox write root ${root} ${spelling}, so the sandbox would not read it the way the harness checks it. ` +
        `Record plain absolute write roots outside the home: ${WRITE_ROOT_RECOVERY}`;
    }
  }
  const location = homeLocation(home);
  const root = policy.filesystem.allowedWriteRoots.find((writeRoot) => containsHome(writeRoot, location));
  if (root) {
    return `sandbox write root ${root} contains the harness home ${home}, ` +
      `so sandboxed bash could rewrite the files that set its own limits. Record write roots outside the home: ${WRITE_ROOT_RECOVERY}`;
  }
  const builtIn = getDefaultWritePaths().find((writeRoot) => containsHome(writeRoot, location));
  return builtIn && `the sandbox always lets bash write ${builtIn}, which contains the harness home ${home}, ` +
    `so sandboxed bash could rewrite the files that set its own limits. ` +
    `Move the harness home out of ${builtIn}, or turn the sandbox off with \`--sandbox-off\``;
}

const FIRMLINK_VOLUME = "/System/Volumes/Data";

/**
 * A path as the macOS kernel reports it to the sandbox: real, in on-disk case and Unicode form,
 * and without the /System/Volumes/Data firmlink prefix, which realpath keeps but the kernel drops.
 */
export function kernelPath(path: string): string {
  const real = realpathSync.native(path);
  if (!real.startsWith(`${FIRMLINK_VOLUME}/`)) return real;
  const unprefixed = real.slice(FIRMLINK_VOLUME.length);
  return fileIdentity(unprefixed) === fileIdentity(real) ? unprefixed : real;
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
