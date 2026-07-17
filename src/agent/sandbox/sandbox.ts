export interface SandboxFilesystemPolicy {
  allowedReadRoots: string[];
  allowedWriteRoots: string[];
  deniedReadRoots: string[];
}

export interface SandboxProcessPolicy {
  allowSubprocesses: boolean;
}

export interface SandboxNetworkPolicy {
  mode: "deny" | "allowlist";
  allowedDomains: string[];
}

export interface SandboxPolicy {
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
}

export interface SandboxAdapter {
  verify(policy: SandboxPolicy, files?: SandboxProbeFiles): Promise<SandboxVerification>;
  execute(policy: SandboxPolicy, request: SandboxedCommandRequest): Promise<SandboxedCommandResult>;
}

export const failedSandboxChecks = (): SandboxVerificationChecks => ({
  allowedRootReadPermitted: false,
  canaryReadDenied: false,
  allowedRootWritePermitted: false,
  canaryWriteDenied: false,
  networkDenied: false,
});
