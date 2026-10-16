import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  ScheduleKind,
  ScheduledPayloadKind,
  harnessPaths,
  type ScheduledPromptRunRequest,
} from "@pi-template/contracts";
import { createScheduledPromptRunner } from "../agent/prompt-runner";
import { passingOnboardingDependencies } from "../../test/helpers/onboarding";
import { toolResultFromTurn } from "../../test/helpers/tool-turn";
import { createInteractiveSessionRuntime } from "./interactive";
import { onboard } from "./onboard";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-template-damaged-protected-paths-")));
const home = join(root, "home");
const secretDir = join(root, "secret");
const faux = registerFauxProvider();
const unused = async (): Promise<never> => { throw new Error("not used"); };
const gateway = { queryDatabase: unused, createNote: unused };
const resources = { query: { listTables: unused, describeTable: unused, runQuery: unused }, notes: { createNote: unused } };

try {
  const model = faux.getModel();
  const standaloneDir = join(root, "standalone-pi");
  mkdirSync(standaloneDir);
  mkdirSync(secretDir);
  writeFileSync(join(standaloneDir, "auth.json"), JSON.stringify({ [model.provider]: { type: "api_key", key: "faux-key" } }));
  writeFileSync(join(standaloneDir, "settings.json"), JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id }));
  writeFileSync(join(standaloneDir, "models.json"), JSON.stringify({ providers: {
    [model.provider]: { api: model.api, baseUrl: "http://127.0.0.1:1", apiKey: "faux-key", models: [model] },
  } }));
  assert.equal((await onboard([
    "--non-interactive", "--auth-file", join(standaloneDir, "auth.json"), "--acknowledge-resources", "--service", "declined",
    "--protected-path", secretDir,
  ], passingOnboardingDependencies(home))).complete, true);

  const paths = harnessPaths(home);
  const secret = join(secretDir, "secret.txt");
  writeFileSync(secret, "secret\n");
  const session = { home, cwd: paths.workspace };
  assert.match(await toolResultFromTurn(faux, session, "read", { path: secret }), /Denied by policy: 'path_read'.*Pi Template protected paths/);

  writeFileSync(paths.protectedPaths, `{ "paths": ["${secretDir}"], }`);
  const permissionBytes = readFileSync(paths.piPermissionConfig, "utf8");
  const refusal = `protected paths are not valid JSON at ${paths.protectedPaths}; the agent will not start without the owner's protected paths. ` +
    "Fix the file, or record them again with `pi-template onboard` (non-interactive: `pi-template onboard --non-interactive --protected-path <dir>`)";

  await assert.rejects(toolResultFromTurn(faux, session, "read", { path: secret }), { message: refusal });
  await assert.rejects(createInteractiveSessionRuntime({ ...session, gateway, model }), { message: refusal });
  const prompt = { kind: ScheduledPayloadKind.Prompt, prompt: `Read ${secret}`, toolsAllow: [] } as const;
  const scheduled: ScheduledPromptRunRequest = {
    payload: prompt,
    cwd: paths.workspace,
    schedule: {
      id: "schedule-1",
      name: "read the secret",
      enabled: true,
      trigger: { kind: ScheduleKind.Every, everyMs: 60_000, anchorMs: 0 },
      payload: prompt,
      cwd: paths.workspace,
      timeoutSeconds: 30,
      revision: 1,
      createdAt: "2026-10-16T12:00:00.000Z",
      updatedAt: "2026-10-16T12:00:00.000Z",
      nextRunAt: null,
    },
    runId: "run-1",
    signal: new AbortController().signal,
  };
  await assert.rejects(createScheduledPromptRunner({ home, resources })(scheduled), { message: refusal });
  assert.equal(readFileSync(paths.piPermissionConfig, "utf8"), permissionBytes, "no refused session rewrites the permission rules");

  unlinkSync(paths.protectedPaths);
  assert.equal(await toolResultFromTurn(faux, session, "read", { path: secret }), "secret\n", "a missing file protects nothing");

  process.stdout.write("ok — a damaged protected_paths.json stops interactive, prompt, and scheduled sessions; a missing one protects nothing\n");
} finally {
  faux.unregister();
  rmSync(root, { recursive: true, force: true });
}
