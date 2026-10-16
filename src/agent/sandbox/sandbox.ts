import { readFileSync } from "node:fs";
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
  let value: Partial<SandboxPolicy>;
  try {
    value = JSON.parse(raw) as Partial<SandboxPolicy>;
  } catch (error) {
    throw new Error(`sandbox policy is invalid under ${home}`, { cause: error });
  }
  if (!value?.filesystem || !value.process || !value.network) throw new Error(`sandbox policy is invalid under ${home}`);
  return { ...value, enabled: value.enabled !== false } as SandboxPolicy;
}

export const failedSandboxChecks = (): SandboxVerificationChecks => ({
  allowedRootReadPermitted: false,
  canaryReadDenied: false,
  allowedRootWritePermitted: false,
  canaryWriteDenied: false,
  networkDenied: false,
});
