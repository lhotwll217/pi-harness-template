import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import {
  failedSandboxChecks,
  type SandboxAdapter,
  type SandboxPolicy,
  type SandboxProbeFiles,
  type SandboxedCommandRequest,
  type SandboxedCommandResult,
  type SandboxVerification,
  type SandboxVerificationChecks,
} from "./sandbox";

const PROBE_TIMEOUT_MS = 5_000;
let executionQueue: Promise<void> = Promise.resolve();

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

function unavailable(reason: unknown): SandboxVerification {
  return {
    ok: false,
    unavailable: true,
    reason: reason instanceof Error ? reason.message : String(reason),
    checks: failedSandboxChecks(),
  };
}

async function listenForProbe(): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate sandbox probe port");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function executeProbe(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

function runtimeConfig(policy: SandboxPolicy, extraDeniedReads: string[] = []): SandboxRuntimeConfig {
  return {
    network: {
      allowedDomains: policy.network.mode === "deny" ? [] : policy.network.allowedDomains,
      deniedDomains: policy.network.mode === "deny" ? ["*"] : [],
      strictAllowlist: true,
    },
    filesystem: {
      denyRead: [...new Set([...policy.filesystem.deniedReadRoots, ...extraDeniedReads])],
      allowRead: policy.filesystem.allowedReadRoots,
      allowWrite: policy.filesystem.allowedWriteRoots,
      denyWrite: [...new Set([...policy.filesystem.deniedReadRoots, ...extraDeniedReads])],
    },
  };
}

async function serialized<T>(work: () => Promise<T>): Promise<T> {
  const previous = executionQueue;
  let release!: () => void;
  executionQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

async function spawnSandboxed(
  argv: string[],
  env: NodeJS.ProcessEnv,
  request: SandboxedCommandRequest,
): Promise<SandboxedCommandResult> {
  const safeEnvironment = (source: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv => {
    const allowed = new Set([
      "PATH", "SHELL", "TERM", "LANG", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP",
      "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "GIT_SSL_CAINFO", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
      "GIT_SSH_COMMAND",
    ]);
    return Object.fromEntries(Object.entries(source ?? {}).filter(([name]) => allowed.has(name) || name.startsWith("LC_")));
  };
  const proxyNames = new Set([
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  ]);
  const sandboxProxyEnvironment = Object.fromEntries(
    Object.entries(env).filter(([name]) => proxyNames.has(name)),
  );
  const outputSecrets = Object.entries(sandboxProxyEnvironment).flatMap(([, value]) => {
    if (!value) return [];
    try {
      const url = new URL(value);
      return [value, url.username, url.password].filter(Boolean).map(decodeURIComponent);
    } catch {
      return [value];
    }
  }).sort((left, right) => right.length - left.length);
  const redactOutput = (output: string): Buffer => {
    let text = output;
    for (const secret of outputSecrets) text = text.replaceAll(secret, "[redacted-sandbox-proxy]");
    return Buffer.from(text);
  };
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: request.cwd,
      env: {
        ...safeEnvironment(process.env),
        ...safeEnvironment(request.env),
        ...safeEnvironment(env),
        ...sandboxProxyEnvironment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timeout: NodeJS.Timeout | undefined;
    let output = "";
    const abort = (): void => { child.kill("SIGTERM"); };
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (timeout) clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
      if (output) request.onOutput(redactOutput(output));
      resolve({ exitCode });
    });
    if (request.timeoutMs) timeout = setTimeout(abort, request.timeoutMs);
    if (request.signal?.aborted) abort();
    else request.signal?.addEventListener("abort", abort, { once: true });
  });
}

