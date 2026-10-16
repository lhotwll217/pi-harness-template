import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { harnessPaths } from "@pi-template/contracts";
import { createSandboxAdapter, type SandboxAdapter } from "../agent/sandbox";
import { passingOnboardingDependencies } from "../../test/helpers/onboarding";
import { toolResultFromTurn } from "../../test/helpers/tool-turn";
import { onboard } from "./onboard";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-template-legacy-sandbox-")));
const home = join(root, "home");
const task = join(root, "task");
const secretDir = join(root, "secret");
const faux = registerFauxProvider();

try {
  const model = faux.getModel();
  const standaloneDir = join(root, "standalone-pi");
  mkdirSync(standaloneDir);
  writeFileSync(join(standaloneDir, "auth.json"), JSON.stringify({ [model.provider]: { type: "api_key", key: "faux-key" } }));
  writeFileSync(join(standaloneDir, "settings.json"), JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id }));
  writeFileSync(join(standaloneDir, "models.json"), JSON.stringify({ providers: {
    [model.provider]: { api: model.api, baseUrl: "http://127.0.0.1:1", apiKey: "faux-key", models: [model] },
  } }));
  assert.equal((await onboard([
    "--non-interactive", "--auth-file", join(standaloneDir, "auth.json"), "--acknowledge-resources", "--service", "declined",
  ], passingOnboardingDependencies(home))).complete, true);

  mkdirSync(task);
  mkdirSync(secretDir);
  const canary = join(secretDir, "canary.txt");
  writeFileSync(canary, "canary\n");
  const paths = harnessPaths(home);
  const legacyPolicy = {
    filesystem: { allowedReadRoots: [task], allowedWriteRoots: [task], deniedReadRoots: [secretDir, paths.piAgentDir] },
    process: { allowSubprocesses: true },
    network: { mode: "deny", allowedDomains: [] },
  };

  const real = createSandboxAdapter();
  const probe = await real.verify({ ...legacyPolicy, enabled: true, network: { mode: "deny", allowedDomains: [] } });
  const sandboxedCommands: string[] = [];
  const recording: SandboxAdapter = {
    verify: (policy, files) => real.verify(policy, files),
    async execute(policy, request) {
      sandboxedCommands.push(request.command);
      return probe.unavailable ? { exitCode: 1, timedOut: false } : await real.execute(policy, request);
    },
  };
  const session = { home, cwd: task, sandbox: recording };
  const command = `cat ${canary}`;

  writeFileSync(paths.sandboxPolicy, JSON.stringify(legacyPolicy));
  const legacyOutput = await toolResultFromTurn(faux, session, "bash", { command });
  assert.deepEqual(sandboxedCommands, [command], "a sandbox.json without enabled runs bash through the sandbox");
  if (probe.unavailable) {
    process.stdout.write(`SKIP — real sandbox unavailable for the legacy read check: ${probe.reason}\n`);
  } else {
    assert.equal(legacyOutput, `cat: ${canary}: Operation not permitted\n\n\nCommand exited with code 1`);
  }

  writeFileSync(paths.sandboxPolicy, JSON.stringify({ ...legacyPolicy, enabled: false }));
  assert.equal(await toolResultFromTurn(faux, session, "bash", { command }), "canary\n");
  assert.deepEqual(sandboxedCommands, [command], "enabled false runs bash on the host");

  process.stdout.write("ok — a sandbox.json written before enabled existed still runs bash sandboxed; enabled false runs it on the host\n");
} finally {
  faux.unregister();
  rmSync(root, { recursive: true, force: true });
}