class AnthropicSandboxAdapter implements SandboxAdapter {
  async verify(policy: SandboxPolicy, suppliedFiles?: SandboxProbeFiles): Promise<SandboxVerification> {
    let ownedDir: string | undefined;
    let listener: Awaited<ReturnType<typeof listenForProbe>> | undefined;
    try {
      if (!policy.process.allowSubprocesses) {
        return { ok: false, unavailable: false, reason: "sandbox probe requires a subprocess", checks: failedSandboxChecks() };
      }
      if (!SandboxManager.isSupportedPlatform()) return unavailable(`unsupported platform: ${process.platform}`);
      const dependencies = SandboxManager.checkDependencies();
      if (dependencies.errors.length) return unavailable(dependencies.errors.join("; "));
      ownedDir = suppliedFiles ? undefined : mkdtempSync(join(tmpdir(), "pi-template-sandbox-adapter-"));
      const files = suppliedFiles ?? {
        allowedFile: join(ownedDir!, "allowed", "readable.txt"),
        canaryFile: join(ownedDir!, "outside-canary.txt"),
      };
      mkdirSync(dirname(files.allowedFile), { recursive: true });
      if (!suppliedFiles) {
        writeFileSync(files.allowedFile, "allowed\n");
        writeFileSync(files.canaryFile, "canary\n");
      }
      const scriptPath = join(dirname(files.allowedFile), "sandbox-probe.mjs");
      writeFileSync(scriptPath, [
      'import { readFileSync } from "node:fs";',
      'import { connect } from "node:net";',
      'const [allowedFile, canaryFile, portText] = process.argv.slice(2);',
      'let allowedRootReadPermitted = false;',
      'let canaryReadDenied = false;',
      'try { readFileSync(allowedFile, "utf8"); allowedRootReadPermitted = true; } catch {}',
      'try { readFileSync(canaryFile, "utf8"); } catch { canaryReadDenied = true; }',
      'const networkDenied = await new Promise((resolve) => {',
      '  const socket = connect({ host: "127.0.0.1", port: Number(portText) });',
      '  socket.once("connect", () => { socket.destroy(); resolve(false); });',
      '  socket.once("error", () => resolve(true));',
      '  socket.setTimeout(1200, () => { socket.destroy(); resolve(true); });',
      '});',
      'process.stdout.write(JSON.stringify({ allowedRootReadPermitted, canaryReadDenied, networkDenied }));',
      ].join("\n"));
      listener = await listenForProbe();
      const config = runtimeConfig({
        ...policy,
        filesystem: {
          ...policy.filesystem,
          allowedReadRoots: [...new Set([...policy.filesystem.allowedReadRoots, dirname(files.allowedFile)])],
        },
      }, [files.canaryFile]);
      await SandboxManager.initialize(config, undefined, false);
      const command = [process.execPath, scriptPath, files.allowedFile, files.canaryFile, String(listener.port)]
        .map(shellQuote)
        .join(" ");
      const wrapped = await SandboxManager.wrapWithSandboxArgv(command, undefined, undefined, undefined, dirname(files.allowedFile));
      const child = await executeProbe(wrapped.argv, { ...process.env, ...wrapped.env }, dirname(files.allowedFile));
      let checks: SandboxVerificationChecks;
      try {
        checks = JSON.parse(child.stdout) as SandboxVerificationChecks;
      } catch {
        return unavailable(`sandboxed probe did not run (exit ${child.code}): ${child.stderr.trim() || "no output"}`);
      }
      const ok = checks.allowedRootReadPermitted && checks.canaryReadDenied && checks.networkDenied;
      return {
        ok,
        unavailable: false,
        reason: ok ? "sandbox verification passed" : "sandbox enforcement probe did not deny every forbidden operation",
        checks,
      };
    } catch (error) {
      return unavailable(error);
    } finally {
      await listener?.close().catch(() => undefined);
      await SandboxManager.reset().catch(() => undefined);
      if (ownedDir) rmSync(ownedDir, { recursive: true, force: true });
    }
  }

  async execute(policy: SandboxPolicy, request: SandboxedCommandRequest): Promise<SandboxedCommandResult> {
    return await serialized(async () => {
      if (!policy.process.allowSubprocesses) throw new Error("sandbox policy denies subprocess execution");
      if (!SandboxManager.isSupportedPlatform()) throw new Error(`sandbox unavailable on ${process.platform}`);
      const dependencies = SandboxManager.checkDependencies();
      if (dependencies.errors.length) throw new Error(`sandbox unavailable: ${dependencies.errors.join("; ")}`);
      try {
        await SandboxManager.initialize(runtimeConfig(policy), undefined, false);
        const wrapped = await SandboxManager.wrapWithSandboxArgv(
          request.command,
          undefined,
          undefined,
          request.signal,
          request.cwd,
        );
        return await spawnSandboxed(wrapped.argv, wrapped.env, request);
      } finally {
        SandboxManager.cleanupAfterCommand();
        await SandboxManager.reset().catch(() => undefined);
      }
    });
  }
}

export const createSandboxAdapter = (): SandboxAdapter => new AnthropicSandboxAdapter();
